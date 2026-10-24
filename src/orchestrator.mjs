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
import { createTools, TOOL_DEFS, createWriteGuard } from './tools.mjs';
import { seedWorkspace, runsDir } from './workspace.mjs';
import { loadPricing, costOf } from './pricing.mjs';
import { planTask, fallbackPlan, PLANNER_SYSTEM } from './planner.mjs';
import { topoWaves } from './graph.mjs';
import { executorIds, parseModelRef, buildAgentInstances } from './config.mjs';
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
- Leia apenas os arquivos que vai ALTERAR (no maximo 3). Nao releia: o que
  ja apareceu na conversa continua valendo.
- Envie o conteudo COMPLETO do arquivo em write_file (nunca diff ou trecho).
- Escreva o codigo ANTES de gastar passos explorando.
- Rode run_tests antes de dizer que terminou. Se nao houver testes no projeto,
  diga isso claramente em vez de afirmar que passou.
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
    this.rateLimit = null;
    this._scopeSeq = 0;
    // Compartilhada por todas as instancias: impede que dois agentes
    // sobrescrevam o mesmo arquivo sem perceber.
    this._writeGuard = createWriteGuard();
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
      rateLimit: this.rateLimit || null,
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
    if (type === 'rate_limit') this.rateLimit = payload;
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

  /** Tokens que ainda cabem no teto (null quando nao ha teto). */
  _tokensLeft() {
    const max = this.config.limits.maxTokens;
    if (!max || max <= 0) return null;
    return Math.max(0, max - (this.totals.in + this.totals.out));
  }

  /**
   * Ponto a partir do qual o agente e avisado para entregar.
   * 80% do teto: sobra folga para escrever os arquivos e rodar testes.
   */
  _softBudgetLimit() {
    const max = this.config.limits.maxTokens;
    if (!max || max <= 0) return 0;
    return Math.round(max * 0.2);
  }

  _checkAbort() {
    if (!this.running || this.controller?.signal.aborted) throw new Aborted('execucao interrompida');
  }

  /**
   * Garante que exista a lista de instâncias.
   *
   * Configurações antigas (e testes) montam só `roles`. Nesse caso derivamos
   * uma instância por papel — o comportamento clássico, sem paralelismo extra.
   */
  _ensureAgents() {
    if (Array.isArray(this.config.agents) && this.config.agents.length) return;

    const perRole = this.config.limits?.agentsPerRole || 1;
    this.config.agents = buildAgentInstances(this.config.roles || {}, perRole);
  }

  /**
   * Adiciona agentes do OpenCode à execução.
   *
   * Eles vêm no corpo do /api/run como `extraAgents` — já convertidos por
   * src/opencode.mjs (id, prompt, toolNames, modelRef). O Planner passa a
   * vê-los como opção, e o escalonador os trata como qualquer instância.
   */
  _registerExtraAgents() {
    this._ensureAgents();

    const extras = Array.isArray(this.request.extraAgents) ? this.request.extraAgents : [];
    if (!extras.length) return;

    const fallbackModel = this.config.roles?.coder?.modelRef || this.config.roles?.planner?.modelRef;

    for (const extra of extras) {
      if (!extra?.id || !extra?.prompt) continue;
      if ((this.config.agents || []).some((a) => a.id === extra.id)) continue;

      this.config.agents.push({
        id: extra.id,
        role: extra.id, // papel próprio: não herda provider interno
        name: extra.name || extra.id,
        roleName: extra.mode === 'primary' ? 'OpenCode' : 'OpenCode (subagente)',
        index: 0,
        prompt: extra.prompt,
        toolNames: Array.isArray(extra.toolNames) ? extra.toolNames : null,
        modelRef: parseModelRef(extra.model || '') || fallbackModel,
        source: 'opencode',
      });
    }
  }

  // -- execução --------------------------------------------------------------

  async _run() {
    // Agentes extras (OpenCode) entram como instâncias antes de montar os
    // provedores, para já terem modelRef e semáforo resolvidos.
    this._registerExtraAgents();

    const { byRole, byInstance, limiters } = this.providerFactory(this.config);
    this.limiters = limiters;
    this._byRole = byRole;
    this._byInstance = byInstance || byRole;

    const runId = this.runId;
    const mode = this.request.mode;

    this._emit('run_started', null, {
      label: mode === 'project' ? 'Projeto real' : 'Execucao real',
      cycle: 1,
      mode,
    });

    // Uma instância por agente: planner, researcher-1/2, coder-1/2, reviewer-1/2.
    const agentIds = (this.config.agents || []).map((a) => a.id);
    for (const id of agentIds.length ? agentIds : AGENT_IDS) this._emit('agent_spawned', id, { cycle: 1 });

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
        // Diz QUEM gastou: sem isso o usuario nao sabe se o problema e o
        // modelo lendo demais, tarefas demais, ou uma tarefa grande demais.
        const ranked = Object.entries(this.perAgent)
          .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
          .slice(0, 3)
          .map(([id, u]) => `${id} (${((u.in + u.out) / 1000).toFixed(0)}k)`)
          .join(', ');

        const hint =
          'Os agentes gastaram o teto antes de concluir. Aumente MAX_TOKENS, ' +
          'reduza MAX_TASKS, ou quebre a tarefa em pedacos menores.' +
          (ranked ? ` Maiores gastos: ${ranked}.` : '');

        this._emit('agent_error', null, { text: `${err.message}. ${hint}` });
        this._emit('run_finished', null, {
          reason: 'budget',
          error: err.message,
          hint,
          total: { ...this.totals },
          spent: ranked,
        });
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

    const tools = createTools(workspace, tmpDir, { writeGuard: this._writeGuard });

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

    // Avisa quando voltamos para a branch principal: sem isso o usuario acha
    // que perdeu o trabalho anterior (ele está na branch, só não está ativa).
    if (branchInfo.note) {
      this._emit('agent_thinking', 'planner', { text: branchInfo.note });
    }

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
      agents: this.config.agents,
      allowedAgents: executorIds(this.config.agents || []),
      signal: this.controller?.signal,
      onNote: (msg) => this._emit('agent_thinking', 'planner', { text: msg }),
      onRateLimit: (info) => this._emit('rate_limit', null, info),
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

    // Instâncias ocupadas nesta onda. As tarefas do plano podem pedir uma
    // instância específica ("coder-1") ou só o papel ("coder") — neste caso
    // o escalonador escolhe quem estiver livre.
    const busy = new Set();

    for (let w = 0; w < waves.length; w++) {
      this._checkAbort();
      const wave = waves[w];

      this._emit('run_started', null, { label: `Onda ${w + 1}/${waves.length}`, cycle: w + 1, silent: true });

      // Resolve cada tarefa para uma instância concreta ANTES de rodar, para
      // que duas tarefas genéricas ("coder") não caiam no mesmo agente.
      const assignments = wave.map((task) => ({ task, agentId: this._assign(task, busy) }));

      // Agrupa por instância: instâncias diferentes rodam em paralelo;
      // tarefas da mesma instância rodam em série (uma conversa por vez).
      const byAgent = new Map();
      for (const item of assignments) {
        if (!byAgent.has(item.agentId)) byAgent.set(item.agentId, []);
        byAgent.get(item.agentId).push(item);
      }

      await Promise.all(
        [...byAgent.entries()].map(async ([agentId, items]) => {
          for (const { task } of items) {
            await this._runTask({ task, agentId, results, env });
          }
        }),
      );

      // libera as instâncias para a próxima onda
      for (const item of assignments) busy.delete(item.agentId);

      if (results.__verdict) reviewerVerdict = results.__verdict;
    }

    // --- 3. encerramento ----------------------------------------------------
    const done = Object.entries(results).filter(([id]) => !id.startsWith('__'));
    const failed = done.filter(([, r]) => !r.ok);
    const unverified = done
      .filter(([, r]) => r.ok && r.testsPassed === null && typeof r.testsPassed !== 'undefined')
      .map(([id]) => id);

    this._emit('run_finished', null, {
      reason: failed.length ? 'parcial' : 'completed',
      cycle: waves.length,
      total: { ...this.totals },
      tasks: tasks.length,
      failed: failed.map(([id]) => id),
      unverified,
      verdict: reviewerVerdict,
      fellBack,
    });
  }

  /**
   * Escolhe a instância que vai executar a tarefa.
   *
   * Em ordem:
   *   1. A tarefa pediu uma instância específica ("coder-2") -> usa ela.
   *   2. Pediu o papel ("coder") -> pega a instância do papel que está livre.
   *   3. Todas ocupadas -> usa a primeira; o agrupamento posterior serializa.
   */
  _assign(task, busy) {
    const instances = (this.config.agents || []).filter((a) => a.id !== 'planner');

    const exact = instances.find((a) => a.id === task.agent);
    if (exact) {
      busy.add(exact.id);
      return exact.id;
    }

    const sameRole = instances.filter((a) => a.role === task.agent);
    const chosen = sameRole.find((a) => !busy.has(a.id)) || sameRole[0];

    if (!chosen) return task.agent; // papel desconhecido: deixa o erro aparecer
    busy.add(chosen.id);
    return chosen.id;
  }

  /** Roda uma tarefa com a instância indicada. */
  async _runTask({ task, agentId, results, env }) {
    const agent = (this.config.agents || []).find((a) => a.id === agentId);
    const role = agent?.role || task.agent;

    this._checkAbort();

    // dependência que falhou bloqueia a tarefa
    const blocked = task.dependsOn.filter((d) => results[d] && results[d].ok === false);
    if (blocked.length) {
      results[task.id] = { ok: false, blocked: true, text: 'bloqueada por dependencia' };
      this._emit('agent_error', agentId, {
        text: `tarefa ${task.id} bloqueada por: ${blocked.join(', ')}`,
      });
      return;
    }

    // Provider da instância; se ela não tiver um próprio (ou vier de uma
    // configuração antiga), cai no provider do papel.
    const provider = this._byInstance?.[agentId] || this._byRole?.[role];
    if (!provider) {
      results[task.id] = { ok: false, text: `sem provedor para ${agentId}` };
      this._emit('agent_error', agentId, { text: `sem provedor para ${agentId}` });
      return;
    }

    this._handoff('planner', agentId, task.instruction, task.id);

    const context = task.dependsOn
      .map((d) => (results[d] ? `[${d}]\n${results[d].text}` : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, MAX_DEP_CONTEXT);

    const siblings = (this.config.agents || [])
      .filter((a) => a.role === role && a.id !== agentId)
      .map((a) => a.id);

    const prompt = [
      `Objetivo geral:\n${env.task}`,
      `\nSua tarefa (${task.id}):\n${task.instruction}`,
      context ? `\nResultado das tarefas anteriores:\n${context}` : '',
      siblings.length
        ? `\nOutros agentes com a sua funcao: ${siblings.join(', ')}. Nao altere arquivos que nao sejam seus.`
        : '',
      `\nContexto do projeto:\n${env.context}`,
    ]
      .filter(Boolean)
      .join('\n');

    const toolNames = agent?.toolNames || (role === 'researcher' ? READ_ONLY : ALL_TOOLS);

    try {
      const out = await this._agent({
        roleId: agentId,
        provider,
        system: agent?.prompt || PROMPTS[role],
        task: prompt,
        toolNames,
        maxSteps: this.config.limits.maxSteps,
      });

      results[task.id] = {
        ...out,
        ok: role === 'reviewer' ? !/VEREDITO:\s*REPROVADO/i.test(out.text || '') : out.testsPassed !== false,
      };

      if (role === 'reviewer') {
        results.__verdict = results[task.id].ok ? 'aprovado' : 'reprovado';
      }

      this._emit('agent_done', agentId, {
        summary: this._summaryFor(role, out),
        taskId: task.id,
      });
    } catch (err) {
      if (err instanceof Aborted || err instanceof BudgetExceeded) throw err;
      results[task.id] = { ok: false, text: err.message };
      this._emit('agent_error', agentId, { text: `${task.id}: ${err.message}` });
    }
  }

  _summaryFor(role, out) {
    if (role === 'reviewer') {
      return /VEREDITO:\s*APROVADO/i.test(out.text || '') ? 'aprovado' : 'revisado';
    }
    if (role === 'coder') {
      if (out.testsPassed === true) return 'implementado, testes passando';
      if (out.testsPassed === false) return 'implementado, TESTES FALHANDO';
      return 'implementado (nao verificado por testes)';
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
        commit: commit.commit,
      });

      if (this.project) {
        this.project.changed = files.length;
        this.project.committed = commit.ok;
        this.project.commit = commit.commit;
      }
    } catch (err) {
      this._emit('agent_error', null, { text: `falha ao gerar diff: ${err.message}` });
    } finally {
      // Devolve o repositorio para a branch de origem.
      //
      // Sem isso o repo ficava parado na branch agent-town/<runId>, e a
      // proxima execucao criava a branch dela A PARTIR da anterior — as
      // execucoes empilhavam e cada uma herdava as mudancas da anterior.
      // (A branch em si continua existindo, para revisao e merge.)
      if (this.project?.originalBranch && this.project?.branch) {
        await cleanupBranch(env.workspace, null, this.project.originalBranch, env.tmpDir);
      }
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
      { role: 'user', content: this._withBudgetNote(task, maxSteps) },
    ];

    this._emit('agent_thinking', roleId, { text: 'analisando a tarefa' });

    let testsPassed = null; // null = nenhum teste executado (nao verificado)
    let lastText = '';
    let steps = 0;

    // Escopo do cache de leitura: uma conversa por execução de agente.
    const scope = `${roleId}:${++this._scopeSeq}`;
    let warnedBudget = false;

    while (steps < maxSteps) {
      this._checkAbort();
      this._guardBudget();
      steps += 1;

      // Teto quase atingido: avisa o agente para ENTREGAR agora.
      //
      // Sem isso o agente continua lendo arquivo até o teto estourar, e a
      // execução inteira morre sem ter escrito nada — foi assim que 514k
      // tokens viraram zero de entrega.
      if (!warnedBudget) {
        const left = this._tokensLeft();
        if (left !== null && left <= this._softBudgetLimit()) {
          warnedBudget = true;
          this._emit('agent_thinking', roleId, {
            text: `orcamento em ${Math.round(100 - (left / this.config.limits.maxTokens) * 100)}% — pedindo para entregar`,
          });
          messages.push({
            role: 'user',
            content:
              `ATENCAO: restam cerca de ${left} tokens na execucao inteira (todos os agentes). ` +
              'Pare de explorar agora. Escreva os arquivos que ja sabe que precisa, rode os testes ' +
              'se ainda der, e responda. Entregar algo incompleto e melhor que nao entregar nada.',
          });
        }
      }

      const res = await provider.limiter.run(() =>
        provider.chat({
          messages,
          tools,
          temperature: 0.2,
          maxTokens: this.config.limits.maxOutputTokens || 8192,
          signal: this.controller?.signal,
          onRetry: (msg) => this._emit('agent_thinking', roleId, { text: msg }),
          // Consumo real de uma chave de plano: requisições na janela, não
          // tokens. Repassamos para a UI, que mostra o saldo do limite.
          onRateLimit: (info) => this._emit('rate_limit', null, info),
        }),
      );

      this._usage(roleId, provider.model, res.usage);

      // Resposta cortada no limite de saída: os argumentos da ferramenta vêm
      // incompletos (JSON truncado => args vazios). Avisar é essencial, senão
      // o agente acha que escreveu e segue em frente.
      if (res.finishReason === 'length') {
        this._emit('agent_thinking', roleId, {
          text: 'resposta truncada no limite de saida — envie o arquivo em partes',
        });
        messages.push({
          role: 'user',
          content:
            'Sua resposta anterior foi cortada pelo limite de tokens de saida, entao os argumentos ' +
            'da ferramenta chegaram incompletos. Para arquivos grandes, use write_file com ' +
            '"append": true em varias chamadas: a primeira sem append (cria/limpa) e as seguintes ' +
            'com append:true, cada uma com um trecho menor.',
        });
        continue;
      }

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
          outcome = await this._tools.execute(call.name, call.args, { scope, owner: roleId });
        } catch (err) {
          outcome = { ok: false, summary: err.message, output: '' };
        }

        if (call.name === 'run_tests') {
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

    // testsPassed continua null quando nenhum teste rodou: isso vira
    // "nao verificado" em vez de um falso "testes passando".
    return { text: lastText, steps, testsPassed };
  }

  /**
   * Lembrete de orçamento no topo da tarefa.
   *
   * Sem isso os agentes leem 10 arquivos, releem os mesmos, e o teto de tokens
   * acaba antes de escreverem qualquer coisa — foi exatamente o que aconteceu
   * na primeira execução real.
   */
  _withBudgetNote(task, maxSteps) {
    const remaining = this.config.limits.maxTokens
      ? Math.max(0, this.config.limits.maxTokens - (this.totals.in + this.totals.out))
      : null;

    const note = [
      `[limites] Voce tem no maximo ${maxSteps} passos.`,
      remaining !== null ? `Restam ~${remaining} tokens na execucao inteira (todos os agentes).` : '',
      'Seja economico: leia so os arquivos que vai alterar (no maximo 3), nao releia o que ja leu,',
      'e ESCREVA o codigo antes de esgotar os passos. Entregar sem escrever nao serve.',
    ]
      .filter(Boolean)
      .join(' ');

    return `${note}\n\n${task}`;
  }

  _shortArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const p = args.path || args.file || args.arquivo;
    if (p) return String(p);
    if (args.content) return `${String(args.content).length} bytes`;
    return Object.keys(args).join(', ');
  }
}
