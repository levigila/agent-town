// Renderiza a cena num PNG sem navegador.
// Rasteriza fillRect/ellipse num buffer RGBA e codifica PNG com zlib.
// Serve para conferir visualmente a composicao do cenario.

import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { AGENT_DEFS } from '../public/js/config.js';
import { createAgents } from '../public/js/agent.js';
import { applyEvent } from '../public/js/handlers.js';
import { Renderer } from '../public/js/renderer.js';

const SCALE = 3;
const W = 480;
const H = 304;
const OW = W * SCALE;
const OH = H * SCALE;
const buf = Buffer.alloc(OW * OH * 4, 0);

const parseColor = (c) => {
  if (typeof c !== 'string') return [255, 0, 255, 1];
  const s = c.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
    }
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return [r, g, b, 1];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v));
    return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1];
  }
  return [255, 0, 255, 1];
};

const put = (px, py, r, g, b, a) => {
  if (px < 0 || py < 0 || px >= OW || py >= OH || a <= 0) return;
  const i = (py * OW + px) * 4;
  if (a >= 1) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
    return;
  }
  buf[i] = Math.round(buf[i] * (1 - a) + r * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
  buf[i + 3] = 255;
};

function makeCtx({ skipClear = false } = {}) {
  let path = { ellipses: [], rects: [] };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,

    fillRect(x, y, w, h) {
      const [r, g, b, a0] = parseColor(this.fillStyle);
      const a = a0 * this.globalAlpha;
      const x0 = Math.round(x * SCALE);
      const y0 = Math.round(y * SCALE);
      const x1 = Math.round((x + w) * SCALE);
      const y1 = Math.round((y + h) * SCALE);
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) put(px, py, r, g, b, a);
    },

    clearRect(x, y, w, h) {
      // no overlay o clear existe so no canvas real; aqui preservamos o mundo
      if (skipClear) return;
      const x0 = Math.round(x * SCALE);
      const y0 = Math.round(y * SCALE);
      const x1 = Math.round((x + w) * SCALE);
      const y1 = Math.round((y + h) * SCALE);
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) put(px, py, 0, 0, 0, 1);
    },

    beginPath() {
      path = { ellipses: [], rects: [] };
    },
    closePath() {},
    ellipse(x, y, rx, ry) {
      path.ellipses.push([x, y, rx, ry]);
    },
    arc(x, y, r) {
      path.ellipses.push([x, y, r, r]);
    },
    roundRect(x, y, w, h) {
      path.rects.push([x, y, w, h]);
    },
    moveTo() {},
    lineTo() {},
    arcTo() {},
    fill() {
      const [r, g, b, a0] = parseColor(this.fillStyle);
      const a = a0 * this.globalAlpha;
      for (const [x, y, rx, ry] of path.ellipses) {
        const cx = x * SCALE;
        const cy = y * SCALE;
        const ax = rx * SCALE;
        const ay = ry * SCALE;
        for (let py = Math.floor(cy - ay); py <= Math.ceil(cy + ay); py++) {
          for (let px = Math.floor(cx - ax); px <= Math.ceil(cx + ax); px++) {
            const dx = (px - cx) / (ax || 1);
            const dy = (py - cy) / (ay || 1);
            if (dx * dx + dy * dy <= 1) put(px, py, r, g, b, a);
          }
        }
      }
      for (const [x, y, w, h] of path.rects) {
        const x0 = Math.round(x * SCALE);
        const y0 = Math.round(y * SCALE);
        const x1 = Math.round((x + w) * SCALE);
        const y1 = Math.round((y + h) * SCALE);
        for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) put(px, py, r, g, b, a);
      }
      path = { ellipses: [], rects: [] };
    },
    stroke() {},
    fillText() {},
    setTransform() {},
    save() {},
    restore() {},
    measureText: (t) => ({ width: String(t).length * 6 }),
  };
  return ctx;
}

const ctx = makeCtx();
const overlayCtx = makeCtx({ skipClear: true });
const canvasStub = (c) => ({ width: W, height: H, style: {}, getContext: () => c, getBoundingClientRect: () => ({ left: 0, top: 0, width: OW, height: OH }), addEventListener: () => {} });

globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };

const stage = { clientWidth: OW, clientHeight: OH };
const world = canvasStub(ctx);
const overlay = canvasStub(overlayCtx);

const agents = createAgents(AGENT_DEFS);
const renderer = new Renderer({ stage, world, overlay, agents });
renderer.resize();

const ui = { setAgentStatus: () => {}, addTokens: () => {} };

// cena: dois agentes conversando no corredor, um trabalhando, um pensando
const events = [
  { type: 'agent_thinking', agentId: 'planner', text: 'quebrando o objetivo em tarefas' },
  { type: 'tool_call', agentId: 'coder', tool: 'run_tests', args: 'parser' },
  { type: 'agent_thinking', agentId: 'reviewer', text: 'olhando o diff' },
  { type: 'agent_message', agentId: 'researcher', to: 'planner', text: 'achei 3 concorrentes' },
];
for (const ev of events) applyEvent(agents, ev, ui);

// roda alguns frames para sair do lugar
let t = 0;
for (let i = 0; i < 70; i++) {
  t += 16.7;
  for (const a of Object.values(agents)) a.update(16.7, t);
}
renderer.draw(t);

// --- PNG -------------------------------------------------------------------
const raw = Buffer.alloc((OW * 4 + 1) * OH);
for (let y = 0; y < OH; y++) {
  raw[y * (OW * 4 + 1)] = 0;
  buf.copy(raw, y * (OW * 4 + 1) + 1, y * OW * 4, (y + 1) * OW * 4);
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OW, 0);
ihdr.writeUInt32BE(OH, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] || 'preview.png';
writeFileSync(out, png);
console.log(`preview: ${out} (${OW}x${OH}, ${(png.length / 1024).toFixed(0)} kB)`);
