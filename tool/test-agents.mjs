// Testes das múltiplas instâncias de agente e da importação do OpenCode.
// Sem rede: usa provedores falsos e arquivos temporários.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildAgentInstances, executorIds } from '../src/config.mjs';
import { buildPlannerPrompt } from '../src/planner.mjs';
import { createWriteGuard } from '../src/tools.mjs';
import { parseFrontmatter, toAgent, toolsFromPermissions, loadOpenCodeAgents } from '../src/opencode.mjs';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// ===========================================================================
// 1. buildAgentInstances
// ===========================================================================
{
  const roles = {
    planner: { id: 'planner', name: 'Planner', role: 'Orquestrador', modelRef: { providerKey: 'verboo', model: 'a' } },
    researcher: { id: 'researcher', name: 'Researcher', role: 'Pesquisa', modelRef: { providerKey: 'verboo', model: 'b' } },
    coder: { id: 'coder', name: 'Coder', role: 'Impl', modelRef: { providerKey: 'verboo', model: 'c' } },
    reviewer: { id: 'reviewer', name: 'Reviewer', role: 'Revisao', modelRef: { providerKey: 'verboo', model: 'd' } },
  };

  const two = buildAgentInstances(roles, 2);
  const ids = two.map((a) => a.id);

  expect(ids.includes('planner'), 'deveria existir um planner');
  expect(ids.filter((i) => i === 'planner').length === 1, 'planner NAO pode ser duplicado');
  expect(ids.includes('coder-1') && ids.includes('coder-2'), `coder deveria ter 2 instancias: ${ids}`);
  expect(ids.includes('researcher-1') && ids.includes('reviewer-2'), `faltou instancia: ${ids}`);
  expect(two.length === 7, `com 2 por papel deveriam ser 7 agentes, veio ${two.length}`);

  const coder2 = two.find((a) => a.id === 'coder-2');
  expect(coder2.role === 'coder', 'coder-2 deveria ter role coder');
  expect(coder2.index === 1, 'coder-2 deveria ter index 1');
  expect(coder2.name === 'Coder 2', `nome deveria distinguir: ${coder2.name}`);

  // uma instância por papel: id limpo, sem sufixo
  const one = buildAgentInstances(roles, 1);
  const oneIds = one.map((a) => a.id);
  expect(oneIds.includes('coder') && !oneIds.includes('coder-1'), `com 1 por papel o id fica limpo: ${oneIds}`);
  expect(one.length === 4, `com 1 por papel deveriam ser 4 agentes: ${one.length}`);
}

// ===========================================================================
// 2. executorIds aceita instância e papel
// ===========================================================================
{
  const roles = {
    planner: { id: 'planner', name: 'P', role: 'O', modelRef: { providerKey: 'v', model: 'a' } },
    coder: { id: 'coder', name: 'C', role: 'I', modelRef: { providerKey: 'v', model: 'c' } },
  };
  const agents = buildAgentInstances(roles, 2);
  const allowed = executorIds(agents);

  expect(allowed.includes('coder-1'), 'ids de instancia deveriam ser aceitos');
  expect(allowed.includes('coder'), 'o papel generico deveria ser aceito');
  expect(!allowed.includes('planner'), 'planner nao pode receber tarefa');
}

// ===========================================================================
// 3. Prompt do Planner conhece as instâncias
// ===========================================================================
{
  const agents = [
    { id: 'planner', role: 'planner' },
    { id: 'coder-1', role: 'coder' },
    { id: 'coder-2', role: 'coder' },
    { id: 'reviewer-1', role: 'reviewer' },
    { id: 'reviewer-2', role: 'reviewer' },
  ];

  const prompt = buildPlannerPrompt(agents);
  expect(prompt.includes('coder-1') && prompt.includes('coder-2'), 'o prompt deveria listar as instancias');
  expect(/2 instancias por funcao|instancias por funcao/.test(prompt), 'deveria avisar a capacidade');
  expect(/NUNCA coloque duas tarefas que alteram o MESMO arquivo/.test(prompt), 'deveria proibir conflito de arquivo');

  // com uma instância só, não deve falar de instâncias
  const single = buildPlannerPrompt([
    { id: 'planner', role: 'planner' },
    { id: 'coder', role: 'coder' },
  ]);
  expect(!single.includes('coder-1'), 'com 1 por papel nao deveria citar coder-1');
}

