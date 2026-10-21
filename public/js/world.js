// Cenario: piso, parede, mesas, mesa de reuniao e props.
// Tudo desenhado em retangulos, no espaco logico 480x304.

import { WORLD, WALL_H, DESK, MEETING, MEETING_SPOTS, MEETING_BUTTON, seatOf, floorTheme } from './config.js';

const R = (ctx, x, y, w, h, c) => {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};

// helper de texto: centraliza/alinha e restaura o estado do ctx
const T = (ctx, str, x, y, c, font = '9px monospace', align = 'center') => {
  ctx.save();
  ctx.fillStyle = c;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, Math.round(x), Math.round(y));
  ctx.restore();
};

const COL = {
  floorA: '#242a38',
  floorB: '#202632',
  floorSeam: '#1a1f29',
  wall: '#2c3346',
  wallTrim: '#3a4358',
  baseboard: '#171b25',
  deskTop: '#7d573a',
  deskTop2: '#6b4a2f',
  deskFront: '#4e3521',
  deskLeg: '#382415',
  metal: '#2a2f3d',
  metalDark: '#1a1d26',
  leaf: '#3fa34d',
  leaf2: '#2f7d3a',
  pot: '#a0522d',
  rug: '#3b3350',
  rug2: '#463c5e',
};

// Janela da parede esquerda (ver drawWall) e posicao do quadro de avisos logo abaixo dela.
const WINDOW = { x: 92, y: 10, w: 88, h: 30 };
const BOARD_LINES = ['reuniao 10h', 'deploy sexta', 'cafe acabou'];

const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);

/**
 * Relogio digital no canto superior direito da parede, formato HH:MM.
 * @param ctx contexto 2d
 * @param now timestamp em ms (Date.now()); se ausente usa o instante atual
 */
export function drawClock(ctx, now) {
  const d = new Date(typeof now === 'number' ? now : Date.now());
  const label = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const w = 44;
  const h = 16;
  const x = WORLD.w - w - 6;
  const y = 10;

  // moldura / corpo do relogio
  R(ctx, x, y, w, h, '#0f1319');
  R(ctx, x + 1, y + 1, w - 2, h - 2, '#121821');
  R(ctx, x, y, w, 1, '#3a4358');

  // display
  T(ctx, label, x + w / 2, y + h / 2 + 1, '#8ef0c8', '10px monospace', 'center');

  // pontinho piscando (separador) e brilho sutil
  if (Math.floor((typeof now === 'number' ? now : Date.now()) / 1000) % 2 === 0) {
    R(ctx, x + w - 5, y + 3, 2, 2, '#4be0c8');
  }
}

/**
 * Piso em xadrez. As cores vem do tema escolhido no painel
 * (config.floorTheme: escuro/claro/azul), com o escuro como padrao.
 */
export function drawFloor(ctx) {
  const theme = floorTheme();
  const T = 16;
  for (let y = WALL_H; y < WORLD.h; y += T) {
    for (let x = 0; x < WORLD.w; x += T) {
      const alt = ((x / T) | 0) % 2 === ((y / T) | 0) % 2;
      R(ctx, x, y, T, T, alt ? theme.floorA : theme.floorB);
    }
  }
  // juntas mais marcadas
  for (let x = 0; x <= WORLD.w; x += 64) R(ctx, x, WALL_H, 1, WORLD.h - WALL_H, theme.seam);
  for (let y = WALL_H; y <= WORLD.h; y += 64) R(ctx, 0, y, WORLD.w, 1, theme.seam);
}

/**
 * Quadro de avisos (cortica) na parede esquerda, logo abaixo da janela.
 * Desenha a moldura e tres recados curtos.
 * @param ctx contexto 2d
 */
