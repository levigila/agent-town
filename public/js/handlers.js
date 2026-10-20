// Traducao de eventos -> acoes dos agentes.
//
// Fica separado do main.js de proposito: aqui nao existe DOM, entao da para
// testar em Node e reaproveitar se um dia a tela virar outra coisa (OBS, etc).

import { TOOL_LABELS } from './config.js';

/**
 * @param agents mapa id -> AgentView
 * @param ev evento vindo do servidor
 * @param ui objeto com setAgentStatus(id, label, tone) e addTokens(id, n)
 */
export function applyEvent(agents, ev, ui) {
  const a = ev.agentId ? agents[ev.agentId] : null;

  switch (ev.type) {
    case 'agent_spawned':
      if (a) a.reset();
      break;

    case 'agent_thinking':
      if (a) {
        a.setState('thinking');
        a.sayNow(ev.text, 'think', 3000);
      }
      ui.setAgentStatus(ev.agentId, 'pensando', 'thinking');
      break;

    case 'agent_message': {
      if (a) {
        const target = ev.to ? agents[ev.to] : null;
        if (target) {
          const side = target.def.stand.x < a.pos.x ? 20 : -20;
          a.goTo(target.def.stand.x + side, target.def.stand.y);
          target.faceToward(a);
        }
        a.say(ev.text, 'talk', 2600);
        a.goHome();
      }
      ui.setAgentStatus(ev.agentId, 'conversando', 'walking');
      break;
    }

    case 'tool_call':
      if (a) {
        a.setState('working');
        a.sayNow(`${TOOL_LABELS[ev.tool] || ev.tool}(${ev.args || ''})`, 'tool', 2400);
      }
      ui.setAgentStatus(ev.agentId, 'executando', 'working');
      break;

    case 'tool_result':
      if (a) {
        if (ev.ok) {
          a.setState('working');
        } else {
          a.setState('error');
          a.sayNow(`falhou · ${ev.summary || ''}`, 'error', 2600);
        }
      }
      ui.setAgentStatus(ev.agentId, ev.ok ? 'trabalhando' : 'erro', ev.ok ? 'working' : 'error');
      break;

    case 'agent_done':
      if (a) {
        a.setState('done');
        a.sayNow(`✓ ${ev.summary || 'concluido'}`, 'done', 3400);
      }
      ui.setAgentStatus(ev.agentId, 'concluido', 'done');
      break;

    case 'agent_error':
      if (a) {
        a.setState('error');
        a.sayNow(ev.text || 'erro', 'error', 3200);
      }
      ui.setAgentStatus(ev.agentId, 'erro', 'error');
      break;

    case 'token_usage':
      ui.addTokens(ev.agentId, (ev.in || 0) + (ev.out || 0));
      break;

    default:
      break;
  }
}

/** Volta a sala ao estado inicial (inicio de ciclo). */
export function resetRoom(agents) {
  for (const a of Object.values(agents)) a.reset();
}

/**
 * Reconstroi o estado visual a partir dos eventos de um snapshot,
 * usando o ultimo evento de cada agente.
 */
export function applySnapshot(agents, events, ui) {
  const last = {};
  for (const e of events || []) {
    if (e.type === 'token_usage' && e.agentId) {
      ui.addTokens(e.agentId, (e.in || 0) + (e.out || 0));
      continue;
    }
    if (e.agentId) last[e.agentId] = e;
  }

  for (const [id, e] of Object.entries(last)) {
    const a = agents[id];
    if (!a) continue;
    if (e.type === 'tool_call') {
      a.setState('working');
      ui.setAgentStatus(id, 'executando', 'working');
    } else if (e.type === 'agent_thinking') {
      a.setState('thinking');
      ui.setAgentStatus(id, 'pensando', 'thinking');
    } else if (e.type === 'agent_done') {
      a.setState('done');
      ui.setAgentStatus(id, 'concluido', 'done');
    } else if (e.type === 'agent_error' || (e.type === 'tool_result' && e.ok === false)) {
      a.setState('error');
      ui.setAgentStatus(id, 'erro', 'error');
    } else if (e.type === 'agent_message') {
      a.setState('working');
      ui.setAgentStatus(id, 'conversando', 'walking');
    }
  }
}
