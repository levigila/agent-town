// Testa os ADAPTADORES HTTP de verdade, contra um servidor falso local.
//
// É o único jeito de validar o código de rede (parsing de tool_calls,
// conversão de mensagens, retry, formato Gemini) sem gastar token nem
// depender de chave real.

import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompatProvider } from '../src/providers/openai.mjs';
import { createGeminiProvider } from '../src/providers/gemini.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// --- servidor falso --------------------------------------------------------
const seen = { compat: 0, gemini: 0, lastCompatBody: null, lastGeminiBody: null };

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

const counters = {};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://x');

    // ---- Gemini ---------------------------------------------------------
    if (url.pathname.includes(':generateContent')) {
      seen.gemini += 1;
      seen.lastGeminiBody = body;

      const hasFunctionResponse = JSON.stringify(body.contents || []).includes('functionResponse');
      const parts = hasFunctionResponse
        ? [{ text: 'Testes verdes.\nVEREDITO: APROVADO' }]
        : [{ functionCall: { name: 'run_tests', args: {} } }];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
        }),
      );
      return;
    }

    // ---- [OI] compatível ------------------------------------------------
    if (url.pathname === '/chat/completions') {
      seen.compat += 1;
      seen.lastCompatBody = body;
      const model = body.model || 'x';
      const n = (counters[model] = (counters[model] || 0) + 1);

      const scripts = {
        'm-planner': [
          { text: 'Plano: implementar parsePrice e rodar testes.' },
        ],
        'm-res': [
          { tool_calls: [{ id: 'a1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
          { text: 'Regras: milhar com ponto, decimal com virgula.' },
        ],
        'm-coder': [
          { tool_calls: [{ id: 'b1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/price.mjs', content: SOLUTION }) } }] },
          { tool_calls: [{ id: 'b2', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] },
          { text: 'Implementado, testes passando.' },
        ],
      };

      const script = scripts[model] || [{ text: 'ok' }];
      const step = script[Math.min(n - 1, script.length - 1)];

      const message = step.tool_calls
        ? { role: 'assistant', content: null, tool_calls: step.tool_calls }
        : { role: 'assistant', content: step.text };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 200, completion_tokens: 80 },
        }),
      );
      return;
    }

    if (url.pathname === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm-planner' }, { id: 'm-coder' }] }));
      return;
    }

    res.writeHead(404).end('nope');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

// --- 1. adaptador compatível: chamada direta com tool call -----------------
{
  const p = createCompatProvider({ key: 'fake', label: 'Fake', apiKey: 'k', baseUrl }, 'm-coder');
  const res = await p.chat({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'faz' },
    ],
    tools: [{ name: 'run_tests', description: 'roda', parameters: { type: 'object', properties: {} } }],
    maxTokens: 100,
  });

  expect(res.toolCalls.length === 1, 'compat: nao parseou tool_calls');
  expect(res.toolCalls[0].name === 'write_file', `compat: nome errado ${res.toolCalls[0]?.name}`);
  expect(res.toolCalls[0].args.path === 'src/price.mjs', 'compat: args nao foram parseados');
  expect(res.usage.in === 200 && res.usage.out === 80, 'compat: usage errado');

  const sent = seen.lastCompatBody;
  expect(sent.tools?.[0]?.function?.name === 'run_tests', 'compat: tools nao foram enviadas no formato certo');
  expect(sent.messages[0].role === 'system', 'compat: system nao foi enviado');

  const models = await p.listModels();
  expect(models.includes('m-planner'), 'compat: listModels falhou');
}

// --- 2. adaptador Gemini: system vira systemInstruction --------------------
{
  const p = createGeminiProvider({ key: 'gem', label: 'Gem', apiKey: 'k', baseUrl }, 'g-model');
  const res = await p.chat({
    messages: [
      { role: 'system', content: 'voce e o reviewer' },
      { role: 'user', content: 'revise' },
    ],
    tools: [{ name: 'run_tests', description: 'roda', parameters: { type: 'object', properties: {} } }],
    maxTokens: 100,
  });

  expect(res.toolCalls.length === 1, 'gemini: nao parseou functionCall');
  expect(res.toolCalls[0].name === 'run_tests', 'gemini: nome errado');
  expect(res.usage.in === 120, 'gemini: usage errado');

  const sent = seen.lastGeminiBody;
  expect(sent.systemInstruction?.parts?.[0]?.text === 'voce e o reviewer', 'gemini: systemInstruction ausente');
  expect(sent.contents?.[0]?.role === 'user', 'gemini: contents errado');
  expect(sent.tools?.[0]?.functionDeclarations?.[0]?.name === 'run_tests', 'gemini: tools no formato errado');
  expect(sent.generationConfig?.maxOutputTokens === 100, 'gemini: generationConfig errado');
}

// --- 3. orquestrador completo usando os adaptadores reais -----------------
{
  // a seção 1 já consumiu o roteiro do modelo; zera para o fluxo começar do topo
  for (const k of Object.keys(counters)) delete counters[k];

  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-adapters-'));
  process.env.AGENT_TOWN_RUNS_DIR = runsDir;

  const config = {
    mode: 'real',
    providers: {
      verboo: { key: 'verboo', label: 'Verboo', kind: 'openai', apiKey: 'k', baseUrl, concurrency: 2 },
      gemini: { key: 'gemini', label: 'Gemini', kind: 'gemini', apiKey: 'k', baseUrl, concurrency: 4 },
    },
    roles: {
      planner: { id: 'planner', name: 'Planner', modelRef: { providerKey: 'verboo', model: 'm-planner', ref: 'verboo:m-planner' } },
      researcher: { id: 'researcher', name: 'Researcher', modelRef: { providerKey: 'verboo', model: 'm-res', ref: 'verboo:m-res' } },
      coder: { id: 'coder', name: 'Coder', modelRef: { providerKey: 'verboo', model: 'm-coder', ref: 'verboo:m-coder' } },
      reviewer: { id: 'reviewer', name: 'Reviewer', modelRef: { providerKey: 'gemini', model: 'g-model', ref: 'gemini:g-model' } },
    },
    limits: { maxSteps: 8, budgetUsd: 0, maxTokens: 0, timeoutSec: 120, maxFixRounds: 1 },
    server: { port: 0, host: '127.0.0.1' },
  };

  const events = [];
  const orch = new Orchestrator((ev) => events.push(ev), config);

  orch.start();
  const started = Date.now();
  while (orch.running && Date.now() - started < 60000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 150));

  const finished = events.find((e) => e.type === 'run_finished');
  expect(finished, 'orquestrador: sem run_finished');
  expect(finished?.reason === 'completed', `orquestrador: terminou como "${finished?.reason}"`);

  const tests = events.filter((e) => e.type === 'tool_result' && e.tool === 'run_tests');
  expect(tests.some((t) => t.ok), 'orquestrador: run_tests nunca passou');

  const verdict = events.find((e) => e.type === 'agent_done' && e.agentId === 'reviewer');
  expect(verdict?.summary === 'aprovado', `orquestrador: veredito "${verdict?.summary}"`);

  expect(seen.compat > 0 && seen.gemini > 0, 'orquestrador: nao usou os dois provedores');

  const peak = orch.limiters?.verboo?.stats().peak ?? 0;
  expect(peak <= 2, `orquestrador: concorrencia ${peak} passou do limite 2`);

  await rm(runsDir, { recursive: true, force: true });
}

server.close();

console.log(`chamadas: ${seen.compat} compativel · ${seen.gemini} gemini`);

if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — adaptadores [OI] e Gemini validados de ponta a ponta');
}
