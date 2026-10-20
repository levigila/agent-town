// Prova que as instâncias extras realmente rodam em PARALELO.
//
// Este é o teste que justifica a funcionalidade: se dois coders na mesma onda
// não se sobrepõem no tempo, "2 agentes por função" não acelera nada.
//
// Sem rede: provedor falso que registra quantas chamadas estão ativas ao mesmo
// tempo e segura a resposta por um instante para que a sobreposição apareça.

import { Orchestrator } from '../src/orchestrator.mjs';
import { Semaphore } from '../src/limiter.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-town-par-'));
process.env.AGENT_TOWN_RUNS_DIR = runsRoot;

const MODEL = { providerKey: 'fake', model: 'm', ref: 'fake:m' };

const config = (overrides = {}) => ({
  mode: 'real',
  providers: {
    fake: { key: 'fake', label: 'Fake', kind: 'openai', apiKey: 'x', baseUrl: 'http://localhost', concurrency: 4 },
  },
  roles: {
    planner: { id: 'planner', name: 'Planner', modelRef: MODEL },
    researcher: { id: 'researcher', name: 'Researcher', modelRef: MODEL },
    coder: { id: 'coder', name: 'Coder', modelRef: MODEL },
    reviewer: { id: 'reviewer', name: 'Reviewer', modelRef: MODEL },
  },
  limits: { maxSteps: 6, maxTasks: 8, budgetUsd: 0, maxTokens: 0, timeoutSec: 120, agentsPerRole: 2 },
  projectRoots: [],
  server: { port: 0, host: '127.0.0.1' },
  ...overrides,
});

/**
 * Provedor falso que mede concorrência real.
 * `hold` segura cada resposta para dar tempo das chamadas se sobreporem.
 */
function makeFake({ plan, hold = 120 }) {
  const limiter = new Semaphore(4, 'Fake');
  const stats = { active: 0, peak: 0, calls: [], byAgent: {} };
  let plannerCalls = 0;

  const provider = (agentId) => ({
    key: 'fake',
    label: 'Fake',
    model: 'm',
    providerKey: 'fake',
    role: agentId,
    limiter,
    async chat() {
      stats.calls.push(agentId);
      stats.byAgent[agentId] = (stats.byAgent[agentId] || 0) + 1;
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);

      await new Promise((r) => setTimeout(r, hold));
      stats.active -= 1;

      if (agentId === 'planner') {
        plannerCalls += 1;
        return { text: plan, toolCalls: [], finishReason: 'stop', usage: { in: 10, out: 5 } };
      }

      return { text: 'feito', toolCalls: [], finishReason: 'stop', usage: { in: 10, out: 5 } };
    },
  });

  // Provedores separados para PAPEL e para INSTÂNCIA: assim o teste enxerga
  // qual id o orquestrador realmente escolheu, sem ambiguidade de alias.
  const roleIds = ['planner', 'researcher', 'coder', 'reviewer'];
  const instanceIds = [
    'planner',
    'researcher-1',
    'researcher-2',
    'coder-1',
    'coder-2',
    'reviewer-1',
    'reviewer-2',
  ];

  const byRole = {};
  for (const id of roleIds) byRole[id] = provider(id);

  const byInstance = {};
  for (const id of instanceIds) byInstance[id] = provider(id);

  return { factory: () => ({ byRole, byInstance, limiters: { fake: limiter } }), stats, limiter };
}

async function run(orch, request, timeoutMs = 60000) {
  orch.start(request);
  const started = Date.now();
  while (orch.running && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 150));
}

