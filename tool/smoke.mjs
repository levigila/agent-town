// Smoke test sem navegador: stuba o canvas 2d, roda a maquina de estados
// e o render path inteiro, e falha em qualquer NaN/Infinity nas coordenadas.

import { AGENT_DEFS, MEETING_BUTTON } from '../public/js/config.js';
import { createAgents } from '../public/js/agent.js';
import { applyEvent, applySnapshot, resetRoom } from '../public/js/handlers.js';
import { Renderer } from '../public/js/renderer.js';

const problems = [];
const stats = { fillRect: 0, fillText: 0, ellipse: 0, frames: 0 };

/** Todo texto desenhado, para conferir que os nomes aparecem no overlay. */
const drawnTexts = new Set();

const checkNums = (where, ...vals) => {
  for (const v of vals) {
    if (!Number.isFinite(v)) problems.push(`${where}: valor invalido (${v})`);
  }
};

function makeCtx() {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,
    fillRect(x, y, w, h) {
      checkNums('fillRect', x, y, w, h);
      stats.fillRect += 1;
    },
    clearRect(x, y, w, h) {
      checkNums('clearRect', x, y, w, h);
    },
    beginPath() {},
    closePath() {},
    fill() {},
    stroke() {},
    moveTo(x, y) {
      checkNums('moveTo', x, y);
    },
    lineTo(x, y) {
      checkNums('lineTo', x, y);
    },
    arcTo(x1, y1, x2, y2, r) {
      checkNums('arcTo', x1, y1, x2, y2, r);
    },
    arc(x, y, r) {
      checkNums('arc', x, y, r);
    },
    ellipse(x, y, rx, ry) {
      checkNums('ellipse', x, y, rx, ry);
      stats.ellipse += 1;
    },
    roundRect(x, y, w, h) {
      checkNums('roundRect', x, y, w, h);
    },
    fillText(t, x, y) {
      checkNums('fillText', x, y);
      stats.fillText += 1;
      drawnTexts.add(String(t));
    },
    setTransform() {},
    save() {},
    restore() {},
    measureText(t) {
      return { width: String(t).length * 6 };
    },
  };
  return ctx;
}

function makeCanvas() {
  const ctx = makeCtx();
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 608 }),
    addEventListener: () => {},
  };
}

globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };

const stage = { clientWidth: 1000, clientHeight: 640 };
const world = makeCanvas();
const overlay = makeCanvas();

const agents = createAgents(AGENT_DEFS);
const renderer = new Renderer({ stage, world, overlay, agents });
renderer.resize();

const ui = { setAgentStatus: () => {}, addTokens: () => {} };

// --- roteiro de eventos (mesmos tipos que o servidor emite) ----------------
const events = [
  { type: 'agent_spawned', agentId: 'planner' },
  { type: 'agent_spawned', agentId: 'researcher' },
  { type: 'agent_spawned', agentId: 'coder' },
  { type: 'agent_spawned', agentId: 'reviewer' },
  { type: 'agent_thinking', agentId: 'planner', text: 'quebrando o objetivo em tarefas menores' },
  { type: 'tool_call', agentId: 'planner', tool: 'read_file', args: 'docs/spec.md' },
  { type: 'tool_result', agentId: 'planner', tool: 'read_file', ok: true, summary: '142 linhas' },
  { type: 'agent_message', agentId: 'planner', to: 'researcher', text: 'levanta 3 concorrentes' },
  { type: 'agent_message', agentId: 'researcher', to: 'planner', text: 'achei 3, media 42,90' },
  { type: 'agent_message', agentId: 'planner', to: 'coder', text: 'implementa o parser' },
  { type: 'tool_call', agentId: 'coder', tool: 'run_tests', args: 'parser' },
  { type: 'tool_result', agentId: 'coder', tool: 'run_tests', ok: false, summary: '2 falhas' },
  { type: 'tool_call', agentId: 'coder', tool: 'run_tests', args: 'parser' },
  { type: 'tool_result', agentId: 'coder', tool: 'run_tests', ok: true, summary: '18/18' },
  { type: 'agent_message', agentId: 'coder', to: 'reviewer', text: 'PR pronto, revisa?' },
  { type: 'agent_message', agentId: 'reviewer', to: 'coder', text: 'faltou input vazio' },
  { type: 'agent_done', agentId: 'coder', summary: 'parser pronto' },
  { type: 'agent_done', agentId: 'reviewer', summary: 'aprovado' },
  { type: 'token_usage', agentId: 'coder', in: 100, out: 50, cost: 0.01 },
  { type: 'agent_error', agentId: 'researcher', text: 'rate limit' },
];

// Os eventos acima usam o PAPEL ("coder"). Agora os agentes tem instancias
// ("coder-1", "coder-2"), entao traduzimos antes de aplicar: um evento de
// papel vai para a primeira instancia daquele papel.
const idOfRole = (role) => AGENT_DEFS.find((a) => a.role === role)?.id || role;
for (const ev of events) {
  if (ev.agentId) ev.agentId = idOfRole(ev.agentId);
  if (ev.to) ev.to = idOfRole(ev.to);
}

const start = Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, { ...a.pos }]));
for (const ev of events) applyEvent(agents, ev, ui);

// roda ~20 s de animacao a 60 fps
let moved = false;
let t = 0;
for (let i = 0; i < 1200; i++) {
  t += 16.7;
  for (const a of Object.values(agents)) {
    a.update(16.7, t);
    if (!Number.isFinite(a.pos.x) || !Number.isFinite(a.pos.y)) {
      problems.push(`${a.def.id}: posicao invalida (${a.pos.x}, ${a.pos.y})`);
    }
  }
  renderer.draw(t);
  stats.frames += 1;
  for (const a of Object.values(agents)) {
    if (Math.abs(a.pos.x - start[a.def.id].x) > 2 || Math.abs(a.pos.y - start[a.def.id].y) > 2) moved = true;
  }
}

