// Testes da reuniao de melhoria (src/brainstorm.mjs).
//
// Sem rede: provedores falsos. O que importa garantir:
//   - proposta valida passa, proposta torta e rejeitada com motivo
//   - um agente que falha nao derruba a reuniao
//   - titulos repetidos nao viram duas propostas
//   - a tarefa composta tem tudo que o orquestrador precisa
//   - nenhuma proposta e implementada sem aprovacao

import {
  normalizeProposal,
  composeTask,
  runMeeting,
  buildMeetingPrompt,
  contextToText,
  filterKnownFiles,
  PROPOSAL_KINDS,
  KIND_LABEL,
} from '../src/brainstorm.mjs';
import { Semaphore } from '../src/limiter.mjs';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// ===========================================================================
// 1. normalizeProposal
// ===========================================================================
{
  const agent = { id: 'coder-1', name: 'Caio', role: 'coder' };

  const ok = normalizeProposal(
    {
      title: '  Destacar   o agente bloqueado com um cadeado  ',
      kind: 'visual',
      why: 'hoje nao da para saber quem esta travado',
      how: 'desenhar um cadeado acima da cabeca quando o estado for blocked',
      files: ['public/js/sprite.js', 'public/js/renderer.js'],
      effort: 'pequeno',
    },
    agent,
  );

  expect(ok.ok, `proposta valida deveria passar: ${ok.problem}`);
  expect(ok.proposal.id === 'p_coder-1', `id deveria vir do agente: ${ok.proposal.id}`);
  expect(ok.proposal.agentName === 'Caio', 'deveria carregar o nome do agente');
  expect(ok.proposal.title === 'Destacar o agente bloqueado com um cadeado', `titulo normalizado: ${ok.proposal.title}`);
  expect(ok.proposal.files.length === 2, 'deveria manter os arquivos');

  // sem titulo
  const noTitle = normalizeProposal({ why: 'x' }, agent);
  expect(!noTitle.ok && /title/.test(noTitle.problem), `sem title deveria falhar: ${noTitle.problem}`);

  // tipo desconhecido cai no padrao, nao quebra
  const weird = normalizeProposal({ title: 'algo', kind: 'inexistente' }, agent);
  expect(weird.ok && weird.proposal.kind === 'implementacao', `kind invalido deveria virar implementacao: ${weird.proposal?.kind}`);

  // esforco desconhecido vira medio
  const eff = normalizeProposal({ title: 'algo', effort: 'gigante' }, agent);
  expect(eff.proposal.effort === 'medio', `effort invalido deveria virar medio: ${eff.proposal.effort}`);

  // files nao-array
  const noFiles = normalizeProposal({ title: 'algo', files: 'nao e array' }, agent);
  expect(noFiles.ok && noFiles.proposal.files.length === 0, 'files invalido deveria virar lista vazia');

  // null
  expect(!normalizeProposal(null, agent).ok, 'null deveria ser rejeitado');

  // todos os tipos tem rotulo
  for (const k of PROPOSAL_KINDS) {
    expect(KIND_LABEL[k], `KIND_LABEL faltando para ${k}`);
  }
}

// ===========================================================================
// 2. buildMeetingPrompt
// ===========================================================================
{
  const comEscrita = buildMeetingPrompt({ id: 'coder-1', name: 'Caio', roleName: 'Implementacao' }, { canEdit: true });
  expect(comEscrita.includes('Caio'), 'o prompt deveria citar o nome do agente');
  expect(/JSON valido/.test(comEscrita), 'deveria exigir JSON');

  const somenteLeitura = buildMeetingPrompt({ id: 'docs', name: 'Doc', roleName: 'Revisao' }, { canEdit: false });
  expect(
    /nao pode propor mudanca de codigo/.test(somenteLeitura),
    'agente somente-leitura deveria ser avisado',
  );

  // com a arvore real, o prompt precisa lista-la e proibir invencao
  const comArvore = buildMeetingPrompt(
    { id: 'coder-1', name: 'Caio', roleName: 'Implementacao' },
    { canEdit: true, fileTree: 'public/js/world.js\nserver.mjs' },
  );
  expect(comArvore.includes('public/js/world.js'), 'deveria listar os arquivos reais');
  expect(/SOMENTE caminhos que existem/.test(comArvore), 'deveria proibir caminho inventado');

  // sem arvore, deveria pedir para deixar files vazio
  expect(
    /nao invente nome de arquivo/.test(comEscrita),
    'sem arvore, deveria pedir para nao inventar caminho',
  );
}