// ===========================================================================
// 1. Dois coders em paralelo na mesma onda
// ===========================================================================
{
  const plan = JSON.stringify({
    tasks: [
      { id: 'a', agent: 'coder-1', instruction: 'mexer em public/js/world.js', depends_on: [] },
      { id: 'b', agent: 'coder-2', instruction: 'mexer em public/js/sprite.js', depends_on: [] },
    ],
  });

  const fake = makeFake({ plan });
  const events = [];
  const orch = new Orchestrator((e) => events.push(e), config(), { providerFactory: fake.factory });
  await run(orch, { task: 'tarefa paralela', mode: 'template', template: 'price-parser' });

  const planEvent = events.find((e) => e.type === 'plan_created');
  expect(planEvent?.tasks?.length === 2, `deveria ter 2 tarefas: ${planEvent?.tasks?.length}`);
  expect(planEvent?.waveCount === 1, `as duas deveriam caber na mesma onda: ${planEvent?.waveCount}`);

  expect(
    fake.stats.byAgent['coder-1'] > 0 && fake.stats.byAgent['coder-2'] > 0,
    `as duas instancias deveriam trabalhar: ${JSON.stringify(fake.stats.byAgent)}`,
  );

  // O planner também conta, então o pico precisa ser pelo menos 2.
  expect(fake.stats.peak >= 2, `deveria haver sobreposicao real (pico ${fake.stats.peak})`);

  // spawn de todas as instancias
  const spawned = events.filter((e) => e.type === 'agent_spawned').map((e) => e.agentId);
  expect(spawned.includes('coder-1') && spawned.includes('coder-2'), `faltou spawn: ${spawned}`);
  expect(spawned.length === 7, `deveriam ser 7 agentes: ${spawned.length}`);
}

// ===========================================================================
// 2. Duas tarefas do MESMO agente não se sobrepõem
// ===========================================================================
{
  const plan = JSON.stringify({
    tasks: [
      { id: 'a', agent: 'coder-1', instruction: 'primeira', depends_on: [] },
      { id: 'b', agent: 'coder-1', instruction: 'segunda', depends_on: [] },
    ],
  });

  const fake = makeFake({ plan });
  const orch = new Orchestrator(() => {}, config(), { providerFactory: fake.factory });
  await run(orch, { task: 'serial', mode: 'template', template: 'price-parser' });

  expect(
    fake.stats.byAgent['coder-1'] >= 2,
    `as duas tarefas deveriam rodar no coder-1: ${fake.stats.byAgent['coder-1']}`,
  );
  expect(
    !fake.stats.byAgent['coder-2'],
    `coder-2 nao deveria ser usado quando o plano fixa coder-1: ${fake.stats.byAgent['coder-2']}`,
  );
  // uma conversa por vez: nunca 2 chamadas do mesmo agente ao mesmo tempo
  expect(fake.stats.peak === 1, `deveria ser serial (pico ${fake.stats.peak})`);
}

// ===========================================================================
// 3. Tarefa genérica ("coder") distribui entre as instâncias
// ===========================================================================
{
  const plan = JSON.stringify({
    tasks: [
      { id: 'a', agent: 'coder', instruction: 'primeira', depends_on: [] },
      { id: 'b', agent: 'coder', instruction: 'segunda', depends_on: [] },
    ],
  });

  const fake = makeFake({ plan });
  const orch = new Orchestrator(() => {}, config(), { providerFactory: fake.factory });
  await run(orch, { task: 'distribui', mode: 'template', template: 'price-parser' });

  expect(
    fake.stats.byAgent['coder-1'] > 0 && fake.stats.byAgent['coder-2'] > 0,
    `deveria distribuir entre as instancias: ${JSON.stringify(fake.stats.byAgent)}`,
  );
  expect(fake.stats.peak >= 2, `deveria rodar em paralelo (pico ${fake.stats.peak})`);
}

// ===========================================================================
// 4. Uma instância só: comportamento clássico, sem paralelismo
// ===========================================================================
{
  const plan = JSON.stringify({
    tasks: [
      { id: 'a', agent: 'coder', instruction: 'unica', depends_on: [] },
    ],
  });

  const fake = makeFake({ plan });
  const orch = new Orchestrator(() => {}, config({ limits: { ...config().limits, agentsPerRole: 1 } }), {
    providerFactory: fake.factory,
  });
  await run(orch, { task: 'sozinho', mode: 'template', template: 'price-parser' });

  expect(fake.stats.byAgent['coder'] > 0, `com 1 por papel o id e limpo: ${JSON.stringify(fake.stats.byAgent)}`);
  expect(!fake.stats.byAgent['coder-1'], 'nao deveria existir coder-1 com 1 por papel');
}

await rm(runsRoot, { recursive: true, force: true });

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — instancias rodam em paralelo e a mesma instancia serializa');
}
