// Testes do grafo de tarefas: parsing, validação e ordenação em ondas.
//
// Esta é a fronteira onde o texto livre do modelo vira execução.
// Um bug aqui significa: tarefa perdida, ciclo infinito ou ordem errada.

import { extractJson, validatePlan, topoWaves, buildPlan, toTaskList } from '../src/graph.mjs';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// ---------------------------------------------------------------- extractJson

const jsonCases = [
  ['JSON puro', '{"tasks":[]}', true],
  ['cercado por ```json', '```json\n{"tasks":[]}\n```', true],
  ['cercado por ```', '```\n{"tasks":[]}\n```', true],
  ['texto antes e depois', 'Claro! Aqui:\n{"tasks":[]}\nEspero ter ajudado.', true],
  ['array direto', '[{"id":"t1"}]', true],
  ['string aninhada com chaves', '{"tasks":[{"instruction":"use { e } no regex"}]}', true],
  ['sem JSON', 'nao tenho plano', false],
  ['JSON quebrado', '{"tasks":[}', false],
];

for (const [label, input, shouldWork] of jsonCases) {
  const out = extractJson(input);
  if (shouldWork) {
    expect(out !== null, `extractJson falhou em: ${label}`);
  } else {
    expect(out === null, `extractJson deveria falhar em: ${label}`);
  }
}

// chaves dentro de string não podem quebrar o balanceamento
{
  const tricky = '{"tasks":[{"id":"t1","instruction":"regex /{a}/ e {b}"}]}';
  const parsed = extractJson(tricky);
  expect(parsed?.tasks?.[0]?.instruction === 'regex /{a}/ e {b}', 'extractJson quebrou com chaves em string');
}

// ---------------------------------------------------------------- toTaskList

expect(toTaskList({ tasks: [1] })?.length === 1, 'toTaskList: chave "tasks"');
expect(toTaskList({ tarefas: [1] })?.length === 1, 'toTaskList: chave "tarefas"');
expect(toTaskList([1, 2])?.length === 2, 'toTaskList: array direto');
expect(toTaskList({ nada: 1 }) === null, 'toTaskList: sem lista deveria ser null');

// ---------------------------------------------------------------- validatePlan

const validPlan = {
  tasks: [
    { id: 't1', agent: 'researcher', instruction: 'mapear o codigo', depends_on: [] },
    { id: 't2', agent: 'coder', instruction: 'implementar', depends_on: ['t1'] },
    { id: 't3', agent: 'reviewer', instruction: 'revisar', depends_on: ['t2'] },
  ],
};

{
  const r = validatePlan(validPlan);
  expect(r.ok, `plano valido foi rejeitado: ${r.problems.join('; ')}`);
  expect(r.tasks.length === 3, 'plano valido deveria ter 3 tarefas');
  expect(r.tasks[1].dependsOn[0] === 't1', 'dependsOn nao normalizado');
}

// campos em portugues
{
  const r = validatePlan({
    tarefas: [{ id: 'a', agente: 'coder', instrucao: 'fazer', depende_de: [] }],
  });
  expect(r.ok, `campos em portugues deveriam funcionar: ${r.problems.join('; ')}`);
}

// agente inválido
{
  const r = validatePlan({ tasks: [{ id: 't1', agent: 'hacker', instruction: 'x', depends_on: [] }] });
  expect(!r.ok, 'agente invalido deveria ser rejeitado');
  expect(r.problems.some((p) => p.includes('hacker')), 'erro deveria citar o agente invalido');
}

// planner não pode se auto-atribuir tarefa
{
  const r = validatePlan({ tasks: [{ id: 't1', agent: 'planner', instruction: 'x' }] });
  expect(!r.ok, 'planner como executor deveria ser rejeitado');
}

// id repetido
{
  const r = validatePlan({
    tasks: [
      { id: 't1', agent: 'coder', instruction: 'a' },
      { id: 't1', agent: 'coder', instruction: 'b' },
    ],
  });
  expect(!r.ok, 'id repetido deveria ser rejeitado');
}

