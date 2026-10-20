// Testa o orquestrador INTEIRO com provedor falso.
//
// Cobre o que o modo real faz sem gastar um token:
//   - Fase A: tarefa vem do request
//   - Fase B: Planner devolve grafo -> ondas -> execução paralela -> contexto
//   - Fase B: Planner quebrado -> fallback
//   - Fase C: projeto real com branch git, diff e commit (nunca push)

import { Orchestrator } from '../src/orchestrator.mjs';
import { Semaphore } from '../src/limiter.mjs';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const SOLUTION = `export function parsePrice(input) {
  if (input === null || input === undefined) throw new Error('vazio');
  const raw = String(input).trim();
  if (!raw) throw new Error('vazio');
  const cleaned = raw.replace(/^(R\\$|US\\$|\\$)\\s*/i, '').replace(/\\s/g, '');
  if (!/\\d/.test(cleaned)) throw new Error('sem digitos');
  let normalized;
  if (cleaned.includes(',')) {
    normalized = cleaned.replace(/\\./g, '').replace(',', '.');
  } else {
    const dots = (cleaned.match(/\\./g) || []).length;
    if (dots === 1) {
      const [a, b] = cleaned.split('.');
      normalized = b.length === 3 && a.length <= 3 ? a + b : cleaned;
    } else {
      normalized = cleaned.replace(/\\./g, '');
    }
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error('invalido');
  return Math.round(value * 100);
}
`;

const baseConfig = (overrides = {}) => ({
  mode: 'real',
  providers: {
    fake: { key: 'fake', label: 'Fake', kind: 'openai', apiKey: 'x', baseUrl: 'http://localhost', concurrency: 2 },
  },
  roles: {
    planner: { id: 'planner', name: 'Planner', modelRef: { providerKey: 'fake', model: 'm-planner', ref: 'fake:m-planner' } },
    researcher: { id: 'researcher', name: 'Researcher', modelRef: { providerKey: 'fake', model: 'm-res', ref: 'fake:m-res' } },
    coder: { id: 'coder', name: 'Coder', modelRef: { providerKey: 'fake', model: 'm-coder', ref: 'fake:m-coder' } },
    reviewer: { id: 'reviewer', name: 'Reviewer', modelRef: { providerKey: 'fake', model: 'm-rev', ref: 'fake:m-rev' } },
  },
  limits: { maxSteps: 8, maxTasks: 6, budgetUsd: 0, maxTokens: 0, timeoutSec: 120 },
  projectRoots: [],
  server: { port: 0, host: '127.0.0.1' },
  ...overrides,
});

const PLAN_JSON = JSON.stringify({
  tasks: [
    { id: 't1', agent: 'researcher', instruction: 'mapear o codigo', depends_on: [] },
    { id: 't2', agent: 'coder', instruction: 'implementar parsePrice', depends_on: ['t1'] },
    { id: 't3', agent: 'reviewer', instruction: 'revisar', depends_on: ['t2'] },
  ],
});

/** Provedor falso com roteiro por papel. */
function makeFakeProviders({ plannerReply = PLAN_JSON, coderWrites = true } = {}) {
  const limiter = new Semaphore(2, 'Fake');
  const calls = [];
  const order = [];

  const scripts = {
    researcher: [
      { toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'SPEC.md' } }] },
      { text: 'Regras: tratar milhar com ponto e decimal com virgula.' },
    ],
    coder: [
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'SPEC.md' } }] },
      ...(coderWrites
        ? [
            { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'src/price.mjs', content: SOLUTION } }] },
            { toolCalls: [{ id: 'c3', name: 'run_tests', args: {} }] },
          ]
        : []),
      { text: 'Implementado, testes passando.' },
    ],
    reviewer: [
      { toolCalls: [{ id: 'v1', name: 'run_tests', args: {} }] },
      { text: 'Codigo correto.\nVEREDITO: APROVADO' },
    ],
  };

  const counters = {};
  let plannerCalls = 0;

  const make = (roleId, model) => ({
    key: 'fake',
    label: 'Fake',
    model,
    providerKey: 'fake',
    role: roleId,
    limiter,
    async chat() {
      calls.push(roleId);
      order.push(roleId);

      if (roleId === 'planner') {
        plannerCalls += 1;
        const reply = typeof plannerReply === 'function' ? plannerReply(plannerCalls) : plannerReply;
        return { text: reply, toolCalls: [], finishReason: 'stop', usage: { in: 100, out: 50 } };
      }

      const script = scripts[roleId] || [{ text: 'ok' }];
      const i = counters[roleId] || 0;
      counters[roleId] = i + 1;
      const step = script[Math.min(i, script.length - 1)];

      return {
        text: step.text || '',
        toolCalls: step.toolCalls || [],
        finishReason: 'stop',
        usage: { in: 100, out: 50 },
      };
    },
  });

  return {
    byRole: {
      planner: make('planner', 'm-planner'),
      researcher: make('researcher', 'm-res'),
      coder: make('coder', 'm-coder'),
      reviewer: make('reviewer', 'm-rev'),
    },
    limiters: { fake: limiter },
    calls,
    order,
  };
}

