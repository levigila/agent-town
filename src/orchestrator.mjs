// Orquestrador real: chama as APIs e emite os mesmos eventos que o simulador.
//
// Arquitetura em três camadas:
//
//   1. PLANEJAMENTO — o Planner recebe o objetivo e devolve um grafo de tarefas
//      (JSON validado em src/graph.mjs). Se falhar duas vezes, cai no pipeline
//      fixo. A ferramenta nunca quebra por causa do Planner.
//
//   2. EXECUÇÃO — o grafo é ordenado em ondas (src/graph.mjs). Cada onda roda
//      em paralelo; o semáforo do provedor respeita o limite de concorrência.
//      O resultado de uma tarefa alimenta as tarefas que dependem dela.
//
//   3. ISOLAMENTO — em modo projeto, tudo acontece numa branch git própria
//      (src/git.mjs). Nunca push. Diff sempre disponível para revisão.
//
// O frontend não muda entre modo simulado e real.

import { createProvidersForRoles } from './providers/index.mjs';
import { createTools, TOOL_DEFS } from './tools.mjs';
import { seedWorkspace, runsDir } from './workspace.mjs';
import { loadPricing, costOf } from './pricing.mjs';
import { planTask, fallbackPlan, PLANNER_SYSTEM } from './planner.mjs';
import { topoWaves } from './graph.mjs';
import {
  prepareWorkBranch,
  cleanupBranch,
  changedFiles,
  diffStat,
  diffText,
  commitFiles,
} from './git.mjs';
import { resolveProjectPath, assertDirectory, loadProjectConfig, projectContext } from './project.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let seq = 0;
const nextId = () => `r${(++seq).toString(36).padStart(4, '0')}`;

const AGENT_IDS = ['planner', 'researcher', 'coder', 'reviewer'];

const READ_ONLY = ['list_files', 'read_file'];
const ALL_TOOLS = ['list_files', 'read_file', 'write_file', 'run_tests'];

const PROMPTS = {
  researcher: `Voce e o Researcher do time.
Sua tarefa e investigar o projeto com as ferramentas e resumir o que o Coder
precisa saber: onde o codigo relevante esta, quais convencoes seguir, quais
casos de borda existem.
Use list_files e read_file. NAO escreva codigo.
Responda em portugues, em no maximo 10 linhas, direto ao ponto.`,

  coder: `Voce e o Coder do time.
Implemente exatamente o que a instrucao pede, usando as ferramentas.
Regras:
- Leia o arquivo antes de reescrever.
- Envie o conteudo COMPLETO do arquivo em write_file (nunca diff ou trecho).
- Rode run_tests antes de dizer que terminou.
- Se os testes falharem, corrija e rode de novo. Nao pare com teste vermelho.
Responda em portugues, curto, dizendo o que mudou.`,

  reviewer: `Voce e o Reviewer do time.
Verifique o trabalho: leia os arquivos alterados e rode os testes.
Aponte problemas concretos com arquivo e linha quando houver.
Termine sua resposta com uma linha EXATAMENTE neste formato:
VEREDITO: APROVADO
ou
VEREDITO: REPROVADO`,
};

const MAX_DEP_CONTEXT = 4000;

class BudgetExceeded extends Error {}
class Aborted extends Error {}

export class Orchestrator {
  constructor(emit, config, options = {}) {
    this.emitRaw = emit;
    this.config = config;
    this.providerFactory = options.providerFactory || createProvidersForRoles;
    this.running = false;
    this.speed = 1;
    this.runId = null;
    this.controller = null;
    this.totals = { in: 0, out: 0, cost: 0 };
    this.perAgent = {};
    this.pricing = loadPricing(ROOT);
    this.limiters = {};
    this.error = null;
    this.plan = null;
    this.project = null;
  }

  getState() {
    return {
      running: this.running,
      speed: this.speed,
      runId: this.runId,
      mode: 'real',
      totals: { ...this.totals },
      perAgent: JSON.parse(JSON.stringify(this.perAgent)),
      limiters: Object.fromEntries(Object.entries(this.limiters).map(([k, l]) => [k, l.stats()])),
      error: this.error,
      plan: this.plan,
      project: this.project,
    };
  }

