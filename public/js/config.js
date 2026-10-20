// Geometria do mundo e definicao dos agentes.
// Tudo aqui esta em "pixels do mundo" (o canvas logico tem 480x304).

export const WORLD = { w: 480, h: 304 };
export const WALL_H = 48;

export const DESK = {
  w: 72,
  h: 26,
  top: 92,
  xs: [24, 144, 264, 384],
};

// Onde o agente senta (pe do sprite) e onde ele fica em pe na frente da mesa
export const seatOf = (i) => ({ x: DESK.xs[i] + 44, y: DESK.top + 8 });
export const standOf = (i) => ({ x: DESK.xs[i] + 44, y: DESK.top + DESK.h + 18 });

// Mesa de reuniao no centro-baixo
export const MEETING = { x: 240, y: 214, rx: 48, ry: 21 };
export const MEETING_SPOTS = [
  { x: 240, y: 178 },
  { x: 176, y: 214 },
  { x: 304, y: 214 },
  { x: 240, y: 250 },
];

export const AGENT_LIST = [
  {
    id: 'planner',
    name: 'Planner',
    role: 'Orquestrador',
    model: 'v4 pro',
    accent: '#a78bfa',
    desk: 0,
    pal: {
      skin: '#f0c49a',
      hair: '#2b2233',
      shirt: '#7c5cff',
      shirt2: '#5a3fd0',
      pants: '#2f2a45',
      shoe: '#151220',
    },
  },
  {
    id: 'researcher',
    name: 'Researcher',
    role: 'Pesquisa',
    model: 'GLM 5.3 Flash',
    accent: '#f5a623',
    desk: 1,
    pal: {
      skin: '#e8b184',
      hair: '#3b2a1a',
      shirt: '#f5a623',
      shirt2: '#c67f10',
      pants: '#2a3140',
      shoe: '#151220',
    },
  },
  {
    id: 'coder',
    name: 'Coder',
    role: 'Implementacao',
    model: 'v4.1 flash',
    accent: '#4be0c8',
    desk: 2,
    pal: {
      skin: '#f0c49a',
      hair: '#1d1d2b',
      shirt: '#20c9a6',
      shirt2: '#149c80',
      pants: '#25303f',
      shoe: '#151220',
    },
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Revisao',
    model: 'v4 flash vision',
    accent: '#4da3ff',
    desk: 3,
    pal: {
      skin: '#e0a97c',
      hair: '#4a3728',
      shirt: '#4da3ff',
      shirt2: '#2f7ad1',
      pants: '#2b3242',
      shoe: '#151220',
    },
  },
];

// Lista enriquecida com as posicoes no mundo (o que o AgentView consome)
export const AGENT_DEFS = AGENT_LIST.map((a) => ({
  ...a,
  seat: seatOf(a.desk),
  stand: standOf(a.desk),
  home: seatOf(a.desk),
}));

export const AGENTS = Object.fromEntries(AGENT_DEFS.map((a) => [a.id, a]));

// Rotulos amigaveis para os eventos no log
export const TOOL_LABELS = {
  read_file: 'ler arquivo',
  write_file: 'escrever arquivo',
  web_search: 'buscar na web',
  run_tests: 'rodar testes',
  screenshot: 'capturar tela',
  analyze_image: 'analisar imagem',
};

// -- personalizacao visual ---------------------------------------------------
// Tema do piso e cor da camisa de cada agente, persistidos no navegador.
// Mesma convencao do resto do projeto: chave 'agent-town:*', JSON e try/catch.

export const VISUALS_KEY = 'agent-town:visuals';
export const DEFAULT_THEME = 'dark';

// O tema "escuro" mantem exatamente as cores originais do cenario.
export const FLOOR_THEMES = {
  dark: { label: 'escuro', floorA: '#242a38', floorB: '#202632', seam: '#1a1f29' },
  light: { label: 'claro', floorA: '#d7d1c4', floorB: '#cdc7ba', seam: '#b9b3a6' },
  blue: { label: 'azul', floorA: '#1c3a5c', floorB: '#17324f', seam: '#12283f' },
};
export const THEME_IDS = Object.keys(FLOOR_THEMES);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Cor hex valida no formato #rrggbb (o que o <input type="color"> entrega). */
export const isHexColor = (value) => typeof value === 'string' && HEX_RE.test(value.trim());

/** Escurece (amount < 0) ou clareia (amount > 0) uma cor hex. */
export const shade = (hex, amount) => {
  if (!isHexColor(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.max(0, Math.min(255, Math.round(c + 255 * amount)));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

/** Camisa padrao do agente (fallback quando nao ha personalizacao). */
export const defaultShirtOf = (id) => AGENT_LIST.find((a) => a.id === id)?.pal.shirt || '#7c5cff';

// Estado corrente, compartilhado entre ui.js, world.js e sprite.js.
export const visuals = { theme: DEFAULT_THEME, shirts: {} };

let hydrated = false;
const hydrate = () => {
  if (!hydrated) {
    hydrated = true;
    loadVisuals();
  }
};

/** Cor da camisa configurada para o agente (ou o padrao dele). */
export const shirtOf = (id) => {
  hydrate();
  return visuals.shirts[id] || defaultShirtOf(id);
};

/** Paleta do piso selecionada. */
export const floorTheme = () => {
  hydrate();
  return FLOOR_THEMES[visuals.theme] || FLOOR_THEMES[DEFAULT_THEME];
};

/** Sanitiza o que veio do localStorage (tema conhecido, cores hex por agente). */
export function normalizeVisuals(raw) {
  const out = { theme: DEFAULT_THEME, shirts: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (THEME_IDS.includes(raw.theme)) out.theme = raw.theme;
  const shirts = raw.shirts && typeof raw.shirts === 'object' ? raw.shirts : {};
  for (const a of AGENT_LIST) {
    const color = shirts[a.id];
    if (isHexColor(color)) out.shirts[a.id] = color.trim().toLowerCase();
  }
  return out;
}

export function applyVisuals(next) {
  const clean = normalizeVisuals(next);
  visuals.theme = clean.theme;
  visuals.shirts = clean.shirts;
  hydrated = true;
  return visuals;
}

export function loadVisuals() {
  try {
    return applyVisuals(JSON.parse(localStorage.getItem(VISUALS_KEY) || 'null'));
  } catch {
    // localStorage indisponivel ou JSON invalido: volta ao padrao
    return applyVisuals(null);
  }
}

export function saveVisuals() {
  try {
    localStorage.setItem(VISUALS_KEY, JSON.stringify({ theme: visuals.theme, shirts: visuals.shirts }));
  } catch {
    /* localStorage indisponivel: segue so em memoria */
  }
  return visuals;
}

export function setTheme(theme) {
  if (THEME_IDS.includes(theme)) visuals.theme = theme;
  return saveVisuals();
}

export function setShirt(id, color) {
  if (!AGENTS[id] || !isHexColor(color)) return visuals;
  visuals.shirts[id] = color.trim().toLowerCase();
  return saveVisuals();
}

export function resetVisuals() {
  visuals.theme = DEFAULT_THEME;
  visuals.shirts = {};
  return saveVisuals();
}
