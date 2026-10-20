// Testes do modo projeto: autorização de caminho, navegador de pastas,
// .agent-town.json e ferramentas plugáveis.
//
// O ponto crítico é a autorização. Duas políticas:
//   - servidor local (allowAny): qualquer pasta, você escolhe na hora
//   - servidor exposto: allowlist PROJECT_ROOTS obrigatória

import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveProjectPath,
  loadProjectConfig,
  projectContext,
  browseDirectory,
  DEFAULT_PROJECT_CONFIG,
} from '../src/project.mjs';
import { createTools } from '../src/tools.mjs';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

const root = await mkdtemp(path.join(os.tmpdir(), 'agent-town-proj-'));
const allowed = path.join(root, 'permitido');
const blocked = path.join(root, 'bloqueado');
const tmpDir = path.join(root, '.tmp');

await mkdir(allowed, { recursive: true });
await mkdir(blocked, { recursive: true });
await mkdir(tmpDir, { recursive: true });

// =========================================================== resolveProjectPath

{
  const r = resolveProjectPath(allowed, [allowed]);
  expect(r.ok, 'caminho exato permitido deveria passar');
}

{
  const sub = path.join(allowed, 'sub', 'pasta');
  const r = resolveProjectPath(sub, [allowed]);
  expect(r.ok, 'subpasta da raiz permitida deveria passar');
}

{
  const r = resolveProjectPath(blocked, [allowed]);
  expect(!r.ok, 'caminho fora da raiz deveria ser recusado');
}

{
  const r = resolveProjectPath(allowed, []);
  expect(!r.ok, 'sem raizes configuradas deveria recusar tudo');
  expect(String(r.error).includes('PROJECT_ROOTS'), 'o erro deveria citar PROJECT_ROOTS');
}

// --- allowAny: servidor local escolhe qualquer pasta -----------------------
{
  const r = resolveProjectPath(blocked, [], { allowAny: true });
  expect(r.ok, 'com allowAny, qualquer pasta deveria passar');
}

{
  const r = resolveProjectPath('C:\\Windows\\System32', [], { allowAny: true });
  expect(r.ok, 'com allowAny, caminho absoluto do sistema deveria passar (servidor local)');
}

{
  const r = resolveProjectPath('   ', [], { allowAny: true });
  expect(!r.ok, 'caminho vazio continua recusado mesmo com allowAny');
}

// aspas e barra final são toleradas
{
  const withQuotes = `"${blocked}\\"`;
  const r = resolveProjectPath(withQuotes, [], { allowAny: true });
  expect(r.ok, `caminho com aspas/barra deveria normalizar: ${r.error || ''}`);
  expect(r.path === path.resolve(blocked), `normalizacao errada: ${r.path}`);
}

// allowAny=false (padrão) mantém o comportamento de allowlist
{
  const r = resolveProjectPath(blocked, [allowed], { allowAny: false });
  expect(!r.ok, 'sem allowAny, a allowlist continua valendo');
}

{
  const r = resolveProjectPath('', [allowed]);
  expect(!r.ok, 'caminho vazio deveria ser recusado');
}

// tentativa de escapar com ..
{
  const r = resolveProjectPath(path.join(allowed, '..', 'bloqueado'), [allowed]);
  expect(!r.ok, 'escape com .. deveria ser recusado');
}

// prefixo parecido não pode passar (C:\proj vs C:\projeto)
{
  const r = resolveProjectPath(allowed + '-outro', [allowed]);
  expect(!r.ok, 'prefixo parecido deveria ser recusado');
}

// Windows: caminho absoluto de outro drive
if (process.platform === 'win32') {
  const r = resolveProjectPath('C:\\Windows\\System32', [allowed]);
  expect(!r.ok, 'C:\\Windows deveria ser recusado');
}

// múltiplas raízes
{
  const r = resolveProjectPath(blocked, [allowed, blocked]);
  expect(r.ok, 'segunda raiz permitida deveria funcionar');
}