  setSpeed(speed) {
    const n = Number(speed);
    this.speed = Number.isFinite(n) ? Math.min(8, Math.max(0.5, n)) : 1;
    return this.getState();
  }

  stop() {
    if (!this.running) return this.getState();
    this.running = false;
    this.controller?.abort();
    return this.getState();
  }

  /**
   * @param {object} options
   * @param {string} [options.task] objetivo escrito pelo usuário
   * @param {'template'|'project'} [options.mode]
   * @param {string} [options.projectPath]
   * @param {string} [options.template]
   */
  start(options = {}) {
    if (this.running) return this.getState();

    this.running = true;
    this.error = null;
    this.plan = null;
    this.project = null;
    this.runId = `run_${Date.now().toString(36)}`;
    this.totals = { in: 0, out: 0, cost: 0 };
    this.perAgent = {};
    this.controller = new AbortController();

    this.request = {
      task: String(options.task || '').trim(),
      mode: options.mode === 'project' ? 'project' : 'template',
      projectPath: options.projectPath || '',
      template: options.template || 'price-parser',
    };

    const timeoutMs = this.config.limits.timeoutSec * 1000;
    this.timeoutHandle = setTimeout(() => {
      this.controller?.abort(new Error('timeout da execucao'));
    }, timeoutMs);

    this._run().catch((err) => {
      if (err instanceof Aborted) return;
      this.error = err.message;
      this.running = false;
      this._emit('run_finished', null, { reason: 'error', error: err.message, total: { ...this.totals } });
    });

    return this.getState();
  }

  // -- emissão ---------------------------------------------------------------

  _emit(type, agentId = null, payload = {}) {
    this.emitRaw({ id: nextId(), ts: Date.now(), type, agentId, runId: this.runId, ...payload });
  }

  _usage(agentId, model, usage) {
    const cost = costOf(this.pricing, model, usage);
    const acc = (this.perAgent[agentId] ||= { model, in: 0, out: 0, cost: 0 });
    acc.model = model;
    acc.in += usage.in || 0;
    acc.out += usage.out || 0;
    acc.cost += cost;

    this.totals.in += usage.in || 0;
    this.totals.out += usage.out || 0;
    this.totals.cost += cost;

    this._emit('token_usage', agentId, {
      model,
      in: usage.in || 0,
      out: usage.out || 0,
      cost: Number(cost.toFixed(6)),
    });
  }

  _guardBudget() {
    const { budgetUsd, maxTokens } = this.config.limits;
    const usedTokens = this.totals.in + this.totals.out;
    if (budgetUsd > 0 && this.totals.cost >= budgetUsd) {
      throw new BudgetExceeded(`teto de gasto atingido (US$ ${this.totals.cost.toFixed(4)})`);
    }
    if (maxTokens > 0 && usedTokens >= maxTokens) {
      throw new BudgetExceeded(`teto de tokens atingido (${usedTokens})`);
    }
  }

  _checkAbort() {
    if (!this.running || this.controller?.signal.aborted) throw new Aborted('execucao interrompida');
  }

  // -- execução --------------------------------------------------------------

