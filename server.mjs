// agent-town — servidor local
// Serve o frontend estatico e transmite o stream de eventos via SSE.
//
// A ideia central da arquitetura: o frontend NUNCA fala com a API dos modelos.
// Ele so consome eventos. O runner decide a origem:
//   ORCHESTRATOR=sim  -> src/simulator.mjs    (roteiro, custo zero)
//   ORCHESTRATOR=real -> src/orchestrator.mjs (chama as APIs de verdade)
// O frontend nao muda uma linha entre os dois modos.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulator } from './src/simulator.mjs';
import { Orchestrator } from './src/orchestrator.mjs';
import { loadEnv } from './src/env.mjs';
import { loadConfig, validateRealMode } from './src/config.mjs';
import { browseDirectory, projectContext } from './src/project.mjs';
import { loadOpenCodeAgents } from './src/opencode.mjs';
import { runMeeting, composeTask, contextToText } from './src/brainstorm.mjs';
import { createProvidersForRoles } from './src/providers/index.mjs';
import { loadProposals, saveProposals, setProposalStatus } from './src/meeting-store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

loadEnv(path.join(ROOT, '.env'));
const config = loadConfig();

const PORT = config.server.port;
const HOST = config.server.host;

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }),
);

// ---------------------------------------------------------------------------
// Hub de eventos: buffer de historico + leque para todos os clientes SSE
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 500;
const history = [];
const clients = new Set();