// =========================================================== loadProjectConfig

{
  const cfg = await loadProjectConfig(allowed);
  expect(cfg.source === 'default', 'sem arquivo deveria usar o padrao');
  expect(cfg.testCommand === null, 'sem arquivo, testCommand deveria ser null');
  expect(cfg.testCommand === DEFAULT_PROJECT_CONFIG.testCommand, 'deveria espelhar o padrao');
}

// arquivo válido
{
  await writeFile(
    path.join(allowed, '.agent-town.json'),
    JSON.stringify({ testCommand: ['npm', 'test'], ignore: ['coverage/'], maxSteps: 5 }),
    'utf8',
  );
  const cfg = await loadProjectConfig(allowed);
  expect(cfg.source === '.agent-town.json', 'deveria ler o arquivo');
  expect(cfg.testCommand?.join(' ') === 'npm test', 'testCommand deveria ser lido');
  expect(cfg.ignore?.includes('coverage/'), 'ignore deveria ser lido');
  expect(cfg.maxSteps === 5, 'maxSteps deveria ser lido');
}

// arquivo inválido não pode quebrar
{
  await writeFile(path.join(allowed, '.agent-town.json'), '{ isso nao e json', 'utf8');
  const cfg = await loadProjectConfig(allowed);
  expect(cfg.source.startsWith('default'), 'arquivo invalido deveria cair no padrao');
  expect(cfg.testCommand === null, 'arquivo invalido nao deveria produzir comando');
}

// =========================================================== projectContext

{
  await writeFile(path.join(allowed, '.agent-town.json'), '{}', 'utf8');
  await mkdir(path.join(allowed, 'src'), { recursive: true });
  await writeFile(path.join(allowed, 'src', 'a.mjs'), 'x', 'utf8');
  await writeFile(path.join(allowed, 'README.md'), 'x', 'utf8');
  await mkdir(path.join(allowed, 'node_modules'), { recursive: true });
  await writeFile(path.join(allowed, 'node_modules', 'lixo.js'), 'x', 'utf8');

  const ctx = await projectContext(allowed);
  expect(ctx.tree.includes('src/'), 'deveria listar pastas');
  expect(ctx.tree.includes('src/a.mjs'), 'deveria listar arquivos');
  expect(!ctx.tree.includes('node_modules'), 'deveria ignorar node_modules');
  expect(!ctx.tree.includes('.agent-town.json'), 'nao deveria listar o proprio config oculto');
}

// =========================================================== ferramentas plugáveis

{
  // projeto com "npm test" falso: comando que apenas imprime e sai com 0
  const projDir = path.join(root, 'com-comando');
  await mkdir(projDir, { recursive: true });
  await writeFile(
    path.join(projDir, '.agent-town.json'),
    JSON.stringify({ testCommand: [process.execPath, '-e', 'console.log("suite custom ok"); process.exit(0)'] }),
    'utf8',
  );

  const cfg = await loadProjectConfig(projDir);
  const tools = createTools(projDir, tmpDir, { testCommand: cfg.testCommand });
  const r = await tools.execute('run_tests', {});

  expect(r.ok, `comando custom deveria passar, veio: ${r.summary}`);
  expect(r.summary.includes('passou'), `summary deveria indicar sucesso: ${r.summary}`);
}

{
  // comando que falha
  const projDir = path.join(root, 'comando-falha');
  await mkdir(projDir, { recursive: true });
  const tools = createTools(projDir, tmpDir, {
    testCommand: [process.execPath, '-e', 'console.error("boom"); process.exit(3)'],
  });
  const r = await tools.execute('run_tests', {});
  expect(!r.ok, 'comando que falha deveria retornar ok=false');
  expect(r.summary.includes('falhou'), `summary deveria indicar falha: ${r.summary}`);
}