// ===========================================================================
// 2b. contextToText — o bug do "[object Object]"
//
// projectContext() devolve { tree, fileCount, truncated }. Interpolar o objeto
// direto mandava "[object Object]" para o modelo, e dois agentes propuseram
// "tratar mensagens malformadas" porque acharam que tinham recebido lixo.
// ===========================================================================
{
  expect(contextToText('texto puro') === 'texto puro', 'string deveria passar direto');
  expect(contextToText(null) === '', 'null deveria virar string vazia');

  const txt = contextToText({ tree: 'a.js\nb.js', fileCount: 2, truncated: false });
  expect(txt.includes('a.js'), `deveria usar .tree: ${txt}`);
  expect(!txt.includes('[object Object]'), 'NUNCA deveria conter [object Object]');

  const truncado = contextToText({ tree: 'a.js', fileCount: 99, truncated: true });
  expect(/truncada/.test(truncado), 'deveria avisar que a arvore foi truncada');
  expect(/99/.test(truncado), 'deveria citar a contagem de arquivos');

  // objeto sem .tree nao pode quebrar
  const outro = contextToText({ foo: 'bar' });
  expect(!outro.includes('[object Object]'), `objeto desconhecido virou lixo: ${outro}`);
}

// ===========================================================================
// 2c. filterKnownFiles — caminho inventado sai, a ideia fica
// ===========================================================================
{
  const conhecidos = ['public/js/world.js', 'public/js/sprite.js', 'server.mjs', 'src/brainstorm.mjs'];

  const ok = filterKnownFiles(['public/js/world.js', 'server.mjs'], conhecidos);
  expect(ok.kept.length === 2 && ok.removed.length === 0, `validos deveriam passar: ${JSON.stringify(ok)}`);

  // "server.js" nao existe (o arquivo e server.mjs)
  const inventado = filterKnownFiles(['server.js', 'public/app.js', 'public/js/sprite.js'], conhecidos);
  expect(inventado.kept.length === 1, `so o valido deveria ficar: ${inventado.kept}`);
  expect(inventado.kept[0] === 'public/js/sprite.js', `ficou o errado: ${inventado.kept}`);
  expect(inventado.removed.length === 2, `deveria remover 2: ${inventado.removed}`);

  // tolerante a barra invertida, caixa e "./"
  const tolerante = filterKnownFiles(['.\\public\\js\\World.js'], conhecidos);
  expect(tolerante.kept.length === 1, `deveria aceitar variacao de caminho: ${JSON.stringify(tolerante)}`);

  // sem lista de conhecidos, nao filtra nada
  const semLista = filterKnownFiles(['qualquer.js'], []);
  expect(semLista.kept.length === 1 && semLista.removed.length === 0, 'sem lista, nada e removido');
}

// ===========================================================================
// 3. runMeeting com provedores falsos
// ===========================================================================
const MODEL = { providerKey: 'fake', model: 'm', ref: 'fake:m' };

function fakeProviders(scripts) {
  const limiter = new Semaphore(4, 'Fake');
  const make = (id) => ({
    key: 'fake',
    label: 'F',
    model: 'm',
    providerKey: 'fake',
    role: id,
    limiter,
    async chat() {
      const script = scripts[id];
      if (typeof script === 'function') return script();
      if (script instanceof Error) throw script;
      return { text: script ?? 'ok', toolCalls: [], finishReason: 'stop', usage: { in: 10, out: 5 } };
    },
  });

  const byInstance = {};
  for (const id of Object.keys(scripts)) byInstance[id] = make(id);
  return { byInstance, byRole: {}, limiters: { fake: limiter } };
}

const proposalJson = (title, kind = 'visual') =>
  JSON.stringify({ title, kind, why: 'porque sim', how: 'assim', files: ['a.js'], effort: 'pequeno' });