// --- assercoes -------------------------------------------------------------
if (!moved) problems.push('nenhum agente se moveu — a fila de acoes nao esta sendo consumida');

const atHome = Object.values(agents).every(
  (a) => Math.hypot(a.pos.x - a.home.x, a.pos.y - a.home.y) < 2,
);
if (!atHome) {
  for (const a of Object.values(agents)) {
    const d = Math.hypot(a.pos.x - a.home.x, a.pos.y - a.home.y);
    if (d >= 2) problems.push(`${a.def.id} nao voltou para casa (dist ${d.toFixed(1)})`);
  }
}

// pick() precisa achar o agente pela coordenada do mouse
const target = agents[idOfRole('coder')];
const hit = renderer.pick(target.pos.x * renderer.k, (target.pos.y - 12) * renderer.k);
if (!hit || hit.def.id !== target.def.id) problems.push('pick() nao encontrou o agente na sua posicao');
if (renderer.pick(0, 0)) problems.push('pick() encontrou agente no canto vazio');

// reset + snapshot nao podem quebrar
resetRoom(agents);
applySnapshot(agents, [
  { type: 'tool_call', agentId: 'planner' },
  { type: 'agent_done', agentId: 'coder' },
  { type: 'token_usage', agentId: 'coder', in: 10, out: 5 },
], ui);
renderer.draw(t);

// --- reuniao: todos andam ate a mesa e sentam ------------------------------
{
  const antes = Object.fromEntries(Object.values(agents).map((a) => [a.def.id, { ...a.pos }]));

  for (const a of Object.values(agents)) a.goMeet();

  // tempo suficiente para atravessar a sala: o agente mais distante sai de
  // x~446 (mesa do reviewer) ate x=240, ~206px, mais 152px em y. A 75px/s
  // isso da ~4,8s, entao 400 frames (6,7s) dao folga.
  for (let i = 0; i < 400; i++) {
    t += 16.7;
    for (const a of Object.values(agents)) a.update(16.7, t);
  }
  renderer.meeting = { called: true, busy: false };
  renderer.draw(t);

  for (const a of Object.values(agents)) {
    if (!a.inMeeting) problems.push(`${a.def.id} nao entrou no estado de reuniao`);
    if (!a.atMeetingSpot()) {
      const s = a.def.meetSpot;
      const d = Math.hypot(a.pos.x - s.x, a.pos.y - s.y);
      problems.push(`${a.def.id} nao chegou ao lugar da mesa (dist ${d.toFixed(1)})`);
    }
  }

  // os lugares sao distintos: dois agentes nao podem ocupar o mesmo ponto
  const lugares = Object.values(agents).map((a) => `${Math.round(a.pos.x)},${Math.round(a.pos.y)}`);
  if (new Set(lugares).size !== lugares.length) {
    problems.push(`dois agentes no mesmo lugar da mesa: ${lugares.join(' | ')}`);
  }

  // a reuniao mudou alguem de lugar (prova que goMeet saiu do lugar)
  const mudou = Object.values(agents).some((a) => {
    const p = antes[a.def.id];
    return Math.hypot(a.pos.x - p.x, a.pos.y - p.y) > 2;
  });
  if (!mudou) problems.push('goMeet() nao moveu nenhum agente');

  // botao da mesa responde ao clique
  const botaoX = (MEETING_BUTTON.x + MEETING_BUTTON.w / 2) * renderer.k;
  const botaoY = (MEETING_BUTTON.y + MEETING_BUTTON.h / 2) * renderer.k;
  if (!renderer.hitMeeting(botaoX, botaoY)) problems.push('hitMeeting() nao reconheceu o botao da mesa');
  if (renderer.hitMeeting(0, 0)) problems.push('hitMeeting() reconheceu clique no canto vazio');

  // desenhar com a reuniao aberta e com o "pensando" nao pode quebrar
  renderer.meeting = { called: true, busy: true };
  renderer.draw(t);

  // e sair da reuniao devolve todos para a mesa de trabalho
  for (const a of Object.values(agents)) a.leaveMeeting();
  for (let i = 0; i < 400; i++) {
    t += 16.7;
    for (const a of Object.values(agents)) a.update(16.7, t);
  }
  renderer.meeting = { called: false, busy: false };
  renderer.draw(t);

  const fora = Object.values(agents).filter((a) => a.inMeeting);
  if (fora.length) problems.push(`${fora.length} agente(s) continuaram em reuniao apos leaveMeeting()`);
}

if (stats.fillRect < 5000) problems.push(`poucas primitivas desenhadas (${stats.fillRect}) — o render pode estar vazio`);
if (stats.fillText < 10) problems.push(`poucos textos desenhados (${stats.fillText})`);

// Os nomes proprios precisam aparecer no overlay (acima da cabeca).
{
  const nomes = AGENT_DEFS.map((d) => d.name);
  const desenhados = [...drawnTexts];
  for (const nome of nomes) {
    if (!desenhados.includes(nome)) problems.push(`nome "${nome}" nao foi desenhado no overlay`);
  }
}

console.log(
  `frames=${stats.frames} fillRect=${stats.fillRect} ellipse=${stats.ellipse} fillText=${stats.fillText} k=${renderer.k.toFixed(2)}`,
);

if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const p of problems.slice(0, 20)) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — maquina de estados e render path sem erros');
}
