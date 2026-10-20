// Suite RAPIDA — o que os agentes rodam via .agent-town.json.
//
// O `npm test` completo roda 10 suites; algumas criam repositorios git e
// executam o orquestrador inteiro, o que leva ~2 minutos. Como varias
// instancias rodam testes durante a execucao, isso estourava o TIMEOUT_SEC.
//
// Aqui ficam so as verificacoes que pegam o que os agentes costumam quebrar:
// imports/exports, DOM do index.html e o caminho de render. Tudo em ~2 s.
//
// Rode `npm test` voce mesmo antes de aceitar o diff dos agentes.

import { execFileSync } from 'node:child_process';

const CHECKS = [
  ['check.mjs', 'sintaxe, imports, exports e DOM'],
  ['smoke.mjs', 'maquina de estados e render'],
  ['test-graph.mjs', 'validacao do grafo de tarefas'],
  // A UI e o unico arquivo que nenhum outro teste executava: um erro dentro
  // dele passava pela suite inteira e so aparecia no navegador, como tela
  // preta sem nenhum agente. Agora os proprios agentes pegam isso no
  // run_tests, antes de commitar.
  ['test-ui.mjs', 'carrega a UI e aceita todos os eventos'],
];

let failed = 0;

for (const [script, label] of CHECKS) {
  const started = Date.now();
  try {
    execFileSync(process.execPath, [`tool/${script}`], { stdio: 'pipe', encoding: 'utf8' });
    const ms = Date.now() - started;
    console.log(`ok   ${label} (${ms}ms)`);
  } catch (err) {
    failed += 1;
    console.log(`FALHA ${label}`);
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
    if (out) console.log(out.split('\n').slice(-12).join('\n'));
  }
}

if (failed) {
  console.error(`\n${failed} verificacao(oes) falharam. Rode "npm test" para a suite completa.`);
  process.exitCode = 1;
} else {
  console.log('\nOK — verificacao rapida passou (rode "npm test" para a suite completa)');
}
