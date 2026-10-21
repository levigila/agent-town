// Cola tudo: eventos SSE -> estado dos agentes -> render.

import { AGENT_DEFS } from './config.js';
import { createAgents } from './agent.js';
import { applyEvent, applySnapshot, resetRoom } from './handlers.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';

const agents = createAgents(AGENT_DEFS);

const stage = document.getElementById('stage');
const worldCanvas = document.getElementById('world');
const overlayCanvas = document.getElementById('overlay');
const speedEl = document.getElementById('speed');

const renderer = new Renderer({ stage, world: worldCanvas, overlay: overlayCanvas, agents });

const ui = new UI({
  onRun: (request) => post('/api/run', request),
  onStop: () => post('/api/stop', {}),
  onSpeed: (speed) => post('/api/speed', { speed }),
  onSelect: (id) => selectAgent(id),
  onMeetingDecide: (payload) => post('/api/meeting/decide', payload),
  onMeetingStop: () => post('/api/meeting/stop', {}),
});

/**
 * Aplica o estado da reuniao na cena e no card.
 *
 * Os agentes ficam sentados enquanto a reuniao estiver aberta (mesmo depois
 * que as propostas chegam): eles estao "discutindo" o que foi proposto.
 * Quando a reuniao fecha ou uma execucao comeca, todos voltam para a mesa.
 */
function setMeeting(m) {
  const state = m || { active: false, busy: false, proposals: [] };

  renderer.meeting = { called: !!state.active, busy: !!state.busy };

  if (state.active) {
    for (const a of Object.values(agents)) {
      if (!a.inMeeting) a.goMeet();
    }
  } else {
    for (const a of Object.values(agents)) a.leaveMeeting();
  }

  ui.setMeeting(state);
}

/** Abre (ou fecha) a reuniao ao clicar no botao da mesa. */
async function toggleMeeting() {
  if (renderer.meeting?.called) {
    await post('/api/meeting/stop', {});
    return;
  }
  const taskEl = document.getElementById('taskInput');
  await post('/api/meeting/start', { task: taskEl?.value || '' });
}

function selectAgent(id) {
  renderer.selected = id;
  ui.selectAgent(id);
}

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();

    // A reuniao devolve { meeting, run? }; o resto devolve o estado do runner.
    if (data.meeting) {
      setMeeting(data.meeting);
      if (data.run) ui.setRunState(data.run);
    }

    if (res.status === 409) {
      if (data.error) console.warn('[agent-town]', data.error);
      if (!data.meeting) ui.setRunState(data);
      return data;
    }

    if (data.error) {
      console.error('[agent-town]', data.error);
      return data;
    }

    if (!data.meeting) ui.setRunState(data);
    return data;
  } catch (err) {
    console.error('[agent-town] falha ao chamar', url, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

function handleEvent(ev) {
  if (ev.type === 'snapshot') {
    ui.setRunState(ev.state || { running: false });
    ui.resetTokens();
    // renderEvents repovoa o card de eventos; applySnapshot cuida dos sprites.
    applySnapshot(agents, ev.events, ui);
    setMeeting(ev.meeting);

    // reconstrói plano e diff ao reabrir a página no meio de uma execução
    for (const e of ev.events || []) {
      if (e.type === 'plan_created') ui.renderPlan(e);
      if (e.type === 'diff_ready') ui.renderDiff(e);
    }
    return;
  }

  ui.addEvent(ev);

  switch (ev.type) {
    case 'run_started':
      if (ev.silent) break; // ondas não reiniciam a sala
      ui.setRunState({ running: true, speed: Number(speedEl.value) });
      ui.resetTokens();
      ui.resetPlan();
      ui.resetDiff();
      // uma execucao comeca: todos levantam da mesa
      setMeeting({ active: false, busy: false, proposals: ui.meetingState.proposals });
      resetRoom(agents);
      return;

    case 'meeting_started':
      setMeeting({ active: true, busy: true, proposals: [] });
      return;

    case 'meeting_done':
      // meeting_done tambem e emitido ao fechar: usa o payload do servidor
      setMeeting(ev.meeting);
      return;

    case 'run_finished':
      ui.setRunState({ running: false });
      return;

    case 'plan_created':
      ui.renderPlan(ev);
      return;

    case 'diff_ready':
      ui.renderDiff(ev);
      return;

    default:
      break;
  }

  // tarefas do plano: marca em execução / concluída
  if (ev.taskId) {
    if (ev.type === 'agent_message') ui.markPlanTask(ev.taskId, 'running');
    if (ev.type === 'agent_done') ui.markPlanTask(ev.taskId, 'done');
  }

  applyEvent(agents, ev, ui);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connect() {
  const es = new EventSource('/events');

  es.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (!ev || !ev.type) return;
    handleEvent(ev);
  };

  es.onerror = () => {};
}

// ---------------------------------------------------------------------------
// Configuração inicial (modo e projetos disponíveis)
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const [projects, state] = await Promise.all([
      fetch('/api/projects').then((r) => r.json()),
      fetch('/api/state').then((r) => r.json()),
    ]);

    ui.setMode(state.mode, { projectsEnabled: projects.enabled });

    const input = document.getElementById('projectInput');
    if (projects.allowAny) {
      input.placeholder = 'escolha qualquer pasta (clique em "…")';
    } else if (Array.isArray(projects.roots) && projects.roots.length) {
      input.placeholder = projects.roots[0];
      input.dataset.roots = JSON.stringify(projects.roots);
    }

    if (Array.isArray(projects.templates) && projects.templates.length) {
      const sel = document.getElementById('templateSelect');
      sel.innerHTML = projects.templates.map((t) => `<option value="${t}">${t}</option>`).join('');
    }

    ui.setRunState(state);
  } catch (err) {
    console.error('[agent-town] falha ao carregar configuracao', err);
  }
}

// ---------------------------------------------------------------------------
// Loop de render
// ---------------------------------------------------------------------------

let last = performance.now();

function frame(now) {
  const dt = Math.min(80, now - last);
  last = now;

  try {
    for (const agent of Object.values(agents)) agent.update(dt, now);
    renderer.draw(now);
  } catch (err) {
    // Um erro aqui nao pode matar o loop: sem o requestAnimationFrame
    // reagendado a tela congela no meio do frame e fica preta.
    console.error('[agent-town] falha no render', err);
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

renderer.resize();
new ResizeObserver(() => renderer.resize()).observe(stage);
window.addEventListener('resize', () => renderer.resize());

overlayCanvas.addEventListener('click', (e) => {
  // O botao da mesa tem prioridade sobre a selecao de agente: ele fica no
  // meio da sala e seria facil errar o alvo.
  if (renderer.hitMeeting(e.clientX, e.clientY)) {
    toggleMeeting();
    return;
  }
  const hit = renderer.pick(e.clientX, e.clientY);
  selectAgent(hit ? (renderer.selected === hit.def.id ? null : hit.def.id) : null);
});

overlayCanvas.addEventListener('mousemove', (e) => {
  if (renderer.hitMeeting(e.clientX, e.clientY)) {
    overlayCanvas.style.cursor = 'pointer';
    return;
  }
  const hit = renderer.pick(e.clientX, e.clientY);
  overlayCanvas.style.cursor = hit ? 'pointer' : 'default';
});

loadConfig();
connect();
requestAnimationFrame(frame);
