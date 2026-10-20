// Desenho procedural dos bonequinhos.
// Sem assets: tudo e retangulo, o que da o look pixel art e deixa
// facil trocar por spritesheets depois.

import { shirtOf, shade } from './config.js';

const R = (ctx, x, y, w, h, c) => {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
};

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
  const fx = Math.round(agent.pos.x);
  const fy = Math.round(agent.pos.y);

  const walking = agent.state === 'walking';
  const working = agent.state === 'working' || agent.state === 'thinking';
  const phase = now / 110;
  const swing = walking ? Math.sin(phase) : 0;
  const bob = walking ? Math.abs(Math.sin(phase)) * 1.2 : working ? Math.sin(now / 190) * 0.7 : 0;
  const y = Math.round(fy - bob);

  // sombra
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.beginPath();
  ctx.ellipse(fx, fy, 7, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();

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
  let armOff = 0;
  if (walking) armOff = Math.round(swing * 1.4);
  else if (working) armOff = Math.round(Math.sin(now / 110) * 1.2);
  R(ctx, fx - 8, y - 14 + armOff, 2, 7, shirt2);
  R(ctx, fx + 6, y - 14 - armOff, 2, 7, shirt2);
  R(ctx, fx - 8, y - 7 + armOff, 2, 2, p.skin);
  R(ctx, fx + 6, y - 7 - armOff, 2, 2, p.skin);

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