async function runOrch(orch, request, timeoutMs = 60000) {
  const started = Date.now();
  orch.start(request);
  while (orch.running && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 200));
}

const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-town-runs-'));
process.env.AGENT_TOWN_RUNS_DIR = runsRoot;

// ===========================================================================
// 1. Modo template, plano válido
// ===========================================================================
{
  const events = [];
  const fake = makeFakeProviders();
  const orch = new Orchestrator((ev) => events.push(ev), baseConfig(), { providerFactory: () => fake });

  await runOrch(orch, {
    task: 'implementar parsePrice conforme SPEC.md',
    mode: 'template',
    template: 'price-parser',
  });

  const types = events.map((e) => e.type);
  const plan = events.find((e) => e.type === 'plan_created');
  const finished = events.find((e) => e.type === 'run_finished');

  expect(types[0] === 'run_started', `primeiro evento deveria ser run_started, veio ${types[0]}`);
  expect(plan, 'faltou plan_created');
  expect(plan?.tasks?.length === 3, `plano deveria ter 3 tarefas, veio ${plan?.tasks?.length}`);
  expect(plan?.fellBack === false, 'nao deveria usar fallback');
  expect(plan?.waveCount === 3, `esperava 3 ondas, veio ${plan?.waveCount}`);
  expect(finished?.reason === 'completed', `deveria completar, veio "${finished?.reason}"`);

  const pos = {};
  fake.order.forEach((r, i) => {
    if (pos[r] === undefined) pos[r] = i;
  });
  expect(pos.researcher < pos.coder, 'researcher deveria vir antes do coder');
  expect(pos.coder < pos.reviewer, 'coder deveria vir antes do reviewer');

  expect(fake.limiters.fake.peak <= 2, `concorrencia estourou: pico ${fake.limiters.fake.peak}`);

  const handoffs = events.filter((e) => e.type === 'agent_message' && e.to);
  expect(handoffs.length >= 3, 'deveria haver handoffs para cada tarefa');
  expect(handoffs.every((h) => h.taskId), 'handoffs deveriam carregar taskId');
}

// ===========================================================================
// 2. Planner quebrado -> fallback
// ===========================================================================
{
  const events = [];
  const fake = makeFakeProviders({ plannerReply: 'nao consigo planejar isso, desculpe' });
  const orch = new Orchestrator((ev) => events.push(ev), baseConfig(), { providerFactory: () => fake });

  await runOrch(orch, { task: 'qualquer coisa', mode: 'template', template: 'price-parser' });

  const plan = events.find((e) => e.type === 'plan_created');
  const finished = events.find((e) => e.type === 'run_finished');

  expect(plan?.fellBack === true, 'deveria marcar fallback');
  expect(plan?.tasks?.length === 3, 'fallback deveria ter 3 tarefas');
  expect(finished, 'deveria terminar mesmo com planner quebrado');
  expect(finished?.reason !== 'error', `nao deveria falhar: ${finished?.reason}`);
}