// dependência inexistente
{
  const r = validatePlan({
    tasks: [{ id: 't1', agent: 'coder', instruction: 'a', depends_on: ['fantasma'] }],
  });
  expect(!r.ok, 'dependencia fantasma deveria ser rejeitada');
  expect(r.problems.some((p) => p.includes('fantasma')), 'erro deveria citar a dependencia fantasma');
}

// autodependência
{
  const r = validatePlan({ tasks: [{ id: 't1', agent: 'coder', instruction: 'a', depends_on: ['t1'] }] });
  expect(!r.ok, 'autodependencia deveria ser rejeitada');
}

// lista vazia
{
  const r = validatePlan({ tasks: [] });
  expect(!r.ok, 'lista vazia deveria ser rejeitada');
}

// limite de tarefas
{
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, agent: 'coder', instruction: 'x' }));
  const r = validatePlan({ tasks: many }, { maxTasks: 6 });
  expect(!r.ok, 'excesso de tarefas deveria ser rejeitado');
}

// instrução vazia
{
  const r = validatePlan({ tasks: [{ id: 't1', agent: 'coder', instruction: '   ' }] });
  expect(!r.ok, 'instrucao vazia deveria ser rejeitada');
}

// ---------------------------------------------------------------- topoWaves

{
  const r = topoWaves([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: ['a', 'b'] },
  ]);
  expect(r.ok, 'DAG simples deveria ordenar');
  expect(r.waves.length === 2, `esperava 2 ondas, veio ${r.waves.length}`);
  expect(r.waves[0].length === 2, 'onda 0 deveria ter a e b em paralelo');
  expect(r.waves[1][0].id === 'c', 'onda 1 deveria ter c');
}

// cadeia linear
{
  const r = topoWaves([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['b'] },
  ]);
  expect(r.waves.length === 3, 'cadeia linear deveria ter 3 ondas');
}

// tudo paralelo
{
  const r = topoWaves([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: [] },
  ]);
  expect(r.waves.length === 1 && r.waves[0].length === 3, 'sem dependencias = uma onda');
}

// ciclo de dois
{
  const r = topoWaves([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['a'] },
  ]);
  expect(!r.ok, 'ciclo deveria ser detectado');
  expect(r.problems.some((p) => p.includes('circular')), 'erro deveria falar de ciclo');
}

// ciclo de três
{
  const r = topoWaves([
    { id: 'a', dependsOn: ['c'] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['b'] },
  ]);
  expect(!r.ok, 'ciclo de tres deveria ser detectado');
}

// toda tarefa aparece exatamente uma vez
{
  const tasks = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
  ];
  const r = topoWaves(tasks);
  const flat = r.waves.flat().map((t) => t.id);
  expect(flat.length === tasks.length, 'nem toda tarefa foi ordenada');
  expect(new Set(flat).size === tasks.length, 'tarefa duplicada nas ondas');

  // d não pode vir antes de b e c
  const pos = Object.fromEntries(flat.map((id, i) => [id, i]));
  expect(pos.d > pos.b && pos.d > pos.c, 'ordem topologica violada');
}

// ---------------------------------------------------------------- buildPlan

{
  const r = buildPlan('```json\n' + JSON.stringify(validPlan) + '\n```');
  expect(r.ok, `buildPlan deveria aceitar markdown: ${r.problems.join('; ')}`);
  expect(r.waves.length === 3, 'buildPlan deveria produzir 3 ondas para cadeia');
}

{
  const r = buildPlan('desculpe, nao consegui');
  expect(!r.ok, 'buildPlan deveria falhar sem JSON');
}

{
  const r = buildPlan(JSON.stringify({ tasks: [{ id: 'a', agent: 'coder', instruction: 'x', depends_on: ['b'] }, { id: 'b', agent: 'coder', instruction: 'y', depends_on: ['a'] }] }));
  expect(!r.ok, 'buildPlan deveria rejeitar ciclo');
}

// ---------------------------------------------------------------- resumo

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — grafo validado: parsing, schema, DAG e ciclos');
}
