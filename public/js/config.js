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

// Onde o agente senta (pe do sprite) e onde ele fica em pe na frente da mesa.
// Duas instancias dividem a mesma mesa: slot 0 senta a esquerda, slot 1 a
// direita. Com uma instancia so, ela fica no centro.
const SLOT_DX = [-18, 18];
const slotOffset = (slot, slots) => (slots > 1 ? SLOT_DX[slot] ?? 0 : 0);

export const seatOf = (i, slot = 0, slots = 1) => ({
  x: DESK.xs[i] + 44 + slotOffset(slot, slots),
  y: DESK.top + 8,
});
export const standOf = (i, slot = 0, slots = 1) => ({
  x: DESK.xs[i] + 44 + slotOffset(slot, slots),
  y: DESK.top + DESK.h + 18,
});

// Mesa de reuniao no centro-baixo
export const MEETING = { x: 240, y: 214, rx: 48, ry: 21 };

// Oito lugares em volta da mesa: tres atras, dois nas pontas, tres na frente.
// Da para sentar os 7 agentes sem sprite sobreposto.
export const MEETING_SPOTS = [
  { x: 208, y: 176, side: 'back' },
  { x: 240, y: 173, side: 'back' },
  { x: 272, y: 176, side: 'back' },
  { x: 172, y: 214, side: 'left' },
  { x: 308, y: 214, side: 'right' },
  { x: 208, y: 252, side: 'front' },
  { x: 240, y: 255, side: 'front' },
  { x: 272, y: 252, side: 'front' },
];

// Botao desenhado sobre o tampo da mesa: chama todo mundo para a reuniao.
export const MEETING_BUTTON = { x: 212, y: 202, w: 56, h: 16 };

/** O ponto (coordenadas do mundo) esta sobre o botao da mesa? */
export const hitMeetingButton = (wx, wy) =>
  wx >= MEETING_BUTTON.x &&
  wx <= MEETING_BUTTON.x + MEETING_BUTTON.w &&
  wy >= MEETING_BUTTON.y &&
  wy <= MEETING_BUTTON.y + MEETING_BUTTON.h;

// Helpers de cor. Ficam aqui em cima porque buildAgentList() ja os usa para
// gerar a paleta das instancias 2, 3... (usar antes da definicao cairia em TDZ).
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

// Quantas instancias de cada funcao executora existem na cena.
// Precisa bater com AGENTS_PER_ROLE do servidor; o /api/state confirma.
export const AGENTS_PER_ROLE = 2;

// Modelo-base de cada papel. As instancias herdam e so mudam a paleta.
const ROLE_BASE = [
  {
    role: 'planner',
    name: 'Planner',
    roleName: 'Orquestrador',
    model: 'carregando...',
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
    role: 'researcher',
    name: 'Researcher',
    roleName: 'Pesquisa',
    model: 'carregando...',
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
    role: 'coder',
    name: 'Coder',
    roleName: 'Implementacao',
    model: 'carregando...',
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
    role: 'reviewer',
    name: 'Reviewer',
    roleName: 'Revisao',
    model: 'carregando...',
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

/**
 * Nome proprio de cada agente.
 *
 * O id tecnico ("coder-2") continua sendo a chave de tudo (eventos, API,
 * guarda de escrita). O nome e so para a tela: fica acima da cabeca no
 * cenario e no card do roster, porque "Coder 2" nao diz nada sobre quem e.
 * A letra inicial segue a funcao (R de pesquisa, C de codigo, V de revisao),
 * entao da para achar quem e sem decorar.
 */
const AGENT_NAMES = {
  planner: ['Ada'],
  researcher: ['Rita', 'Rui'],
  coder: ['Caio', 'Clara'],
  reviewer: ['Vera', 'Vito'],
};

/** Nome proprio do agente; cai no nome do papel se a lista for curta. */
export function nameForRole(role, index = 0) {
  const list = AGENT_NAMES[role];
  if (!list || !list.length) return role;
  return list[index % list.length];
}

/**
 * Monta a lista de agentes da cena.
 *
 * O Planner e unico (so existe um planejamento por execucao). Cada papel
 * executor ganha AGENTS_PER_ROLE instancias: "coder-1", "coder-2". Elas
 * dividem a mesma mesa, sentadas lado a lado, e a segunda usa um tom mais
 * escuro de camisa para dar para distinguir no pixel.
 */
function buildAgentList() {
  const list = [];

  for (const base of ROLE_BASE) {
    const count = base.role === 'planner' ? 1 : AGENTS_PER_ROLE;

    for (let i = 0; i < count; i++) {
      const id = count > 1 ? `${base.role}-${i + 1}` : base.role;
      const tint = count > 1 ? i * 0.1 : 0;
      const person = nameForRole(base.role, i);

      list.push({
        id,
        role: base.role,
        index: i,
        // Nome proprio: e o que aparece acima da cabeca.
        name: person,
        // Rotulo completo para listas e logs: "Caio · Implementacao".
        label: `${person} · ${base.roleName}`,
        roleName: base.roleName,
        model: base.model,
        accent: base.accent,
        desk: base.desk,
        slot: i,
        slots: count,
        pal: {
          ...base.pal,
          // instancia 2+: camisa mais escura, cabelo levemente diferente
          shirt: shade(base.pal.shirt, -tint),
          shirt2: shade(base.pal.shirt2, -tint),
          hair: i === 0 ? base.pal.hair : shade(base.pal.hair, 0.12),
        },
      });
    }
  }

  return list;
}

export const AGENT_LIST = buildAgentList();

// Lista enriquecida com as posicoes no mundo (o que o AgentView consome)
export const AGENT_DEFS = AGENT_LIST.map((a, i) => ({
  ...a,
  seat: seatOf(a.desk, a.slot, a.slots),
  stand: standOf(a.desk, a.slot, a.slots),
  home: seatOf(a.desk, a.slot, a.slots),
  // Lugar fixo na mesa de reuniao: cada agente sempre senta no mesmo lugar,
  // entao a cena nao "embaralha" entre uma reuniao e outra.
  meetSpot: MEETING_SPOTS[i % MEETING_SPOTS.length],
}));

export const AGENTS = Object.fromEntries(AGENT_DEFS.map((a) => [a.id, a]));

/** Ids curtos por papel: ['coder-1', 'coder-2'] para role 'coder'. */
export const instancesOfRole = (role) => AGENT_LIST.filter((a) => a.role === role).map((a) => a.id);

/**
 * Descobre o agente de um id de evento.
 *
 * O servidor manda ids de instancia ('coder-2'); eventos antigos ou de
 * fallback podem mandar so o papel ('coder'). Nesse caso usamos a primeira
 * instancia, para o log nunca ficar sem rotulo.
 */
export const agentOf = (id) =>
  AGENTS[id] || AGENTS[instancesOfRole(id)[0]] || null;

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