// ===========================================================================
// 3. Planner com ciclo -> fallback
// ===========================================================================
{
  const events = [];
  const cyclic = JSON.stringify({
    tasks: [
      { id: 'a', agent: 'coder', instruction: 'x', depends_on: ['b'] },
      { id: 'b', agent: 'coder', instruction: 'y', depends_on: ['a'] },
    ],
  });
  const fake = makeFakeProviders({ plannerReply: cyclic });
  const orch = new Orchestrator((ev) => events.push(ev), baseConfig(), { providerFactory: () => fake });

  await runOrch(orch, { task: 'tarefa', mode: 'template', template: 'price-parser' });

  const plan = events.find((e) => e.type === 'plan_created');
  expect(plan?.fellBack === true, 'ciclo deveria cair no fallback');
}

// ===========================================================================
// 4. Projeto real: git branch, diff, commit
// ===========================================================================
{
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-proj-'));

  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, stdio: 'ignore' });

  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await mkdir(path.join(projectDir, 'test'), { recursive: true });
  await writeFile(path.join(projectDir, 'SPEC.md'), '# Tarefa\nImplemente parsePrice.\n', 'utf8');
  await writeFile(path.join(projectDir, 'src', 'price.mjs'), 'export function parsePrice() { throw new Error("todo"); }\n', 'utf8');
  await writeFile(
    path.join(projectDir, 'test', 'price.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parsePrice } from '../src/price.mjs';\ntest('ok', () => assert.equal(parsePrice('R$ 42,90'), 4290));\n`,
    'utf8',
  );
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'proj', type: 'module' }), 'utf8');

  execFileSync('git', ['add', '-A'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: [projectDir] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: 'implemente parsePrice conforme SPEC.md', mode: 'project', projectPath: projectDir });

  const diffEvent = events.find((e) => e.type === 'diff_ready');
  const finished = events.find((e) => e.type === 'run_finished');

  expect(finished?.reason === 'completed', `projeto deveria completar, veio "${finished?.reason}"`);
  expect(diffEvent, 'faltou diff_ready');
  expect(diffEvent?.branch?.startsWith('agent-town/'), `branch errada: ${diffEvent?.branch}`);
  expect(diffEvent?.committed === true, 'deveria ter commitado na branch');
  expect((diffEvent?.files || []).length > 0, 'deveria haver arquivos alterados');
  expect(diffEvent?.diff?.includes('parsePrice'), 'diff deveria mostrar o codigo');

  const content = await readFile(path.join(projectDir, 'src', 'price.mjs'), 'utf8');
  expect(content.includes('Math.round'), 'o arquivo do projeto deveria ter sido alterado');

  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();
  expect(branch.startsWith('agent-town/'), `deveria estar na branch de trabalho, esta em ${branch}`);

  let hasRemote = true;
  try {
    const remotes = execFileSync('git', ['remote'], { cwd: projectDir, encoding: 'utf8' }).trim();
    hasRemote = remotes.length > 0;
  } catch {
    hasRemote = false;
  }
  expect(!hasRemote, 'o teste nao deve ter remote (garante que nada foi enviado)');

  const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: projectDir, encoding: 'utf8' });
  expect(log.includes('agent-town'), 'commit deveria ter a mensagem do agent-town');

  await rm(projectDir, { recursive: true, force: true });
}

// ===========================================================================
// 5. Projeto real: arquivo rastreado modificado deve recusar
// ===========================================================================
{
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-dirty-'));

  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectDir, stdio: 'ignore' });
  await writeFile(path.join(projectDir, 'a.txt'), 'a', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  // modifica um arquivo RASTREADO (isso misturaria com o diff dos agentes)
  await writeFile(path.join(projectDir, 'a.txt'), 'alterado sem commit', 'utf8');

  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: [projectDir] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: 'qualquer', mode: 'project', projectPath: projectDir }, 30000);

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason === 'setup_failed', `deveria recusar arquivo modificado, veio "${finished?.reason}"`);
  expect(String(finished?.error || '').includes('nao commitadas'), 'o erro deveria explicar as alteracoes pendentes');

  await rm(projectDir, { recursive: true, force: true });
}

