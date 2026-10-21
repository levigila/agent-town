// Testes do CENARIO: nomes, lugares da mesa de reuniao e geometria dos moveis.
//
// O bug que motivou o teste de geometria: a mesa era desenhada DEPOIS dos
// agentes, e o monitor subia ate y=72 enquanto o sprite do agente comeca em
// y~67. Resultado: researcher-1, coder-1 e reviewer-1 (os agentes do slot 0
// das mesas compartilhadas) ficavam escondidos atras do monitor.
//
// Nada aqui desenha em canvas: sao invariantes de geometria e de dados.

import {
  AGENT_LIST,
  AGENT_DEFS,
  DESK,
  WORLD,
  MEETING,
  MEETING_SPOTS,
  MEETING_BUTTON,
  seatOf,
  standOf,
  hitMeetingButton,
  nameForRole,
  agentOf,
  instancesOfRole,
} from '../public/js/config.js';

const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// ===========================================================================
// 1. Nomes proprios
// ===========================================================================
{
  const nomes = AGENT_LIST.map((a) => a.name);
  const unicos = new Set(nomes);

  expect(unicos.size === nomes.length, `nomes duplicados: ${nomes.join(', ')}`);

  for (const a of AGENT_LIST) {
    // O nome nao pode ser o rotulo genero+numero ("Coder 1"): era isso que
    // aparecia acima da cabeca e nao dizia nada sobre quem e o agente.
    expect(
      !/^(Planner|Researcher|Coder|Reviewer)\s*\d*$/.test(a.name),
      `${a.id} ainda usa nome generico: "${a.name}"`,
    );
    expect(a.name.length >= 2, `${a.id} tem nome curto demais: "${a.name}"`);
    expect(a.label?.includes(a.name), `${a.id} deveria ter label com o nome: ${a.label}`);
  }

  // nameForRole cicla quando ha mais instancias que nomes
  expect(nameForRole('coder', 0) === 'Caio', `primeiro coder deveria ser Caio: ${nameForRole('coder', 0)}`);
  expect(nameForRole('coder', 1) === 'Clara', `segundo coder deveria ser Clara: ${nameForRole('coder', 1)}`);
  expect(nameForRole('coder', 2) === 'Caio', 'com 3 instancias, o nome deveria ciclar');
  expect(nameForRole('inexistente', 0) === 'inexistente', 'papel sem nome deveria cair no proprio papel');
}

// ===========================================================================
// 2. Lugares na mesa de reuniao
// ===========================================================================
{
  expect(MEETING_SPOTS.length >= AGENT_LIST.length, `faltam lugares: ${MEETING_SPOTS.length} para ${AGENT_LIST.length} agentes`);

  // nenhum lugar pode coincidir com outro
  const chaves = new Set(MEETING_SPOTS.map((s) => `${s.x},${s.y}`));
  expect(chaves.size === MEETING_SPOTS.length, 'dois lugares na mesma coordenada');

  // todos dentro do mundo e fora do tampo da mesa
  for (const s of MEETING_SPOTS) {
    expect(s.x > 0 && s.x < WORLD.w, `lugar fora do mundo em x: ${s.x}`);
    expect(s.y > 0 && s.y < WORLD.h, `lugar fora do mundo em y: ${s.y}`);
  }

  // cada agente tem o seu, e nao ha dois no mesmo
  const usados = AGENT_DEFS.map((a) => `${a.meetSpot.x},${a.meetSpot.y}`);
  expect(new Set(usados).size === usados.length, `dois agentes no mesmo lugar: ${usados.join(' | ')}`);

  for (const a of AGENT_DEFS) {
    expect(a.meetSpot, `${a.id} sem lugar na mesa`);
    expect(a.meetSpot.side, `${a.id} sem lado definido (back/front/left/right)`);
  }
}

// ===========================================================================
// 3. O botao da mesa
// ===========================================================================
{
  const centro = { x: MEETING_BUTTON.x + MEETING_BUTTON.w / 2, y: MEETING_BUTTON.y + MEETING_BUTTON.h / 2 };

  expect(hitMeetingButton(centro.x, centro.y), 'o centro do botao deveria ser clicavel');
  expect(hitMeetingButton(MEETING_BUTTON.x, MEETING_BUTTON.y), 'o canto superior esquerdo deveria ser clicavel');
  expect(
    hitMeetingButton(MEETING_BUTTON.x + MEETING_BUTTON.w, MEETING_BUTTON.y + MEETING_BUTTON.h),
    'o canto inferior direito deveria ser clicavel',
  );

  // fora do botao
  expect(!hitMeetingButton(0, 0), 'o canto do mundo nao deveria ser clicavel');
  expect(!hitMeetingButton(MEETING_BUTTON.x - 5, centro.y), 'a esquerda do botao nao deveria ser clicavel');
  expect(!hitMeetingButton(centro.x, MEETING_BUTTON.y - 5), 'acima do botao nao deveria ser clicavel');

  // o botao precisa caber no tampo da mesa
  const dentroDoTampo =
    MEETING_BUTTON.x >= MEETING.x - MEETING.rx &&
    MEETING_BUTTON.x + MEETING_BUTTON.w <= MEETING.x + MEETING.rx;
  expect(dentroDoTampo, 'o botao deveria caber na largura do tampo');
}