export function drawBoard(ctx) {
  const x = WINDOW.x;
  const w = WINDOW.w;
  const y = WINDOW.y + WINDOW.h + 4; // abaixo da janela
  const maxH = WALL_H - 8 - y; // nao invade o rodape da parede
  const h = Math.max(12, Math.min(20, maxH));

  // moldura
  R(ctx, x, y, w, h, '#0f1319');
  R(ctx, x + 1, y + 1, w - 2, h - 2, '#12161d');
  // cortica
  R(ctx, x + 2, y + 2, w - 4, h - 4, '#b08455');
  R(ctx, x + 2, y + 2, w - 4, 1, '#c79a6b');
  R(ctx, x + 2, y + h - 3, w - 4, 1, 'rgba(0,0,0,0.25)');

  // preguinhos nos cantos
  R(ctx, x + 3, y + 3, 1, 1, '#5c3a1e');
  R(ctx, x + w - 4, y + 3, 1, 1, '#5c3a1e');
  R(ctx, x + 3, y + h - 4, 1, 1, '#5c3a1e');
  R(ctx, x + w - 4, y + h - 4, 1, 1, '#5c3a1e');

  // tres linhas de recado
  const lh = (h - 4) / BOARD_LINES.length;
  const fs = Math.max(5, Math.min(7, Math.round(lh - 1)));
  const font = `${fs}px monospace`;
  for (let i = 0; i < BOARD_LINES.length; i += 1) {
    const ty = y + 2 + lh * (i + 0.5);
    T(ctx, BOARD_LINES[i], x + w / 2, ty, '#2a1c10', font, 'center');
    R(ctx, x + 6, ty + Math.ceil(fs / 2) + 1, w - 12, 1, 'rgba(90,60,30,0.22)');
  }
}

export function drawWall(ctx, now) {
  R(ctx, 0, 0, WORLD.w, WALL_H, COL.wall);
  R(ctx, 0, 0, WORLD.w, 5, COL.wallTrim);
  R(ctx, 0, WALL_H - 4, WORLD.w, 4, COL.baseboard);

  // paineis verticais
  for (let x = 0; x < WORLD.w; x += 40) R(ctx, x, 5, 1, WALL_H - 9, 'rgba(0,0,0,0.16)');

  // janela
  R(ctx, WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h, '#151a24');
  R(ctx, 94, 12, 84, 26, '#1d2b3d');
  R(ctx, 134, 12, 2, 26, '#151a24');
  R(ctx, 94, 24, 84, 2, '#151a24');
  // brilho da janela variando devagar
  const glow = 0.06 + Math.sin(now / 2600) * 0.03;
  R(ctx, 94, 12, 84, 26, `rgba(120,190,255,${glow.toFixed(3)})`);

  // quadro de avisos, abaixo da janela
  drawBoard(ctx);

  // quadro branco
  R(ctx, 300, 10, 100, 30, '#0f1319');
  R(ctx, 302, 12, 96, 26, '#dfe3ea');
  R(ctx, 308, 17, 34, 2, '#8b93a3');
  R(ctx, 308, 22, 52, 2, '#b6bdc9');
  R(ctx, 308, 27, 44, 2, '#b6bdc9');
  R(ctx, 350, 17, 26, 12, 'rgba(90,200,170,0.35)');

  // relogio analogico pequeno
  R(ctx, 234, 16, 14, 14, '#0f1319');
  R(ctx, 236, 18, 10, 10, '#e8eef7');
  R(ctx, 240, 20, 1, 4, '#2b3242');
  R(ctx, 241, 23, 3, 1, '#2b3242');

  // relogio digital (canto superior direito da parede)
  drawClock(ctx, Date.now());
}

export function drawPlants(ctx) {
  // esquerda
  plant(ctx, 14, 296);
  // direita
  plant(ctx, 462, 296);
  // canto da parede
  plant(ctx, 12, 78);
}