// ===========================================================================
// 5b. Projeto real: arquivos NÃO rastreados são tolerados e ficam de fora
// ===========================================================================
{
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-untracked-'));

  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectDir, stdio: 'ignore' });

  await mkdir(path.join(projectDir, 'src'), { recursive: true });
  await mkdir(path.join(projectDir, 'test'), { recursive: true });
  await writeFile(path.join(projectDir, 'SPEC.md'), '# Tarefa\nImplemente parsePrice.\n', 'utf8');
  await writeFile(path.join(projectDir, 'src', 'price.mjs'), 'export function parsePrice() { throw new Error("todo"); }\n', 'utf8');
  await writeFile(
    path.join(projectDir, 'test', 'price.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parsePrice } from '../src/price.mjs';\ntest('ok', () => assert.equal(parsePrice('R$ 42,90'), 4290));\n`,
    'utf8',
  );
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }), 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  // lixo não rastreado que já existia antes da execução
  await mkdir(path.join(projectDir, '.vscode'), { recursive: true });
  await writeFile(path.join(projectDir, '.vscode', 'settings.json'), '{}', 'utf8');

  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: [projectDir] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: 'implemente parsePrice conforme SPEC.md', mode: 'project', projectPath: projectDir });

  const diffEvent = events.find((e) => e.type === 'diff_ready');
  const finished = events.find((e) => e.type === 'run_finished');

  expect(finished?.reason === 'completed', `lixo nao rastreado nao deveria bloquear, veio "${finished?.reason}"`);
  expect(diffEvent, 'faltou diff_ready');

  const touched = (diffEvent?.files || []).map((f) => f.file);
  expect(!touched.some((f) => f.includes('.vscode')), `o commit nao deveria incluir .vscode: ${touched.join(', ')}`);
  expect(touched.some((f) => f.includes('price.mjs')), 'deveria incluir o arquivo do agente');

  await rm(projectDir, { recursive: true, force: true });
}

// ===========================================================================
// 6. Projeto fora das raízes permitidas deve ser recusado
// ===========================================================================
{
  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: ['C:\\pasta\\permitida'] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: 'x', mode: 'project', projectPath: 'C:\\Windows\\System32' }, 20000);

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason === 'setup_failed', 'deveria recusar caminho fora das raizes');
  expect(String(finished?.error || '').includes('permitidas'), 'o erro deveria citar as raizes permitidas');
}

// ===========================================================================
// 7. Modo projeto sem tarefa deve recusar
// ===========================================================================
{
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-notask-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectDir, stdio: 'ignore' });
  await writeFile(path.join(projectDir, 'a.txt'), 'a', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: [projectDir] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: '', mode: 'project', projectPath: projectDir }, 20000);

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason === 'setup_failed', 'deveria exigir tarefa no modo projeto');
  expect(String(finished?.error || '').includes('tarefa'), 'o erro deveria pedir uma tarefa');

  await rm(projectDir, { recursive: true, force: true });
}

// ===========================================================================
// 8. Repositório sem nenhum commit deve recusar com mensagem clara
// ===========================================================================
{
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-unborn-'));

  // git init SEM commit: HEAD "unborn"
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectDir, stdio: 'ignore' });
  await writeFile(path.join(projectDir, 'a.txt'), 'a', 'utf8');

  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: [projectDir] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: 'fazer algo', mode: 'project', projectPath: projectDir }, 20000);

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason === 'setup_failed', 'repo sem commits deveria recusar');
  expect(
    String(finished?.error || '').toLowerCase().includes('commit'),
    `o erro deveria falar de commit inicial, veio: ${finished?.error}`,
  );

  await rm(projectDir, { recursive: true, force: true });
}

// ===========================================================================
// 9. Pasta que não é repositório git deve recusar com mensagem clara
// ===========================================================================
{
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-norepo-'));
  await writeFile(path.join(projectDir, 'a.txt'), 'a', 'utf8');

  const events = [];
  const fake = makeFakeProviders();
  const config = baseConfig({ projectRoots: [projectDir] });
  const orch = new Orchestrator((ev) => events.push(ev), config, { providerFactory: () => fake });

  await runOrch(orch, { task: 'fazer algo', mode: 'project', projectPath: projectDir }, 20000);

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason === 'setup_failed', 'pasta sem git deveria recusar');
  expect(
    String(finished?.error || '').includes('git init'),
    `o erro deveria sugerir git init, veio: ${finished?.error}`,
  );

  await rm(projectDir, { recursive: true, force: true });
}

await rm(runsRoot, { recursive: true, force: true });

if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — orquestrador: grafo, fallback, contexto, git e recusas de seguranca');
}
