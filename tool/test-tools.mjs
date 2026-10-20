// Testes das ferramentas dos agentes, com foco em SEGURANÇA.
//
// O ponto crítico: um agente não pode escrever fora do workspace da execução,
// nem com "../", nem com caminho absoluto, nem com symlink.

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeResolve, createTools } from '../src/tools.mjs';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-town-tools-'));
const root = path.join(dir, 'workspace');
const tmp = path.join(dir, '.tmp');
await mkdir(root, { recursive: true });
await mkdir(tmp, { recursive: true });

// --- safeResolve -----------------------------------------------------------
const escapes = [
  '../fora.txt',
  '../../fora.txt',
  'a/../../fora.txt',
  '..\\fora.txt',
  '/etc/passwd',
  'C:\\Windows\\win.ini',
  'C:/Windows/win.ini',
];

for (const rel of escapes) {
  let blocked = false;
  try {
    const full = safeResolve(root, rel);
    // se resolveu, precisa continuar dentro da raiz
    const normalized = path.resolve(full);
    blocked = !normalized.startsWith(path.resolve(root) + path.sep) && normalized !== path.resolve(root);
    if (!blocked) problems.push(`safeResolve NAO bloqueou: ${rel} -> ${full}`);
  } catch {
    blocked = true;
  }
  expect(blocked, `safeResolve deveria bloquear "${rel}"`);
}

// caminhos legítimos continuam funcionando
for (const rel of ['src/price.mjs', './SPEC.md', 'test/a/b/c.mjs']) {
  try {
    const full = safeResolve(root, rel);
    expect(path.resolve(full).startsWith(path.resolve(root)), `safeResolve quebrou caminho legitimo: ${rel}`);
  } catch {
    problems.push(`safeResolve rejeitou caminho legitimo: ${rel}`);
  }
}

// --- ferramentas -----------------------------------------------------------
const tools = createTools(root, tmp);

const w = await tools.execute('write_file', { path: 'src/price.mjs', content: 'export const x = 1;\n' });
expect(w.ok, 'write_file deveria criar src/price.mjs');
expect((await readFile(path.join(root, 'src/price.mjs'), 'utf8')).includes('export const x'), 'write_file nao gravou');

const w2 = await tools.execute('write_file', { path: 'src/price.mjs', content: 'export const x = 2;\n' });
expect(w2.summary === 'arquivo atualizado', 'write_file deveria detectar atualizacao');

const r = await tools.execute('read_file', { path: 'src/price.mjs' });
expect(r.ok && r.output.includes('x = 2'), 'read_file devolveu conteudo errado');

const l = await tools.execute('list_files', {});
expect(l.ok && l.output.includes('src/price.mjs'), 'list_files nao listou o arquivo');

// escrita fora da raiz deve falhar
const evil = await tools.execute('write_file', { path: '../../invasao.txt', content: 'x' });
expect(!evil.ok, 'write_file deveria RECUSAR escrita fora do workspace');

// leitura de arquivo inexistente
const missing = await tools.execute('read_file', { path: 'nao-existe.txt' });
expect(!missing.ok, 'read_file deveria falhar em arquivo inexistente');

// ferramenta desconhecida
const unknown = await tools.execute('rm_rf', {});
expect(!unknown.ok, 'ferramenta desconhecida deveria falhar');

// run_tests sem pasta test/
const noTests = await tools.execute('run_tests', {});
expect(!noTests.ok, 'run_tests deveria falhar sem pasta test/');

// run_tests de verdade: teste que passa
await mkdir(path.join(root, 'test'), { recursive: true });
await writeFile(path.join(root, 'test', 'ok.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n`, 'utf8');

const pass = await tools.execute('run_tests', {});
expect(pass.ok, `run_tests deveria passar (saiu: ${pass.summary})`);

// run_tests com falha
await writeFile(path.join(root, 'test', 'fail.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('falha', () => assert.equal(1, 2));\n`, 'utf8');

const fail = await tools.execute('run_tests', {});
expect(!fail.ok, 'run_tests deveria falhar com teste vermelho');

// o log temporario nao pode sobrar no workspace
const leftovers = (await tools.execute('list_files', {})).output.split('\n').filter((f) => f.includes('.log'));
expect(leftovers.length === 0, `vazou arquivo de log no workspace: ${leftovers.join(', ')}`);

await rm(dir, { recursive: true, force: true });

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — ferramentas seguras e funcionais (sandbox, leitura, escrita, testes)');
}