function plant(ctx, x, y) {
  R(ctx, x - 6, y - 10, 12, 10, COL.pot);
  R(ctx, x - 6, y - 10, 12, 2, '#b96538');
  R(ctx, x - 4, y - 16, 8, 7, COL.leaf2);
  R(ctx, x - 7, y - 20, 6, 6, COL.leaf);
  R(ctx, x + 1, y - 21, 6, 6, COL.leaf);
  R(ctx, x - 3, y - 24, 6, 6, COL.leaf2);
  R(ctx, x - 1, y - 25, 3, 3, '#4fbf5d');
}

export function drawRug(ctx) {
  const { x, y, rx, ry } = MEETING;
  R(ctx, x - rx - 22, y - ry - 10, (rx + 22) * 2, (ry + 10) * 2, COL.rug);
  R(ctx, x - rx - 14, y - ry - 4, (rx + 14) * 2, (ry + 4) * 2, COL.rug2);
}

export function drawMeeting(ctx, now, state = {}) {
  const { x, y, rx, ry } = MEETING;
  const called = !!state.called;

  // Cadeiras: as de tras sao desenhadas antes do tampo (ficam atras);
  // as das pontas e da frente, depois (ficam na frente).
  for (const spot of MEETING_SPOTS) {
    if (spot.side === 'back') chair(ctx, spot, false);
  }

  // tampo
  ctx.fillStyle = '#5c4630';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6d543a';
  ctx.beginPath();
  ctx.ellipse(x, y - 2, rx - 3, ry - 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // papeis e caneca (nas laterais, para nao ficar sob o botao)
  R(ctx, x - 34, y - 9, 13, 9, '#d9dee8');
  R(ctx, x - 32, y - 7, 9, 1, '#9aa3b5');
  R(ctx, x - 32, y - 4, 7, 1, '#9aa3b5');
  R(ctx, x + 24, y - 9, 5, 5, '#e35d5d');
  R(ctx, x + 29, y - 8, 2, 3, '#e35d5d');

  // botao de chamar a reuniao
  drawMeetingButton(ctx, now, state);

  // cadeiras nas pontas e na frente
  for (const spot of MEETING_SPOTS) {
    if (spot.side !== 'back') chair(ctx, spot, spot.side === 'front');
  }

  // brilho sutil de atividade (mais forte com a reuniao aberta)
  const g = (called ? 0.1 : 0.04) + Math.sin(now / 1400) * 0.02;
  ctx.fillStyle = `rgba(120,200,255,${g.toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(x, y, rx + 6, ry + 6, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Uma cadeira. As de tras mostram o encosto acima do assento (o agente senta
 * na frente delas); as da frente mostram o encosto abaixo, senao ele ficaria
 * na frente do sprite.
 */
function chair(ctx, spot, front) {
  const w = 16;
  const h = 9;
  const cx = Math.round(spot.x - w / 2);
  const cy = Math.round(spot.y - h + 2);

  // assento
  R(ctx, cx, cy, w, h, front ? COL.metalDark : COL.metal);
  R(ctx, cx, cy, w, 2, '#39415a');

  if (front) {
    R(ctx, cx + 1, cy + h, w - 2, 3, '#232a38');
  } else {
    R(ctx, cx + 1, cy - 5, w - 2, 5, '#323a4d');
  }
}

/**
 * Botao sobre o tampo da mesa. E o unico controle clicavel dentro do cenario:
 * chama todo mundo para sentar e pensar em melhorias.
 */
function drawMeetingButton(ctx, now, state) {
  const { x, y, w, h } = MEETING_BUTTON;
  const called = !!state.called;
  const busy = !!state.busy;

  const accent = called ? '#f5a623' : '#4be0c8';
  const base = called ? '#3a2a12' : '#0f3536';
  const border = called ? '#7a5a1a' : '#1d5f60';

  // sombra
  R(ctx, x, y + 1, w, h, 'rgba(0,0,0,0.35)');

  // corpo
  R(ctx, x, y, w, h, border);
  R(ctx, x + 1, y + 1, w - 2, h - 2, base);

  // pulso enquanto a reuniao esta aberta
  if (called && !busy) {
    const pulse = 0.2 + Math.abs(Math.sin(now / 420)) * 0.3;
    R(ctx, x + 1, y + 1, w - 2, h - 2, `rgba(245,166,35,${pulse.toFixed(3)})`);
  }

  const label = busy ? 'pensando...' : called ? 'encerrar' : 'chamar todos';
  T(ctx, label, x + w / 2, y + h / 2 + 1, accent, '7px monospace', 'center');
}

/**
 * Mesa com um posto por agente.
 *
 * REGRA: nada aqui pode subir acima do tampo (`DESK.top`). A mesa e desenhada
 * DEPOIS dos agentes, entao qualquer prop mais alto fica na frente do sprite.
 * Era exatamente o bug do monitor antigo: ele ocupava y 72..92 e cobria o
 * rosto de researcher-1, coder-1 e reviewer-1 â€” os agentes do lugar 0 das
 * mesas compartilhadas, que ficavam invisiveis atras dele.
 *
 * @param {object[]} owners um por agente desta mesa: { slot, slots, on }
 * @param {string} accent cor de destaque quando o agente esta ativo
 */
export function drawDesk(ctx, index, owners, accent, now) {
  const x = DESK.xs[index];
  const top = DESK.top;
  const w = DESK.w;

  // tampo
  R(ctx, x, top, w, 6, COL.deskTop);
  R(ctx, x, top, w, 2, '#8d6444');
  R(ctx, x, top + 6, w, 15, COL.deskFront);
  R(ctx, x, top + 6, w, 1, '#5e3f27');

  // pernas
  R(ctx, x + 4, top + 21, 4, 7, COL.deskLeg);
  R(ctx, x + w - 8, top + 21, 4, 7, COL.deskLeg);

  // um posto por agente: teclado + mouse apoiados na superficie, sem nada na
  // altura do rosto
  for (const owner of owners) {
    const cx = seatOf(index, owner.slot, owner.slots).x;
    R(ctx, cx - 9, top + 1, 16, 3, COL.metal);
    R(ctx, cx - 8, top + 2, 14, 1, owner.on ? accent : '#3a4257');
    R(ctx, cx + 9, top + 2, 3, 3, COL.metal);
  }

  // caneca no canto esquerdo
  R(ctx, x + 3, top + 1, 5, 4, '#c9553f');
  R(ctx, x + 8, top + 2, 2, 2, '#c9553f');

  void now;
}

export function drawCoffeeCorner(ctx) {
  // armario
  R(ctx, 40, 258, 62, 30, '#3b3227');
  R(ctx, 40, 258, 62, 3, '#4d4234');
  R(ctx, 70, 262, 1, 24, 'rgba(0,0,0,0.3)');
  R(ctx, 46, 268, 3, 2, '#8a7f6c');
  R(ctx, 93, 268, 3, 2, '#8a7f6c');

  // maquina de cafe
  R(ctx, 50, 240, 26, 18, '#2a2f3d');
  R(ctx, 52, 242, 22, 6, '#161a22');
  R(ctx, 54, 250, 18, 5, '#0f1218');
  R(ctx, 63, 255, 4, 3, '#6b4a2f');
  R(ctx, 56, 244, 2, 2, '#4be0c8');
  R(ctx, 84, 250, 5, 6, '#d9dee8'); // copo
}

export function drawCouch(ctx) {
  R(ctx, 330, 258, 110, 26, '#3a4a63');
  R(ctx, 330, 258, 110, 4, '#46587a');
  R(ctx, 330, 272, 110, 12, '#334158');
  R(ctx, 334, 262, 46, 12, '#41536f');
  R(ctx, 386, 262, 46, 12, '#41536f');
  R(ctx, 330, 284, 6, 6, '#22303f');
  R(ctx, 434, 284, 6, 6, '#22303f');
}