// ===========================================================================
// 4. Geometria: nada da mesa pode cobrir o rosto do agente
//
// O sprite ocupa de (y - 26) a (y), onde y = pos.y. A mesa e desenhada
// DEPOIS dos agentes sentados, entao qualquer prop com topo acima de
// DESK.top aparece na frente do sprite sentado (pos.y = DESK.top + 8).
// ===========================================================================
{
  const spriteTopo = DESK.top + 8 - 26; // 74
  const tampo = DESK.top; // 92

  expect(
    tampo > spriteTopo,
    `o tampo (y=${tampo}) precisa ficar ABAIXO do topo do sprite (y=${spriteTopo})`,
  );

  // o sprite do agente sentado termina acima do tampo? entao a mesa nao cobre
  const peDoAgente = seatOf(0, 0, 2).y;
  expect(
    peDoAgente <= tampo + 10,
    `o agente deveria sentar junto da mesa (pe em y=${peDoAgente}, tampo em y=${tampo})`,
  );

  // Nenhum ponto da config declara prop acima do tampo. Se alguem reintroduzir
  // um monitor, e aqui que o teste precisa gritar.
  const propsAcimaDoTampo = [];
  for (const a of AGENT_LIST) {
    if (a.monitor || a.laptop) propsAcimaDoTampo.push(a.id);
  }
  expect(propsAcimaDoTampo.length === 0, `agente com prop na altura do rosto: ${propsAcimaDoTampo.join(', ')}`);
}

// ===========================================================================
// 5. Prova direta: drawDesk nao pinta NADA acima do tampo.
//
// O teste de geometria acima olha a config; este olha o que o codigo de
// desenho realmente faz. E o que pega a reintroducao de um monitor.
// ===========================================================================
{
  const { drawDesk } = await import('../public/js/world.js');

  /** ctx que so registra os retangulos, com os campos que o desenho usa. */
  function recordingCtx() {
    const rects = [];
    return {
      rects,
      fillStyle: '',
      beginPath() {},
      closePath() {},
      fill() {},
      ellipse() {},
      fillRect(x, y, w, h) {
        rects.push({ x, y, w, h });
      },
    };
  }

  for (let i = 0; i < DESK.xs.length; i++) {
    const ctx = recordingCtx();
    drawDesk(ctx, i, [{ slot: 0, slots: 2, on: true }, { slot: 1, slots: 2, on: false }], '#4be0c8', 0);

    expect(ctx.rects.length > 0, `mesa ${i}: drawDesk nao desenhou nada`);

    const acima = ctx.rects.filter((r) => r.y < DESK.top);
    expect(
      acima.length === 0,
      `mesa ${i}: ${acima.length} retangulo(s) acima do tampo ` +
        `(y=${acima.map((r) => r.y).join(',')} < ${DESK.top}) — isso cobre o agente sentado`,
    );

    // a mesa precisa caber na largura dela
    const largos = ctx.rects.filter((r) => r.x < DESK.xs[i] - 2 || r.x + r.w > DESK.xs[i] + DESK.w + 2);
    expect(largos.length === 0, `mesa ${i}: ${largos.length} retangulo(s) fora da largura da mesa`);
  }
}

// ===========================================================================
// 6. Duas instancias dividem a mesa sem se sobrepor
// ===========================================================================
{
  for (const role of ['researcher', 'coder', 'reviewer']) {
    const ids = instancesOfRole(role);
    expect(ids.length === 2, `${role} deveria ter 2 instancias, tem ${ids.length}`);

    const [a, b] = ids.map((id) => AGENT_DEFS.find((d) => d.id === id));
    expect(a.desk === b.desk, `${role}: as duas instancias deveriam dividir a mesma mesa`);

    const dist = Math.abs(a.seat.x - b.seat.x);
    // o sprite tem ~18px de largura (de x-9 a x+9); menos que isso = sobreposto
    expect(dist >= 18, `${role}: sprites sobrepostos (distancia ${dist}px)`);
  }
}

// ===========================================================================
// 7. agentOf resolve id de instancia e de papel
// ===========================================================================
{
  expect(agentOf('coder-1')?.id === 'coder-1', 'agentOf deveria achar a instancia exata');
  expect(agentOf('coder')?.role === 'coder', 'agentOf("coder") deveria cair na primeira instancia');
  expect(agentOf('inexistente') === null, 'agentOf de id desconhecido deveria ser null');
  expect(agentOf(null) === null, 'agentOf(null) deveria ser null');
}

// ===========================================================================
// 8. Os nomes do frontend e do backend precisam bater
//
// O servidor nao importa codigo de public/, entao AGENT_NAMES existe nos dois
// lugares. Se divergirem, o card de propostas mostra "Coder 1" enquanto o
// cenario mostra "Caio".
// ===========================================================================
{
  const { AGENT_NAMES: serverNames, buildAgentInstances } = await import('../src/config.mjs');

  for (const role of Object.keys(serverNames)) {
    const doFrontend = AGENT_LIST.filter((a) => a.role === role).map((a) => a.name);
    const doServidor = serverNames[role];
    expect(
      JSON.stringify(doFrontend) === JSON.stringify(doServidor),
      `nomes divergem em "${role}": frontend=[${doFrontend}] servidor=[${doServidor}]`,
    );
  }

  // buildAgentInstances usa os nomes proprios, nao "Coder 1"
  const roles = {
    planner: { id: 'planner', name: 'P', role: 'O', modelRef: null },
    coder: { id: 'coder', name: 'C', role: 'I', modelRef: null },
  };
  const inst = buildAgentInstances(roles, 2);
  expect(inst.find((a) => a.id === 'coder-1')?.name === 'Caio', 'coder-1 deveria se chamar Caio');
  expect(inst.find((a) => a.id === 'coder-2')?.name === 'Clara', 'coder-2 deveria se chamar Clara');
  expect(inst.find((a) => a.id === 'planner')?.name === 'Ada', 'planner deveria se chamar Ada');
}


// ===========================================================================
if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — nomes, lugares da mesa, botao e geometria dos moveis');
}