// 3a. todos respondem
{
  const agents = [
    { id: 'planner', name: 'Ada', role: 'planner' },
    { id: 'coder-1', name: 'Caio', role: 'coder' },
    { id: 'reviewer-1', name: 'Vera', role: 'reviewer' },
  ];
  const { byInstance } = fakeProviders({
    planner: proposalJson('Checklist de proposta no painel', 'processo'),
    'coder-1': proposalJson('Cadeado no agente bloqueado', 'visual'),
    'reviewer-1': proposalJson('Botao de reexecutar so a tarefa que falhou', 'implementacao'),
  });

  const events = [];
  const res = await runMeeting({
    agents,
    byInstance,
    context: 'ctx',
    emit: (type, agentId, payload) => events.push({ type, agentId, ...payload }),
  });

  expect(res.ok, 'deveria completar');
  expect(res.proposals.length === 3, `deveria ter 3 propostas, veio ${res.proposals.length}`);
  expect(res.errors.length === 0, `nao deveria ter erros: ${JSON.stringify(res.errors)}`);
  expect(events.some((e) => e.type === 'meeting_started'), 'deveria emitir meeting_started');
  expect(events.some((e) => e.type === 'meeting_done'), 'deveria emitir meeting_done');
  expect(events.filter((e) => e.type === 'proposal').length === 3, 'deveria emitir um proposal por agente');

  // ordenado do mais barato para o mais caro
  expect(res.proposals[0].effort === 'pequeno', 'o primeiro deveria ser o de menor esforco');
}

// 3b. um agente quebrado nao derruba a reuniao
{
  const agents = [
    { id: 'coder-1', name: 'Caio', role: 'coder' },
    { id: 'coder-2', name: 'Clara', role: 'coder' },
    { id: 'reviewer-1', name: 'Vera', role: 'reviewer' },
  ];
  const { byInstance } = fakeProviders({
    'coder-1': proposalJson('Ideia boa'),
    'coder-2': new Error('HTTP 500'),
    'reviewer-1': 'isso nao e json',
  });

  const res = await runMeeting({ agents, byInstance, context: 'ctx' });

  expect(res.proposals.length === 1, `so uma proposta deveria sobreviver: ${res.proposals.length}`);
  expect(res.errors.length === 2, `deveria reportar 2 falhas: ${JSON.stringify(res.errors)}`);
  expect(
    res.errors.some((e) => /HTTP 500/.test(e.problem)),
    'deveria registrar o erro do agente que falhou',
  );
}

// 3c. titulos repetidos viram uma proposta so
{
  const agents = [
    { id: 'coder-1', name: 'Caio', role: 'coder' },
    { id: 'coder-2', name: 'Clara', role: 'coder' },
  ];
  const { byInstance } = fakeProviders({
    'coder-1': proposalJson('Adicionar relogio na parede'),
    'coder-2': proposalJson('adicionar   RELOGIO na parede'),
  });

  const res = await runMeeting({ agents, byInstance, context: 'ctx' });
  expect(res.proposals.length === 1, `deveria deduplicar: ${res.proposals.map((p) => p.title).join(' | ')}`);
}

// 3d. JSON embrulhado em markdown e aceito
{
  const agents = [{ id: 'coder-1', name: 'Caio', role: 'coder' }];
  const { byInstance } = fakeProviders({
    'coder-1': '```json\n' + proposalJson('Proposta em markdown') + '\n```',
  });

  const res = await runMeeting({ agents, byInstance, context: 'ctx' });
  expect(res.proposals.length === 1, 'deveria aceitar JSON dentro de bloco markdown');
}

// 3e. agente sem provedor e reportado, nao explode
{
  const agents = [{ id: 'fantasma', name: 'X', role: 'coder' }];
  const res = await runMeeting({ agents, byInstance: {}, byRole: {}, context: 'ctx' });
  expect(res.proposals.length === 0, 'sem provedor nao deveria haver proposta');
  expect(res.errors.length === 1, 'deveria reportar o agente sem provedor');
}

