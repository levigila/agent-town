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

// --- releitura nao devolve o conteudo de novo ------------------------------
{
  // arquivo novo e grande: os anteriores já estão no cache de leitura
  const bigContent = `CONTEUDO-UNICO-XYZ\n${'linha de enchimento para simular um arquivo real\n'.repeat(40)}`;
  await tools.execute('write_file', { path: 'src/dedupe.txt', content: bigContent });

  const first = await tools.execute('read_file', { path: 'src/dedupe.txt' });
  expect(first.ok && first.output.includes('CONTEUDO-UNICO-XYZ'), 'primeira leitura deveria trazer o conteudo');

  const second = await tools.execute('read_file', { path: 'src/dedupe.txt' });
  expect(second.ok, 'segunda leitura deveria continuar ok');
  expect(second.output.length < first.output.length, 'releitura deveria ser mais curta que a original');
  expect(second.summary.includes('ja lido'), `summary deveria indicar releitura: ${second.summary}`);
  expect(!second.output.includes('CONTEUDO-UNICO-XYZ'), 'releitura NAO deveria repetir o conteudo');

  // outro escopo (outro agente) precisa receber o conteudo de novo
  const otherAgent = await tools.execute('read_file', { path: 'src/dedupe.txt' }, 'coder:2');
  expect(
    otherAgent.output.includes('CONTEUDO-UNICO-XYZ'),
    'outro agente DEVE receber o conteudo (cache e por conversa, nao global)',
  );
}

// --- sem test/ nem script, run_tests explica em vez de so falhar -----------
{
  const bare = path.join(dir, 'bare');
  await mkdir(bare, { recursive: true });
  const bareTools = createTools(bare, tmp);

  const r = await bareTools.execute('run_tests', {});
  expect(!r.ok, 'projeto sem testes deveria retornar ok=false');
  expect(String(r.summary).includes('sem testes'), `summary deveria dizer que nao ha testes: ${r.summary}`);
  expect(
    String(r.output).includes('NAO pode validar'),
    'a saida deveria avisar que nao da para validar por testes',
  );
}

// --- script "test" do package.json e usado como fallback -------------------
{
  const withPkg = path.join(dir, 'with-pkg');
  await mkdir(withPkg, { recursive: true });
  await writeFile(
    path.join(withPkg, 'package.json'),
    JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }),
    'utf8',
  );

  const pkgTools = createTools(withPkg, tmp);
  const r = await pkgTools.execute('run_tests', {});
  expect(r.ok, `npm test deveria ser usado como fallback: ${r.summary}`);
  expect(String(r.summary).includes('npm test'), `summary deveria citar npm test: ${r.summary}`);
}

// --- package.json com script que falha -------------------------------------
{
  const failing = path.join(dir, 'pkg-fail');
  await mkdir(failing, { recursive: true });
  await writeFile(
    path.join(failing, 'package.json'),
    JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(1)"' } }),
    'utf8',
  );

  const failTools = createTools(failing, tmp);
  const r = await failTools.execute('run_tests', {});
  expect(!r.ok, 'npm test com falha deveria retornar ok=false');
}

// --- write_file: argumentos faltando e modo append ------------------------
{
  const noArgs = await tools.execute('write_file', {});
  expect(!noArgs.ok, 'write_file sem argumentos deveria falhar');
  expect(
    String(noArgs.output).includes('cortada') || String(noArgs.summary).includes('path'),
    `o erro deveria explicar a falta de path/truncamento: ${noArgs.summary} / ${noArgs.output}`,
  );

  const noContent = await tools.execute('write_file', { path: 'src/partes.txt' });
  expect(!noContent.ok, 'write_file sem content deveria falhar');

  // cria, depois acrescenta em partes
  const create = await tools.execute('write_file', { path: 'src/partes.txt', content: 'AAAA\n' });
  expect(create.ok, 'write_file deveria criar o arquivo');

  const add1 = await tools.execute('write_file', { path: 'src/partes.txt', content: 'BBBB\n', append: true });
  const add2 = await tools.execute('write_file', { path: 'src/partes.txt', content: 'CCCC\n', append: true });
  expect(add1.ok && add2.ok, 'append deveria funcionar em sequencia');
  expect(add1.summary.includes('acrescentado'), `summary deveria indicar append: ${add1.summary}`);

  const full = await readFile(path.join(root, 'src', 'partes.txt'), 'utf8');
  expect(full === 'AAAA\nBBBB\nCCCC\n', `append deveria concatenar na ordem: ${JSON.stringify(full)}`);

  // sem append, substitui
  await tools.execute('write_file', { path: 'src/partes.txt', content: 'NOVO\n' });
  const replaced = await readFile(path.join(root, 'src', 'partes.txt'), 'utf8');
  expect(replaced === 'NOVO\n', 'sem append deveria substituir o conteudo');
}

await rm(dir, { recursive: true, force: true });

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — ferramentas: sandbox, releitura, runner e fallback de testes');
}
