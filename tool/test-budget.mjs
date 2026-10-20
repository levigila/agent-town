// Testa o comportamento do orçamento: aviso antes do teto e relatório depois.
//
// Motivação real: uma execução gastou 514k tokens (teto de 500k) e morreu sem
// escrever nada. Os agentes leram arquivos até o teto estourar. A correção tem
// duas partes: avisar em 80% para entregar o que já tem, e dizer QUEM gastou.

import { Orchestrator } from '../src/orchestrator.mjs';
import { Semaphore } from '../src/limiter.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-town-budget-'));
process.env.AGENT_TOWN_RUNS_DIR = runsRoot;

const MODEL = { providerKey: 'fake', model: 'm', ref: 'fake:m' };

/**
 * Provedor falso que gasta `usageIn` por chamada e registra as mensagens
 * recebidas, para vermos se o aviso de orçamento chegou ao agente.
 */
function makeFake({ usageIn = 1000, steps = 8 } = {}) {
  const limiter = new Semaphore(4, 'Fake');
  const seen = { coder: [], planner: [] };
  const counters = {};

  const provider = (roleId) => ({
    key: 'fake',
    label: 'Fake',
    model: 'm',
    providerKey: 'fake',
    role: roleId,
    limiter,
    async chat({ messages }) {
      const bucket = roleId === 'planner' ? 'planner' : 'coder';
      seen[bucket].push(messages.map((m) => String(m.content || '')));

      if (roleId === 'planner') {
        return {
          text: JSON.stringify({ tasks: [{ id: 't1', agent: 'coder', instruction: 'trabalhar', depends_on: [] }] }),
          toolCalls: [],
          finishReason: 'stop',
          usage: { in: usageIn, out: 10 },
        };
      }

      // O coder fica pedindo ferramenta para sempre (nunca termina sozinho):
      // é o cenário que estourava o teto.
      const i = counters[roleId] || 0;
      counters[roleId] = i + 1;

      return {
        text: 'continuando',
        toolCalls: [{ id: `c${i}`, name: 'list_files', args: {} }],
        finishReason: 'stop',
        usage: { in: usageIn, out: 10 },
      };
    },
  });

  const byRole = {
    planner: provider('planner'),
    coder: provider('coder'),
  };
  const byInstance = { planner: byRole.planner, 'coder-1': byRole.coder };

  return { factory: () => ({ byRole, byInstance, limiters: { fake: limiter } }), seen, counters };
}

const config = (limits = {}) => ({
  mode: 'real',
  providers: {
    fake: { key: 'fake', label: 'Fake', kind: 'openai', apiKey: 'x', baseUrl: 'http://localhost', concurrency: 4 },
  },
  roles: {
    planner: { id: 'planner', name: 'Planner', modelRef: MODEL },
    coder: { id: 'coder', name: 'Coder', modelRef: MODEL },
  },
  limits: { maxSteps: 20, maxTasks: 4, budgetUsd: 0, maxTokens: 20000, timeoutSec: 60, agentsPerRole: 1, ...limits },
  projectRoots: [],
  server: { port: 0, host: '127.0.0.1' },
});

async function run(orch, request, timeoutMs = 60000) {
  orch.start(request);
  const started = Date.now();
  while (orch.running && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 150));
}

// ===========================================================================
// 1. Aviso em 80% chega ao agente antes do teto
// ===========================================================================
{
  const fake = makeFake({ usageIn: 2000 });
  const events = [];
  const orch = new Orchestrator((e) => events.push(e), config({ maxTokens: 20000 }), {
    providerFactory: fake.factory,
  });

  await run(orch, { task: 'gastar tudo', mode: 'template', template: 'price-parser' });

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason === 'budget', `deveria parar por orcamento, veio ${finished?.reason}`);

  // o aviso precisa aparecer nas mensagens do coder
  const coderMessages = fake.seen.coder.flat();
  const warned = coderMessages.some((m) => m.includes('Pare de explorar agora'));
  expect(warned, 'o agente deveria receber o aviso de orcamento antes do teto');

  // e o aviso vem ANTES do fim: houve pelo menos uma chamada depois dele
  const firstWarn = coderMessages.findIndex((m) => m.includes('Pare de explorar agora'));
  expect(firstWarn >= 0 && fake.seen.coder.length > 1, 'o aviso deveria chegar durante a execucao');

  // o evento de aviso aparece na UI
  const note = events.find(
    (e) => e.type === 'agent_thinking' && String(e.text || '').includes('orcamento em'),
  );
  expect(note, 'deveria emitir um evento avisando que o orcamento esta acabando');

  // o relatorio final diz quem gastou
  expect(String(finished?.spent || '').length > 0, `deveria listar os maiores gastos: ${finished?.spent}`);
  expect(String(finished?.hint || '').includes('Maiores gastos'), 'o hint deveria citar os maiores gastos');
}

// ===========================================================================
// 2. Sem teto configurado, nao avisa e nao para
// ===========================================================================
{
  const fake = makeFake({ usageIn: 500, steps: 2 });
  const events = [];
  const orch = new Orchestrator((e) => events.push(e), config({ maxTokens: 0, maxSteps: 3 }), {
    providerFactory: fake.factory,
  });

  await run(orch, { task: 'sem teto', mode: 'template', template: 'price-parser' });

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished?.reason !== 'budget', `sem teto nao deveria parar por orcamento: ${finished?.reason}`);

  const warned = fake.seen.coder.flat().some((m) => m.includes('Pare de explorar agora'));
  expect(!warned, 'sem teto nao deveria avisar sobre orcamento');
}

// ===========================================================================
// 3. _tokensLeft e _softBudgetLimit
// ===========================================================================
{
  const orch = new Orchestrator(() => {}, config({ maxTokens: 10000 }), { providerFactory: makeFake().factory });
  expect(orch._tokensLeft() === 10000, `sem uso, restam todos: ${orch._tokensLeft()}`);
  expect(orch._softBudgetLimit() === 2000, `limite suave deveria ser 20% do teto: ${orch._softBudgetLimit()}`);

  orch.totals.in = 4000;
  orch.totals.out = 1000;
  expect(orch._tokensLeft() === 5000, `deveria restar 5000: ${orch._tokensLeft()}`);

  const semTeto = new Orchestrator(() => {}, config({ maxTokens: 0 }), { providerFactory: makeFake().factory });
  expect(semTeto._tokensLeft() === null, 'sem teto, _tokensLeft deveria ser null');
}

await rm(runsRoot, { recursive: true, force: true });

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — aviso de orcamento antes do teto e relatorio de quem gastou');
}