function broadcast(ev) {
  if (ev.type === 'diff_ready' && implementationProposalIds.length) {
    changeProposalStatuses(implementationProposalIds, 'validating');
  } else if (ev.type === 'run_finished' && implementationProposalIds.length) {
    changeProposalStatuses(implementationProposalIds, ev.reason === 'completed' ? 'validating' : 'approved');
    implementationProposalIds = [];
  }
  history.push(ev);
  if (history.length > HISTORY_LIMIT) history.shift();
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------------------
// Escolha do runner
// ---------------------------------------------------------------------------

let runner;
let modeInfo = { mode: 'sim', label: 'simulado', problems: [], warnings: [] };

if (config.mode === 'real') {
  const check = validateRealMode(config);
  modeInfo = { mode: 'real', label: 'real', problems: check.problems, warnings: check.warnings };

  if (check.ok) {
    runner = new Orchestrator(broadcast, config);
  } else {
    console.error('\n  [agent-town] modo real solicitado, mas a configuracao esta incompleta:');
    for (const p of check.problems) console.error(`    - ${p}`);
    console.error('  Caindo para o modo simulado. Rode "npm run doctor" para detalhes.\n');
    modeInfo.label = 'simulado (fallback)';
    runner = new Simulator(broadcast);
  }
} else {
  runner = new Simulator(broadcast);
}

// ---------------------------------------------------------------------------
// Reuniao de melhoria
//
// Os agentes se sentam na mesa e cada um propoe UMA melhoria para o proprio
// agent-town. Nada e implementado sem aprovacao do usuario no card da tela.
// O alvo e sempre a pasta do servidor: o escritorio E o agent-town.
// ---------------------------------------------------------------------------

const meeting = {
  active: false,
  busy: false,
  proposals: [],
  errors: [],
  usage: { in: 0, out: 0 },
  startedAt: null,
  finishedAt: null,
  target: ROOT,
  error: null,
};

const proposalStore = path.join(ROOT, '.agent-town', 'proposals.json');
meeting.proposals = await loadProposals(proposalStore);

let meetingProviders = null;
let meetingAbort = null;
let meetingRun = 0;
let proposalIdSeq = 0;
let implementationProposalIds = [];
let persistence = Promise.resolve();

function persistMeeting() {
  persistence = persistence.catch(() => {}).then(() => saveProposals(proposalStore, meeting.proposals));
  return persistence;
}

function changeProposalStatuses(ids, status) {
  const selected = new Set(ids);
  let changed = false;
  meeting.proposals = meeting.proposals.map((proposal) => {
    if (!selected.has(proposal.id) || proposal.status === status) return proposal;
    changed = true;
    return setProposalStatus(proposal, status);
  });
  if (changed) {
    persistMeeting().catch((err) => {
      meeting.error = `nao foi possivel salvar propostas: ${err.message}`;
      console.error('[agent-town] falha ao salvar propostas', err);
    });
    broadcast({ type: 'meeting_updated', agentId: null, ts: Date.now(), meeting: publicMeeting() });
  }
}

/** Providers da reuniao (criados uma vez; nunca rodam junto com uma execucao). */
function getMeetingProviders() {
  if (!meetingProviders) meetingProviders = createProvidersForRoles(config);
  return meetingProviders;
}

function publicMeeting() {
  return {
    active: meeting.active,
    busy: meeting.busy,
    proposals: meeting.proposals,
    errors: meeting.errors,
    usage: meeting.usage,
    startedAt: meeting.startedAt,
    finishedAt: meeting.finishedAt,
    target: meeting.target,
    error: meeting.error,
  };
}

/**
 * Comeca a reuniao em segundo plano.
 * Os eventos chegam por SSE (meeting_started, proposal, meeting_done), entao a
 * requisicao HTTP nao precisa esperar os modelos responderem.
 */
function startMeeting({ task = '' } = {}) {
  if (meeting.busy) return { ok: false, error: 'a reuniao ja esta acontecendo' };
  if (runner.running) return { ok: false, error: 'pare a execucao antes de abrir a reuniao' };
  if (modeInfo.mode !== 'real') {
    return { ok: false, error: 'a reuniao precisa do modo real (ORCHESTRATOR=real)' };
  }

  meeting.busy = true;
  meeting.active = true;
  meeting.errors = [];
  meeting.usage = { in: 0, out: 0 };
  meeting.startedAt = Date.now();
  meeting.finishedAt = null;
  meeting.error = null;

  meetingAbort = new AbortController();
  const run = ++meetingRun;
  const signal = meetingAbort.signal;

  broadcast({ type: 'meeting_started', agentId: null, ts: Date.now(), agents: config.agents || [] });

  (async () => {
    try {
      const { byInstance, byRole } = getMeetingProviders();
      const tree = await projectContext(ROOT).catch(() => null);
      const treeText = contextToText(tree);
      const knownFiles = Array.isArray(tree?.files)
        ? tree.files
        : String(treeText)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.endsWith('/'));
      const previousIdeas = meeting.proposals
        .slice(-20)
        .map((proposal) => `- [${proposal.status}] ${proposal.title}: ${String(proposal.benefits || proposal.why || '').slice(0, 180)}`)
        .join('\n');

      const result = await runMeeting({
        agents: config.agents || [],
        byInstance,
        byRole,
        context: [
          task ? `Pedido do usuario: ${task}` : '',
          treeText,
          previousIdeas ? `Melhorias ja registradas — nao as proponha novamente:\n${previousIdeas}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        fileTree: treeText,
        knownFiles,
        signal,
        emit: (type, agentId, payload) =>
          broadcast({ type, agentId, ts: Date.now(), ...(payload || {}) }),
      });

      if (run !== meetingRun || signal.aborted) return;
      const createdAt = Date.now();
      meeting.proposals.push(
        ...result.proposals.map((p) => {
          const id = `${p.id}_${createdAt.toString(36)}_${(++proposalIdSeq).toString(36)}`;
          return {
            ...p,
            id,
            benefits: p.benefits || p.why,
            risks: p.risks || '',
            complexity: p.effort,
            impact: p.impact || 'medio',
            dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
            feedback: Array.isArray(p.feedback) ? p.feedback : [],
            votes: Array.isArray(p.votes) ? p.votes : [],
            createdAt,
            status: 'proposal',
            statusHistory: [{ status: 'proposal', at: createdAt }],
          };
        }),
      );
      meeting.errors = result.errors;
      meeting.usage = result.usage;
      meeting.error = result.proposals.length ? null : 'nenhum agente devolveu proposta valida';
      await persistMeeting();
      broadcast({ type: 'meeting_updated', agentId: null, ts: Date.now(), meeting: publicMeeting() });
    } catch (err) {
      if (run !== meetingRun) return;
      meeting.error = err.message;
      broadcast({ type: 'agent_error', agentId: null, ts: Date.now(), text: `reuniao: ${err.message}` });
    } finally {
      if (run === meetingRun) {
        meeting.busy = false;
        meeting.finishedAt = Date.now();
        meetingAbort = null;
        broadcast({ type: 'meeting_done', agentId: null, ts: Date.now(), meeting: publicMeeting() });
      }
    }
  })();

  return { ok: true, meeting: publicMeeting() };
}

function stopMeeting() {
  meetingRun++;
  meetingAbort?.abort();
  meetingAbort = null;
  meeting.active = false;
  meeting.busy = false;
  meeting.finishedAt = Date.now();
  broadcast({ type: 'meeting_done', agentId: null, ts: Date.now(), meeting: publicMeeting() });
  return { ok: true, meeting: publicMeeting() };
}

/**
 * Registra a decisao final do usuario sem iniciar a implementacao.
 */
function decideMeeting({ approve = [], reject = [], dismiss = [] } = {}) {
  const rejectIds = new Set([...Array.isArray(reject) ? reject : [], ...Array.isArray(dismiss) ? dismiss : []]);
  const approveIds = new Set((Array.isArray(approve) ? approve : []).filter((id) => !rejectIds.has(id)));

  const approvedNow = meeting.proposals
    .filter((p) => approveIds.has(p.id) && p.status === 'proposal')
    .map((p) => p.id);
  const rejectedNow = meeting.proposals
    .filter((p) => rejectIds.has(p.id) && ['proposal', 'analysis'].includes(p.status))
    .map((p) => p.id);
  changeProposalStatuses(approvedNow, 'approved');
  changeProposalStatuses(rejectedNow, 'rejected');
  persistMeeting().catch((err) => {
    meeting.error = `nao foi possivel salvar propostas: ${err.message}`;
    console.error('[agent-town] falha ao salvar propostas', err);
  });

  return { ok: true, meeting: publicMeeting(), started: false };
}

async function implementMeeting(ids = []) {
  if (runner.running) {
    return { ok: false, error: 'ja existe uma execucao rodando', meeting: publicMeeting(), started: false };
  }
  if (meeting.busy) {
    return { ok: false, error: 'aguarde a reuniao terminar antes de implementar', meeting: publicMeeting(), started: false };
  }
  if (meeting.active) {
    return { ok: false, error: 'encerre a reuniao antes de iniciar projetos', meeting: publicMeeting(), started: false };
  }
  if (!Array.isArray(ids) || ids.length !== 1) {
    return { ok: false, error: 'implemente uma proposta aprovada por projeto', meeting: publicMeeting() };
  }
  const approved = meeting.proposals.filter((p) => p.status === 'approved' && p.id === ids[0]);
  if (!approved.length) return { ok: false, error: 'a proposta selecionada nao esta aprovada', meeting: publicMeeting() };

  const task = composeTask(approved);
  implementationProposalIds = approved.map((p) => p.id);
  changeProposalStatuses(implementationProposalIds, 'implementing');
  meeting.active = false;
  const state = runner.start({ task, mode: 'project', projectPath: meeting.target, speed: 1 });
  await persistMeeting();
  return { ok: true, meeting: publicMeeting(), started: true, task, run: state };
}

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  res.write(
    `data: ${JSON.stringify({
      type: 'snapshot',
      events: history.slice(-150),
      state: { ...runner.getState(), mode: modeInfo.mode },
      meeting: publicMeeting(),
    })}\n\n`,
  );

  clients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignora */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const safe = path.normalize(rel).replace(/^[\\/]+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 — nao encontrado');
  }
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/events') return handleEvents(req, res);

    if (pathname === '/api/state') {
      return sendJson(res, {
        ...runner.getState(),
        mode: modeInfo.mode,
        problems: modeInfo.problems,
        meeting: publicMeeting(),
      });
    }

    // -- reuniao de melhoria --------------------------------------------------

    if (pathname === '/api/meeting' && req.method === 'GET') {
      return sendJson(res, publicMeeting());
    }

    if (pathname === '/api/meeting/start' && req.method === 'POST') {
      const body = await readJson(req);
      const result = startMeeting({ task: body.task || '' });
      return sendJson(res, result, result.ok ? 202 : 409);
    }

    if (pathname === '/api/meeting/stop' && req.method === 'POST') {
      return sendJson(res, stopMeeting());
    }

    if (pathname === '/api/meeting/decide' && req.method === 'POST') {
      const body = await readJson(req);
      const result = decideMeeting({ approve: body.approve, reject: body.reject, dismiss: body.dismiss });
      await persistence;
      return sendJson(res, result, result.ok ? 200 : 409);
    }

    if (pathname === '/api/meeting/implement' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await implementMeeting(body.ids);
      return sendJson(res, result, result.ok ? 202 : 409);
    }

    if (pathname === '/api/meeting/status' && req.method === 'POST') {
      const body = await readJson(req);
      const proposal = meeting.proposals.find((p) => p.id === body.id);
      if (!proposal) return sendJson(res, { error: 'proposta nao encontrada' }, 404);
      if (!['completed', 'archived'].includes(body.status)) {
        return sendJson(res, { error: 'status final invalido' }, 400);
      }
      if (body.status === 'completed' && proposal.status !== 'validating') {
        return sendJson(res, { error: 'somente propostas em validacao podem ser concluidas' }, 409);
      }
      changeProposalStatuses([proposal.id], body.status);
      await persistence;
      return sendJson(res, { ok: true, meeting: publicMeeting() });
    }

    if (pathname === '/api/run' && req.method === 'POST') {
      const body = await readJson(req);
      if (runner.running) return sendJson(res, { ...runner.getState(), mode: modeInfo.mode }, 409);
      if (meeting.busy) {
        return sendJson(
          res,
          { ...runner.getState(), mode: modeInfo.mode, error: 'a reuniao esta rodando; aguarde as propostas' },
          409,
        );
      }
      return sendJson(res, { ...runner.start(body), mode: modeInfo.mode });
    }

    if (pathname === '/api/stop' && req.method === 'POST') {
      return sendJson(res, { ...runner.stop(), mode: modeInfo.mode });
    }

    if (pathname === '/api/speed' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, { ...runner.setSpeed(body.speed), mode: modeInfo.mode });
    }

    // Lista as raízes de projeto autorizadas (para o seletor da UI).
    if (pathname === '/api/projects') {
      return sendJson(res, {
        roots: config.projectRoots,
        allowAny: config.allowAnyPath,
        templates: ['price-parser'],
        maxTasks: config.limits.maxTasks,
        agentsPerRole: config.limits.agentsPerRole,
        enabled: config.allowAnyPath || config.projectRoots.length > 0,
      });
    }

    // Agentes disponíveis: as instâncias internas + as do OpenCode.
    if (pathname === '/api/agents') {
      const projectPath = url.searchParams.get('project') || '';
      const oc = await loadOpenCodeAgents(projectPath || undefined);
      return sendJson(res, {
        instances: config.agents || [],
        perRole: config.limits.agentsPerRole,
        opencode: { agents: oc.agents, errors: oc.errors, dirs: oc.dirs },
      });
    }

    // Navegador de pastas para escolher o projeto sem digitar caminho.
    if (pathname === '/api/browse') {
      const target = url.searchParams.get('path') || '';
      const result = await browseDirectory(target, {
        allowAny: config.allowAnyPath,
        allowedRoots: config.projectRoots,
      });
      return sendJson(res, result, result.ok ? 200 : 400);
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[agent-town] erro na requisicao', pathname, err);
    if (!res.headersSent) sendJson(res, { error: String(err) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  const real = modeInfo.mode === 'real';
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  agent-town · observatorio de agentes       │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log(`   http://${HOST}:${PORT}`);
  console.log('');
  console.log(`   modo: ${modeInfo.label}`);
  if (real) {
    for (const [roleId, role] of Object.entries(config.roles)) {
      console.log(`     ${role.name.padEnd(11)} ${role.modelRef?.ref || '(invalido)'}`);
    }
    console.log('');
    console.log(`   limites: ${config.limits.maxSteps} passos · ${config.limits.maxTokens} tokens · ${config.limits.timeoutSec}s`);
  }
  for (const w of modeInfo.warnings) console.log(`   ! ${w}`);
  console.log('');
  if (config.allowAnyPath) {
    console.log('   modo projeto: qualquer pasta (servidor local)');
  } else if (config.projectRoots.length) {
    console.log(`   modo projeto: limitado a ${config.projectRoots.join(', ')}`);
  } else {
    console.log('   modo projeto: DESABILITADO (servidor exposto sem PROJECT_ROOTS)');
  }
  console.log('');
  console.log('   Clique em "Iniciar" na tela.');
  console.log('   Ctrl+C encerra o servidor.');
  console.log('');
});

process.on('SIGINT', () => {
  runner.stop?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
