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
import { browseDirectory } from './src/project.mjs';

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
      return sendJson(res, { ...runner.getState(), mode: modeInfo.mode, problems: modeInfo.problems });
    }

    if (pathname === '/api/run' && req.method === 'POST') {
      const body = await readJson(req);
      if (runner.running) return sendJson(res, { ...runner.getState(), mode: modeInfo.mode }, 409);
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
        enabled: config.allowAnyPath || config.projectRoots.length > 0,
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
