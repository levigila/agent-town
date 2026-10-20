// Renderer: desenha o mundo num canvas de baixa resolucao (pixel art de verdade)
// e a UI do mundo (nomes, baloes, selecao) num overlay em alta resolucao.

import { WORLD, DESK, MEETING, AGENT_LIST } from './config.js';
import { drawAgent } from './sprite.js';
import * as W from './world.js';

const TONES = {
  talk: { bg: '#f2f5fb', fg: '#1a1d26', border: '#c3cbdb' },
  think: { bg: '#262c3d', fg: '#cdd5e6', border: '#3b455e' },
  tool: { bg: '#0f3536', fg: '#7fe8d8', border: '#1d5f60' },
  error: { bg: '#3a1a1c', fg: '#ff9a97', border: '#7a2f33' },
  done: { bg: '#12301f', fg: '#8ce99a', border: '#245c3b' },
};

const STATE_DOT = {
  idle: '#5b6478',
  walking: '#8b93a3',
  working: '#4be0c8',
  thinking: '#a78bfa',
  error: '#ef5350',
  done: '#4caf50',
};

const MONO = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

export class Renderer {
  constructor({ stage, world, overlay, agents }) {
    this.stage = stage;
    this.world = world;
    this.overlay = overlay;
    this.wctx = world.getContext('2d');
    this.octx = overlay.getContext('2d');
    this.agents = agents;
    this.k = 1;
    this.selected = null;
    this.wctx.imageSmoothingEnabled = false;
    this.world.width = WORLD.w;
    this.world.height = WORLD.h;
  }

  resize() {
    const cw = this.stage.clientWidth;
    const ch = this.stage.clientHeight;
    if (!cw || !ch) return;

    const k = Math.min(cw / WORLD.w, ch / WORLD.h);
    this.k = k;
    const w = Math.round(WORLD.w * k);
    const h = Math.round(WORLD.h * k);

    this.world.style.width = `${w}px`;
    this.world.style.height = `${h}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cw = w;
    this.ch = h;
  }

  screenX(x) {
    return x * this.k;
  }

  screenY(y) {
    return y * this.k;
  }

  pick(clientX, clientY) {
    const rect = this.overlay.getBoundingClientRect();
    const wx = (clientX - rect.left) / this.k;
    const wy = (clientY - rect.top) / this.k;
    for (const a of Object.values(this.agents)) {
      if (wx >= a.pos.x - 10 && wx <= a.pos.x + 10 && wy >= a.pos.y - 29 && wy <= a.pos.y + 3) {
        return a;
      }
    }
    return null;
  }

  draw(now) {
    const ctx = this.wctx;
    const agents = Object.values(this.agents);

    ctx.clearRect(0, 0, WORLD.w, WORLD.h);

    W.drawFloor(ctx);
    W.drawWall(ctx, now);
    W.drawPlants(ctx);
    W.drawRug(ctx);

    const seatedLine = DESK.top + 14;

    // agentes sentados (atras das mesas)
    agents
      .filter((a) => a.pos.y < seatedLine)
      .sort((a, b) => a.pos.y - b.pos.y)
      .forEach((a) => drawAgent(ctx, a, now));

    // mesas (desenhadas na frente de quem esta sentado)
    // Cada mesa pode ter mais de um agente (duas instancias da mesma funcao),
    // entao a mesa acende se QUALQUER um dos seus ocupantes estiver ativo.
    for (let i = 0; i < DESK.xs.length; i++) {
      const owners = AGENT_LIST.filter((a) => a.desk === i);
      const on = owners.some((o) => {
        const ag = this.agents[o.id];
        return ag && (ag.state === 'working' || ag.state === 'thinking');
      });
      const accent = owners[0] ? owners[0].accent : '#4be0c8';
      W.drawDesk(ctx, i, on, accent, now);
    }

    // agentes no corredor (atras da mesa de reuniao)
    agents
      .filter((a) => a.pos.y >= seatedLine && a.pos.y < MEETING.y)
      .sort((a, b) => a.pos.y - b.pos.y)
      .forEach((a) => drawAgent(ctx, a, now));

    W.drawMeeting(ctx, now);
    W.drawCoffeeCorner(ctx);
    W.drawCouch(ctx);

    // agentes na frente
    agents
      .filter((a) => a.pos.y >= MEETING.y)
      .sort((a, b) => a.pos.y - b.pos.y)
      .forEach((a) => drawAgent(ctx, a, now));

    this.drawOverlay(now);
  }

  drawOverlay(now) {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.textBaseline = 'alphabetic';

    for (const a of Object.values(this.agents)) {
      const sx = this.screenX(a.pos.x);
      const sy = this.screenY(a.pos.y);
      const headTop = sy - 26 * this.k;
      const isSel = this.selected === a.def.id;

      // nome + ponto de estado
      ctx.font = MONO;
      ctx.textAlign = 'center';
      const label = a.def.name;
      const tw = ctx.measureText(label).width;
      const nameY = headTop - 6;

      ctx.fillStyle = 'rgba(8,10,14,0.62)';
      roundRect(ctx, sx - tw / 2 - 6, nameY - 10, tw + 12, 13, 6);
      ctx.fill();

      ctx.fillStyle = isSel ? a.def.accent : 'rgba(214,222,236,0.82)';
      ctx.fillText(label, sx, nameY);

      ctx.fillStyle = STATE_DOT[a.state] || '#5b6478';
      ctx.beginPath();
      ctx.arc(sx - tw / 2 - 1, nameY - 4, 2, 0, Math.PI * 2);
      ctx.fill();

      if (isSel) {
        ctx.strokeStyle = a.def.accent;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(sx, sy, 13 * this.k, 4 * this.k, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // balao
      if (a.bubble) {
        const tone = TONES[a.bubble.tone] || TONES.talk;
        this.drawBubble(ctx, sx, nameY - 16, a.bubble.text, tone, a.def.accent);
      }
    }
  }

  drawBubble(ctx, anchorX, anchorY, text, tone, accent) {
    ctx.font = MONO;
    const maxW = 190;
    const lines = wrap(ctx, text, maxW);
    const lh = 14;
    const pad = 7;
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 20);
    const w = Math.min(maxW, textW) + pad * 2;
    const h = lines.length * lh + pad * 2 - 2;

    let x = anchorX - w / 2;
    let y = anchorY - h;
    x = Math.max(4, Math.min(this.cw - w - 4, x));
    y = Math.max(4, y);

    ctx.fillStyle = tone.bg;
    ctx.strokeStyle = tone.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();

    // rabicho
    const tailX = Math.max(x + 10, Math.min(x + w - 10, anchorX));
    ctx.beginPath();
    ctx.moveTo(tailX - 4, y + h);
    ctx.lineTo(tailX, y + h + 5);
    ctx.lineTo(tailX + 4, y + h);
    ctx.closePath();
    ctx.fillStyle = tone.bg;
    ctx.fill();
    ctx.strokeStyle = tone.border;
    ctx.stroke();

    // barra de destaque
    ctx.fillStyle = accent;
    roundRect(ctx, x, y + 3, 2, h - 6, 1);
    ctx.fill();

    ctx.fillStyle = tone.fg;
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      ctx.fillText(line, x + pad + 4, y + pad + lh * i + 10);
    });
    ctx.textAlign = 'center';
  }
}
