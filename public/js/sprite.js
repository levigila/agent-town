// Desenho procedural dos bonequinhos.
// Sem assets: tudo e retangulo, o que da o look pixel art e deixa
// facil trocar por spritesheets depois.

import { shirtOf, shade } from './config.js';
import { agentFoot } from './agent.js';

const R = (ctx, x, y, w, h, c) => {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
};

// Frequencia base da animacao de digitacao (ms por ciclo)
const TYPE_FREQ = 110;
// Amplitude do offset vertical dos bracos ao digitar (pixels)
const TYPE_AMP = 1.5;

// Sombra no chao: elipse escura semitransparente, achatada na vertical.
const SHADOW_RX = 7.5;
const SHADOW_RY = 2.6;
const SHADOW_ALPHA = 0.3;

/**
 * Desenha a sombra no chao sob o agente.
 * Deve ser chamada ANTES do corpo do sprite (a cada frame), pois usa
 * o pe do agente (agentFoot, derivado de agentBounds).
 * @param ctx canvas 2d no espaco do mundo (480x304)
 * @param agent instancia de AgentView (pos.x, pos.y)
 */
export function drawShadow(ctx, agent) {
  const foot = agentFoot(agent);
  const fx = Math.round(foot.x);
  const fy = Math.round(foot.y);

  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${SHADOW_ALPHA})`;
  ctx.beginPath();
  ctx.ellipse(fx, fy, SHADOW_RX, SHADOW_RY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Offset vertical dos bracos para o estado atual.
 * Retorna { left, right } em pixels (arredondados), com fases opostas
 * para que os bracos subam e desçam alternadamente ao digitar.
 * @param {string} state estado do agente
 * @param {number} now tempo em ms
 * @param {number} swing balanco da caminhada (-1..1)
 */
function armOffsets(state, now, swing) {
  if (state === 'walking') {
    const o = Math.round(swing * 1.4);
    return { left: o, right: -o };
  }
  if (state === 'working') {
    // digitacao: bracos alternados, movimento sutil
    const o = Math.sin(now / TYPE_FREQ) * TYPE_AMP;
    return { left: Math.round(o), right: Math.round(-o) };
  }
  if (state === 'thinking') {
    const o = Math.round(Math.sin(now / TYPE_FREQ) * 1.2);
    return { left: o, right: -o };
  }
  return { left: 0, right: 0 };
}

/**
 * @param ctx canvas 2d no espaco do mundo (480x304)
 * @param agent instancia de AgentView (pos, state, facing, def.pal)
 * @param now tempo em ms
 */
export function drawAgent(ctx, agent, now) {
  const p = agent.def.pal;
  // Cor da camisa personalizada no painel (config.shirtOf cai no pal.shirt padrao)
  const shirt = shirtOf(agent.def.id);
  const shirt2 = shade(shirt, -0.16);
  // Origem do desenho vem de agentBounds (mesma caixa usada no hit-test).
  const foot = agentFoot(agent);
  const fx = Math.round(foot.x);
  const fy = Math.round(foot.y);

  const walking = agent.state === 'walking';
  const working = agent.state === 'working' || agent.state === 'thinking';
  const phase = now / 110;
  const swing = walking ? Math.sin(phase) : 0;
  const bob = walking ? Math.abs(Math.sin(phase)) * 1.2 : working ? Math.sin(now / 190) * 0.7 : 0;
  const y = Math.round(fy - bob);

  // sombra no chao (antes do corpo)
  drawShadow(ctx, agent);

  // pernas
  const l1 = Math.round(swing * 1.8);
  const l2 = Math.round(-swing * 1.8);
  R(ctx, fx - 4, y - 6 + l1, 3, 6 - l1, p.pants);
  R(ctx, fx + 1, y - 6 + l2, 3, 6 - l2, p.pants);
  R(ctx, fx - 4, y - 2 + l1, 3, 2, p.shoe);
  R(ctx, fx + 1, y - 2 + l2, 3, 2, p.shoe);

  // tronco
  R(ctx, fx - 6, y - 15, 12, 10, shirt);
  R(ctx, fx - 6, y - 15, 12, 2, shirt2);

  // bracos (digitando quando trabalhando, balancando quando anda)
  // O offset e aplicado somente no desenho dos bracos/maos.
  const arms = armOffsets(agent.state, now, swing);
  R(ctx, fx - 8, y - 14 + arms.left, 2, 7, shirt2);
  R(ctx, fx + 6, y - 14 + arms.right, 2, 7, shirt2);
  R(ctx, fx - 8, y - 7 + arms.left, 2, 2, p.skin);
  R(ctx, fx + 6, y - 7 + arms.right, 2, 2, p.skin);

  // cabeca
  R(ctx, fx - 5, y - 25, 10, 10, p.skin);

  // cabelo
  R(ctx, fx - 5, y - 26, 10, 4, p.hair);
  R(ctx, fx - 6, y - 24, 1, 4, p.hair);
  R(ctx, fx + 5, y - 24, 1, 4, p.hair);

  // olhos (espelham conforme a direcao)
  const ex = agent.facing < 0 ? fx - 4 : fx - 2;
  R(ctx, ex, y - 21, 2, 2, '#16161f');
  R(ctx, ex + 4, y - 21, 2, 2, '#16161f');

  // boca discreta
  R(ctx, ex + 1, y - 18, 3, 1, 'rgba(0,0,0,0.22)');

  // oculos do reviewer
  if (agent.def.id === 'reviewer') {
    R(ctx, ex - 1, y - 22, 10, 1, 'rgba(200,230,255,0.55)');
    R(ctx, ex - 1, y - 19, 10, 1, 'rgba(200,230,255,0.55)');
  }

  // aura de erro
  if (agent.state === 'error') {
    ctx.fillStyle = 'rgba(239,83,80,0.16)';
    ctx.fillRect(fx - 9, y - 27, 18, 28);
  }
}
