// Confere que a tarefa do template é realmente resolvível.
//
// Se este teste falhar, o Coder não tem como passar — e você descobriria isso
// gastando tokens. Roda a solução de referência contra os testes reais.

import { mkdtemp, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates', 'price-parser');

const REFERENCE = `export function parsePrice(input) {
  if (input === null || input === undefined) throw new Error('entrada vazia');

  const raw = String(input).trim();
  if (!raw) throw new Error('entrada vazia');

  // remove simbolo de moeda e espacos
  const cleaned = raw.replace(/^(R\\$|US\\$|\\$)\\s*/i, '').replace(/\\s/g, '');
  if (!/\\d/.test(cleaned)) throw new Error('sem digitos');

  let normalized;

  if (cleaned.includes(',')) {
    // formato brasileiro: ponto = milhar, virgula = decimal
    normalized = cleaned.replace(/\\./g, '').replace(',', '.');
  } else {
    const dots = (cleaned.match(/\\./g) || []).length;
    if (dots === 0) {
      normalized = cleaned;
    } else if (dots === 1) {
      const [a, b] = cleaned.split('.');
      // "1.234" (3 casas) tende a ser milhar; "12.50" e decimal
      normalized = b.length === 3 && a.length <= 3 ? a + b : cleaned;
    } else {
      normalized = cleaned.replace(/\\./g, '');
    }
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error('valor invalido');

  return Math.round(value * 100);
}
`;

function runProcess({ command, args, cwd, logPath, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, 'w');
    let settled = false;
    let child;

    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        /* noop */
      }
      let output = '';
      try {
        output = readFileSync(logPath, 'utf8');
      } catch {
        /* noop */
      }
      resolve({ code, output: output + extra });
    };

    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* noop */
      }
      finish(-1, `\n[timeout ${timeoutMs}ms]`);
    }, timeoutMs);

    child = spawn(command, args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true });
    child.on('error', (err) => finish(-1, `\n${err.message}`));
    child.on('close', (code) => finish(code ?? -1));
  });
}

const problems = [];

// --- 1. template tem os arquivos esperados ---------------------------------
for (const rel of ['SPEC.md', 'src/price.mjs', 'test/price.test.mjs']) {
  try {
    await readFile(path.join(TEMPLATE, rel), 'utf8');
  } catch {
    problems.push(`template sem ${rel}`);
  }
}

// --- 2. sem solucao, os testes DEVEM falhar --------------------------------
const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-verify-'));
const work = path.join(dir, 'workspace');
await cp(TEMPLATE, work, { recursive: true });

const logPath = path.join(dir, 'test.log');

// arquivos de teste explicitos (o mesmo criterio usado por src/tools.mjs)
const testDir = path.join(work, 'test');
const testFiles = (await readdir(testDir))
  .filter((f) => /\.(test|spec)\.[cm]?js$/.test(f))
  .map((f) => `test/${f}`)
  .sort();

if (!testFiles.length) problems.push('nenhum arquivo de teste encontrado no template');

const runTests = () =>
  runProcess({ command: process.execPath, args: ['--test', ...testFiles], cwd: work, logPath });

const before = await runTests();

if (before.code === 0) {
  problems.push('os testes passam SEM implementacao — a tarefa nao tem desafio');
}

// --- 3. com a solucao de referencia, os testes DEVEM passar ----------------
await writeFile(path.join(work, 'src', 'price.mjs'), REFERENCE, 'utf8');
const after = await runTests();

if (after.code !== 0) {
  problems.push('a solucao de referencia NAO passa nos testes');
  console.error(after.output.split('\n').slice(-30).join('\n'));
}

await rm(dir, { recursive: true, force: true });

console.log(`stub falha (esperado): ${before.code !== 0 ? 'sim' : 'NAO'}`);
console.log(`referencia passa: ${after.code === 0 ? 'sim' : 'NAO'}`);

if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — a tarefa do template e resolvivel');
}