{
  // ignore configurado esconde arquivos do list_files
  const projDir = path.join(root, 'com-ignore');
  await mkdir(path.join(projDir, 'coverage'), { recursive: true });
  await mkdir(path.join(projDir, 'src'), { recursive: true });
  await writeFile(path.join(projDir, 'coverage', 'relatorio.html'), 'x', 'utf8');
  await writeFile(path.join(projDir, 'src', 'b.mjs'), 'x', 'utf8');

  const tools = createTools(projDir, tmpDir, { ignore: ['coverage/'] });
  const r = await tools.execute('list_files', {});
  expect(r.output.includes('src/b.mjs'), 'deveria listar src');
  expect(!r.output.includes('coverage'), 'ignore deveria esconder coverage');
}

{
  // sem comando configurado, cai no runner do Node
  const projDir = path.join(root, 'node-runner');
  await mkdir(path.join(projDir, 'test'), { recursive: true });
  await writeFile(
    path.join(projDir, 'test', 'x.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n`,
    'utf8',
  );
  const tools = createTools(projDir, tmpDir);
  const r = await tools.execute('run_tests', {});
  expect(r.ok, `runner padrao deveria passar: ${r.summary}`);
  expect(r.summary.includes('1'), `summary deveria contar os testes: ${r.summary}`);
}

// =========================================================== browseDirectory

{
  // monta uma árvore: com-git/ (repo), sem-git/, node_modules/
  const browseRoot = path.join(root, 'browse');
  await mkdir(path.join(browseRoot, 'com-git', '.git'), { recursive: true });
  await mkdir(path.join(browseRoot, 'sem-git'), { recursive: true });
  await mkdir(path.join(browseRoot, 'node_modules'), { recursive: true });
  await writeFile(path.join(browseRoot, 'arquivo.txt'), 'x', 'utf8');

  const r = await browseDirectory(browseRoot, { allowAny: true });
  expect(r.ok, `browse deveria funcionar: ${r.error || ''}`);
  expect(r.path === path.resolve(browseRoot), 'browse deveria devolver o caminho resolvido');

  const names = r.entries.map((e) => e.name);
  expect(names.includes('com-git'), 'deveria listar com-git');
  expect(names.includes('sem-git'), 'deveria listar sem-git');
  expect(!names.includes('node_modules'), 'deveria esconder node_modules');
  expect(!names.includes('arquivo.txt'), 'deveria listar apenas pastas');

  const repo = r.entries.find((e) => e.name === 'com-git');
  expect(repo?.isRepo === true, 'deveria marcar com-git como repositorio');
  const plain = r.entries.find((e) => e.name === 'sem-git');
  expect(plain?.isRepo === false, 'sem-git nao deveria ser marcado como repositorio');

  // repos primeiro na ordenação
  expect(r.entries[0].isRepo === true, 'repositorios deveriam vir primeiro');

  // pasta pai existe
  expect(r.parent === path.dirname(path.resolve(browseRoot)), 'parent deveria apontar para cima');
}

{
  // caminho inexistente devolve erro tratado
  const r = await browseDirectory(path.join(root, 'nao-existe-mesmo'), { allowAny: true });
  expect(!r.ok, 'pasta inexistente deveria falhar');
  expect(String(r.error).length > 0, 'deveria explicar o erro');
}

{
  // sem allowAny e fora da allowlist: recusa
  const r = await browseDirectory(root, { allowAny: false, allowedRoots: [allowed] });
  expect(!r.ok, 'browse fora da allowlist deveria ser recusado');
}

{
  // caminho vazio começa no home do usuário
  const r = await browseDirectory('', { allowAny: true });
  expect(r.ok, 'browse sem caminho deveria usar o home');
  expect(r.path === path.resolve(os.homedir()), 'deveria começar no home');
}

await rm(root, { recursive: true, force: true });

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — modo projeto: allowlist/allowAny, navegador de pastas, config e ferramentas');
}