// ===========================================================================
// 4. Guarda de conflito de escrita
// ===========================================================================
{
  const guard = createWriteGuard();

  expect(guard.claim('src/a.mjs', 'coder-1').ok, 'primeiro dono deveria entrar');
  expect(guard.claim('src/a.mjs', 'coder-1').ok, 'o dono pode reescrever o proprio arquivo');

  const blocked = guard.claim('src/a.mjs', 'coder-2');
  expect(blocked.ok === false, 'segunda instancia NAO pode escrever o mesmo arquivo');
  expect(blocked.owner === 'coder-1', `deveria apontar o dono: ${blocked.owner}`);

  expect(guard.claim('src/b.mjs', 'coder-2').ok, 'arquivo diferente deveria ser livre');
  expect(guard.ownerOf('src/a.mjs') === 'coder-1', 'ownerOf deveria devolver o dono');
  expect(Object.keys(guard.snapshot()).length === 2, 'snapshot deveria listar os dois arquivos');
}

// ===========================================================================
// 5. Frontmatter do OpenCode
// ===========================================================================
{
  const sample = `---
description: Writes and maintains project documentation
mode: subagent
model: verboo:deepseek-v4.1-flash
permission:
  edit: deny
  shell: ask
---

You are a technical writer.
`;

  const { meta, body, hadFrontmatter } = parseFrontmatter(sample);
  expect(hadFrontmatter, 'deveria reconhecer o frontmatter');
  expect(meta.description === 'Writes and maintains project documentation', `description: ${meta.description}`);
  expect(meta.mode === 'subagent', `mode: ${meta.mode}`);
  expect(meta.permission?.edit === 'deny', `permission.edit: ${meta.permission?.edit}`);
  expect(body.trim().startsWith('You are a technical writer'), 'o corpo deveria vir separado');

  // sem frontmatter: tudo é corpo
  const plain = parseFrontmatter('Just a prompt.');
  expect(plain.hadFrontmatter === false && plain.body === 'Just a prompt.', 'sem frontmatter deveria passar direto');

  // CRLF
  const crlf = parseFrontmatter('---\r\ndescription: X\r\n---\r\nBody\r\n');
  expect(crlf.meta.description === 'X', 'deveria lidar com CRLF');
}

// ===========================================================================
// 6. Permissões -> ferramentas
// ===========================================================================
{
  expect(
    JSON.stringify(toolsFromPermissions({ permission: { edit: 'deny' } })) ===
      JSON.stringify(['list_files', 'read_file']),
    'edit deny deveria virar somente leitura',
  );
  expect(
    toolsFromPermissions({ permission: { edit: 'allow' } }).includes('write_file'),
    'edit allow deveria permitir escrita',
  );
  expect(
    toolsFromPermissions({ tools: { write: false } }).includes('write_file') === false,
    'tools.write=false deveria bloquear escrita',
  );
  expect(
    toolsFromPermissions({}).includes('write_file'),
    'sem permissao declarada, o padrao do OpenCode (build) permite escrita',
  );
}

// ===========================================================================
// 7. toAgent
// ===========================================================================
{
  const agent = toAgent(
    'docs-writer',
    `---
description: Writes documentation
mode: subagent
permission:
  edit: deny
---
You are a technical writer.`,
    '/tmp/docs-writer.md',
  );

  expect(agent?.id === 'docs-writer', 'id deveria vir do nome do arquivo');
  expect(agent.canEdit === false, 'edit deny deveria marcar canEdit=false');
  expect(agent.prompt.includes('technical writer'), 'o prompt deveria ser o corpo');
  expect(agent.toolNames.includes('write_file') === false, 'nao deveria ter write_file');

  // corpo vazio -> null
  expect(toAgent('vazio', '---\ndescription: X\n---\n') === null, 'agente sem instrucoes deveria ser rejeitado');
}

// ===========================================================================
// 8. loadOpenCodeAgents lê do disco
// ===========================================================================
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-'));
  const agentDir = path.join(dir, '.opencode', 'agent');
  await mkdir(agentDir, { recursive: true });

  await writeFile(
    path.join(agentDir, 'docs.md'),
    '---\ndescription: Documentacao\npermission:\n  edit: deny\n---\nVoce escreve documentacao.',
    'utf8',
  );
  await writeFile(
    path.join(agentDir, 'tester.md'),
    '---\ndescription: Testes\n---\nVoce escreve testes.',
    'utf8',
  );
  await writeFile(path.join(agentDir, 'vazio.md'), '---\ndescription: Vazio\n---\n', 'utf8');
  await writeFile(path.join(agentDir, 'ignorar.txt'), 'nao e markdown', 'utf8');

  const result = await loadOpenCodeAgents(dir);
  const ids = result.agents.map((a) => a.id);

  expect(ids.includes('docs') && ids.includes('tester'), `deveria carregar os .md: ${ids}`);
  expect(!ids.includes('vazio'), 'arquivo sem corpo nao deveria virar agente');
  expect(!ids.includes('ignorar'), 'arquivo .txt deveria ser ignorado');
  expect(result.errors.length === 1, `deveria reportar 1 problema: ${result.errors}`);

  await rm(dir, { recursive: true, force: true });
}

// ===========================================================================
if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — instancias por funcao, guarda de escrita e agentes do OpenCode');
}
