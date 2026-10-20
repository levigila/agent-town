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