  async _run() {
    const { byRole, limiters } = this.providerFactory(this.config);
    this.limiters = limiters;

    const runId = this.runId;
    const mode = this.request.mode;

    this._emit('run_started', null, {
      label: mode === 'project' ? 'Projeto real' : 'Execucao real',
      cycle: 1,
      mode,
    });
    for (const id of AGENT_IDS) this._emit('agent_spawned', id, { cycle: 1 });

    // --- preparação do ambiente ---------------------------------------------
    const env = mode === 'project' ? await this._prepareProject(runId) : await this._prepareTemplate(runId);

    if (!env.ok) {
      this._emit('agent_error', null, { text: env.error });
      this._emit('run_finished', null, { reason: 'setup_failed', error: env.error, total: { ...this.totals } });
      this.running = false;
      return;
    }

    this._tools = env.tools;
    this._env = env;

    try {
      await this._execute(byRole, env);
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        this._emit('run_finished', null, { reason: 'budget', error: err.message, total: { ...this.totals } });
      } else if (err instanceof Aborted) {
        this._emit('run_finished', null, { reason: 'stopped', total: { ...this.totals } });
      } else {
        throw err;
      }
    } finally {
      await this._finalize(env);
      clearTimeout(this.timeoutHandle);
      this.running = false;
    }
  }

  // -- preparação: template --------------------------------------------------

  async _prepareTemplate(runId) {
    const { workspace, tmpDir } = await seedWorkspace(runId, this.request.template);

    let spec = '';
    try {
      spec = await readFile(path.join(workspace, 'SPEC.md'), 'utf8');
    } catch {
      /* template sem SPEC */
    }

    const tools = createTools(workspace, tmpDir);

    return {
      ok: true,
      kind: 'template',
      workspace,
      tmpDir,
      tools,
      context: spec ? `Especificacao do projeto:\n${spec}` : '(projeto vazio)',
      task: this.request.task || (spec ? 'Implemente o que a especificacao pede.' : 'Implemente a tarefa.'),
    };
  }

  // -- preparação: projeto real ---------------------------------------------

  async _prepareProject(runId) {
    const allowed = this.config.projectRoots || [];
    const resolved = resolveProjectPath(this.request.projectPath, allowed, {
      allowAny: this.config.allowAnyPath === true,
    });

    if (!resolved.ok) return { ok: false, error: resolved.error };

    const dirCheck = await assertDirectory(resolved.path);
    if (!dirCheck.ok) return { ok: false, error: dirCheck.error };

    const runDir = path.join(runsDir(), runId);
    const tmpDir = path.join(runDir, '.tmp');
    await mkdir(tmpDir, { recursive: true });

    const branchInfo = await prepareWorkBranch(resolved.path, runId, tmpDir);
    if (!branchInfo.ok) return { ok: false, error: branchInfo.error };

    const projectConfig = await loadProjectConfig(resolved.path);
    const tree = await projectContext(resolved.path);

    const tools = createTools(resolved.path, tmpDir, {
      testCommand: projectConfig.testCommand,
      ignore: projectConfig.ignore,
    });

    this.project = {
      path: resolved.path,
      branch: branchInfo.branch,
      originalBranch: branchInfo.originalBranch,
      baseline: branchInfo.baseline || [],
      configSource: projectConfig.source,
      testCommand: projectConfig.testCommand ? projectConfig.testCommand.join(' ') : null,
    };

    this._emit('agent_message', 'planner', {
      to: 'researcher',
      text: `Projeto: ${path.basename(resolved.path)} · branch ${branchInfo.branch}`,
    });

    const context = [
      `Arvore do projeto (${tree.fileCount} itens${tree.truncated ? ', truncada' : ''}):`,
      tree.tree,
      projectConfig.testCommand
        ? `\nComando de teste: ${projectConfig.testCommand.join(' ')}`
        : '\nComando de teste: suite padrao do Node (test/)',
    ].join('\n');

    if (!this.request.task) {
      return { ok: false, error: 'modo projeto exige uma tarefa: descreva o que deve ser feito' };
    }

    return {
      ok: true,
      kind: 'project',
      workspace: resolved.path,
      tmpDir,
      tools,
      context,
      task: this.request.task,
    };
  }

  // -- execução do plano -----------------------------------------------------

  async _execute(byRole, env) {
    // --- 1. planejamento ----------------------------------------------------
    this._emit('agent_thinking', 'planner', { text: 'decompondo o objetivo em tarefas' });

    const plan = await planTask({
      provider: byRole.planner,
      task: env.task,
      context: env.context,
      maxTasks: this.config.limits.maxTasks,
      signal: this.controller?.signal,
      onNote: (msg) => this._emit('agent_thinking', 'planner', { text: msg }),
    });

    if (plan.usage) this._usage('planner', byRole.planner.model, plan.usage);

    let tasks;
    let waves;
    let fellBack = false;

    if (plan.ok) {
      tasks = plan.tasks;
      waves = plan.waves;
      this._emit('agent_thinking', 'planner', {
        text: `plano com ${tasks.length} tarefas em ${waves.length} onda(s)`,
      });
    } else {
      fellBack = true;
      const fallback = fallbackPlan();
      const ordered = topoWaves(fallback);
      tasks = fallback.map((t) => ({ ...t }));
      waves = ordered.waves;
      this._emit('agent_error', 'planner', {
        text: `plano invalido apos ${plan.attempts} tentativa(s): ${plan.problems[0] || 'formato'}`,
      });
      this._emit('agent_thinking', 'planner', { text: 'usando pipeline padrao como fallback' });
    }

    this.plan = { tasks, waves: waves.length, fellBack, attempts: plan.attempts };

    this._emit('plan_created', 'planner', {
      tasks,
      waveCount: waves.length,
      fellBack,
      attempts: plan.attempts,
    });

    this._emit('agent_done', 'planner', {
      summary: fellBack ? 'fallback: pipeline padrao' : `${tasks.length} tarefas planejadas`,
    });

    // --- 2. execução em ondas ----------------------------------------------
    const results = {};
    let reviewerVerdict = null;

    for (let w = 0; w < waves.length; w++) {
      this._checkAbort();
      const wave = waves[w];

      this._emit('run_started', null, { label: `Onda ${w + 1}/${waves.length}`, cycle: w + 1, silent: true });

      await Promise.all(
        wave.map(async (task) => {
          this._checkAbort();

          // dependência que falhou bloqueia a tarefa
          const blocked = task.dependsOn.filter((d) => results[d] && results[d].ok === false);
          if (blocked.length) {
            results[task.id] = { ok: false, blocked: true, text: 'bloqueada por dependencia' };
            this._emit('agent_error', task.agent, {
              text: `tarefa ${task.id} bloqueada por: ${blocked.join(', ')}`,
            });
            return;
          }

          const provider = byRole[task.agent];
          if (!provider) {
            results[task.id] = { ok: false, text: `sem provedor para ${task.agent}` };
            this._emit('agent_error', task.agent, { text: `sem provedor para ${task.agent}` });
            return;
          }

          this._handoff('planner', task.agent, task.instruction, task.id);

          const context = task.dependsOn
            .map((d) => (results[d] ? `[${d}]\n${results[d].text}` : ''))
            .filter(Boolean)
            .join('\n\n')
            .slice(0, MAX_DEP_CONTEXT);

          const prompt = [
            `Objetivo geral:\n${env.task}`,
            `\nSua tarefa (${task.id}):\n${task.instruction}`,
            context ? `\nResultado das tarefas anteriores:\n${context}` : '',
            `\nContexto do projeto:\n${env.context}`,
          ]
            .filter(Boolean)
            .join('\n');

          const toolNames = task.agent === 'researcher' ? READ_ONLY : ALL_TOOLS;

          try {
            const out = await this._agent({
              roleId: task.agent,
              provider,
              system: PROMPTS[task.agent],
              task: prompt,
              toolNames,
              maxSteps: this.config.limits.maxSteps,
            });

            results[task.id] = { ...out, ok: task.agent === 'reviewer' ? !/VEREDITO:\s*REPROVADO/i.test(out.text || '') : out.testsPassed !== false };

            if (task.agent === 'reviewer') {
              reviewerVerdict = results[task.id].ok ? 'aprovado' : 'reprovado';
            }

            this._emit('agent_done', task.agent, {
              summary: this._summaryFor(task, out),
              taskId: task.id,
            });
          } catch (err) {
            if (err instanceof Aborted || err instanceof BudgetExceeded) throw err;
            results[task.id] = { ok: false, text: err.message };
            this._emit('agent_error', task.agent, { text: `${task.id}: ${err.message}` });
          }
        }),
      );
    }

    // --- 3. encerramento ----------------------------------------------------
    const failed = Object.entries(results).filter(([, r]) => !r.ok);

    this._emit('run_finished', null, {
      reason: failed.length ? 'parcial' : 'completed',
      cycle: waves.length,
      total: { ...this.totals },
      tasks: tasks.length,
      failed: failed.map(([id]) => id),
      verdict: reviewerVerdict,
      fellBack,
    });
  }

  _summaryFor(task, out) {
    if (task.agent === 'reviewer') {
      return /VEREDITO:\s*APROVADO/i.test(out.text || '') ? 'aprovado' : 'revisado';
    }
    if (task.agent === 'coder') {
      return out.testsPassed ? 'implementado, testes passando' : 'implementado';
    }
    return 'concluido';
  }

  // -- finalização -----------------------------------------------------------

  async _finalize(env) {
    if (!env || env.kind !== 'project') return;

    try {
      const base = this.project.originalBranch;
      const baseline = this.project.baseline || [];
      const files = await changedFiles(env.workspace, env.tmpDir, baseline);
      const stat = await diffStat(env.workspace, env.tmpDir, base);

      if (!files.length) {
        this._emit('agent_thinking', 'reviewer', { text: 'nenhum arquivo alterado' });
        await cleanupBranch(env.workspace, this.project.branch, this.project.originalBranch, env.tmpDir);
        return;
      }

      // Diff ANTES do commit: depois de commitar, comparar com HEAD daria vazio.
      const diff = await diffText(env.workspace, env.tmpDir, { base });

      const commit = await commitFiles(
        env.workspace,
        files,
        `agent-town: ${this.request.task.slice(0, 60)}\n\nrun: ${this.runId}`,
        env.tmpDir,
      );

      this._emit('diff_ready', null, {
        branch: this.project.branch,
        originalBranch: this.project.originalBranch,
        files,
        stat,
        diff: diff.text,
        truncated: diff.truncated,
        committed: commit.ok,
      });

      if (this.project) {
        this.project.changed = files.length;
        this.project.committed = commit.ok;
      }
    } catch (err) {
      this._emit('agent_error', null, { text: `falha ao gerar diff: ${err.message}` });
    }
  }

  _handoff(from, to, text, taskId = null) {
    this._emit('agent_message', from, { to, text, taskId });
  }

  // -- loop de agente com tool calling --------------------------------------

  /**
   * @returns {Promise<{text: string, steps: number, testsPassed: boolean}>}
   */
  async _agent({ roleId, provider, system, task, toolNames, maxSteps }) {
    if (!provider) throw new Error(`sem provedor para o papel ${roleId}`);

    const tools = TOOL_DEFS.filter((t) => toolNames.includes(t.name));
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];

    this._emit('agent_thinking', roleId, { text: 'analisando a tarefa' });

    let testsPassed = false;
    let sawTestResult = false;
    let lastText = '';
    let steps = 0;

    while (steps < maxSteps) {
      this._checkAbort();
      this._guardBudget();
      steps += 1;

      const res = await provider.limiter.run(() =>
        provider.chat({
          messages,
          tools,
          temperature: 0.2,
          maxTokens: 2048,
          signal: this.controller?.signal,
          onRetry: (msg) => this._emit('agent_thinking', roleId, { text: msg }),
        }),
      );

      this._usage(roleId, provider.model, res.usage);

      if (res.text) {
        lastText = res.text;
        this._emit('agent_thinking', roleId, { text: res.text.slice(0, 220) });
      }

      if (!res.toolCalls?.length) break;

      messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        this._checkAbort();

        this._emit('tool_call', roleId, { tool: call.name, args: this._shortArgs(call.args) });

        let outcome;
        try {
          outcome = await this._tools.execute(call.name, call.args);
        } catch (err) {
          outcome = { ok: false, summary: err.message, output: '' };
        }

        if (call.name === 'run_tests') {
          sawTestResult = true;
          testsPassed = outcome.ok;
        }

        this._emit('tool_result', roleId, {
          tool: call.name,
          ok: outcome.ok,
          summary: outcome.summary,
        });

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: outcome.output || outcome.summary,
        });
      }
    }

    if (steps >= maxSteps) {
      this._emit('agent_thinking', roleId, { text: `limite de ${maxSteps} passos atingido` });
    }

    return { text: lastText, steps, testsPassed: sawTestResult ? testsPassed : true };
  }

  _shortArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const p = args.path || args.file || args.arquivo;
    if (p) return String(p);
    if (args.content) return `${String(args.content).length} bytes`;
    return Object.keys(args).join(', ');
  }
}