// 3f. resposta truncada: repete com o dobro do espaco e salva a proposta
//
// Bug real: maxTokens=900 cortava o JSON no meio (finish_reason "length") e o
// agente virava "resposta nao e um objeto" — 3 de 7 agentes perdidos.
{
  const agents = [{ id: 'coder-1', name: 'Caio', role: 'coder' }];
  let chamadas = 0;

  const limiter = new Semaphore(4, 'F');
  const byInstance = {
    'coder-1': {
      key: 'fake',
      label: 'F',
      model: 'm',
      providerKey: 'fake',
      role: 'coder-1',
      limiter,
      async chat({ maxTokens }) {
        chamadas += 1;
        // primeira chamada: cortada. segunda: completa.
        if (chamadas === 1) {
          return {
            text: '{"title":"proposta cortada no me',
            toolCalls: [],
            finishReason: 'length',
            usage: { in: 10, out: 5 },
          };
        }
        return {
          text: proposalJson('Proposta salva na segunda tentativa'),
          toolCalls: [],
          finishReason: 'stop',
          usage: { in: 10, out: 5 },
        };
      },
    },
  };

  const res = await runMeeting({ agents, byInstance, context: 'ctx', maxTokens: 900 });

  expect(chamadas === 2, `deveria tentar 2 vezes, tentou ${chamadas}`);
  expect(res.proposals.length === 1, `deveria salvar a proposta: ${JSON.stringify(res.errors)}`);
  expect(res.proposals[0].title.includes('segunda tentativa'), 'deveria usar a resposta completa');
}

// 3g. truncada duas vezes: erro claro, nao "resposta nao e um objeto"
{
  const agents = [{ id: 'coder-1', name: 'Caio', role: 'coder' }];
  const limiter = new Semaphore(4, 'F');
  const byInstance = {
    'coder-1': {
      key: 'fake',
      label: 'F',
      model: 'm',
      providerKey: 'fake',
      role: 'coder-1',
      limiter,
      async chat() {
        return { text: '{"title":"cortado', toolCalls: [], finishReason: 'length', usage: { in: 10, out: 5 } };
      },
    },
  };

  const res = await runMeeting({ agents, byInstance, context: 'ctx' });
  expect(res.proposals.length === 0, 'nao deveria ter proposta');
  expect(
    /truncada/.test(res.errors[0]?.problem || ''),
    `o erro deveria citar truncamento: ${res.errors[0]?.problem}`,
  );
}

// 3h. sem JSON: erro diz "nao devolveu JSON"
{
  const agents = [{ id: 'coder-1', name: 'Caio', role: 'coder' }];
  const { byInstance } = fakeProviders({ 'coder-1': 'Desculpe, nao posso ajudar com isso.' });
  const res = await runMeeting({ agents, byInstance, context: 'ctx' });
  expect(res.proposals.length === 0, 'sem JSON nao deveria ter proposta');
  expect(
    /JSON/.test(res.errors[0]?.problem || ''),
    `o erro deveria falar de JSON: ${res.errors[0]?.problem}`,
  );
}

// ===========================================================================
// 4. composeTask
// ===========================================================================
{
  const task = composeTask([
    {
      title: 'Cadeado no agente bloqueado',
      kind: 'visual',
      why: 'nao da para ver quem travou',
      how: 'desenhar acima da cabeca',
      files: ['public/js/sprite.js'],
      effort: 'pequeno',
    },
    { title: 'Reexecutar tarefa que falhou', kind: 'implementacao', why: '', how: '', files: [], effort: 'medio' },
  ]);

  expect(/Implemente as melhorias aprovadas/.test(task), 'deveria ter cabecalho');
  expect(task.includes('Cadeado no agente bloqueado'), 'deveria citar a primeira proposta');
  expect(task.includes('visual'), 'deveria citar o tipo');
  expect(task.includes('public/js/sprite.js'), 'deveria citar os arquivos');
  expect(task.includes('2.'), 'deveria numerar as propostas');

  expect(composeTask([]) === '', 'sem proposta a tarefa e vazia');
  expect(composeTask(null) === '', 'null deveria virar string vazia');
}

// ===========================================================================
if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — reuniao: propostas validadas, dedup e tarefa composta');
}
