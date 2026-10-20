// Verifica que a UI carrega e constroi com um DOM falso.
//
// POR QUE ESTE TESTE EXISTE: o smoke.mjs substitui `ui` por um mock, entao
// ui.js nunca era executado em teste nenhum. Um erro dentro dele (id errado,
// metodo inexistente, elemento faltando) passava por toda a suite — e no
// navegador o modulo quebrava, o main.js nao rodava e a tela ficava preta,
// sem nenhum agente.
//
// Aqui montamos o DOM minimo a partir dos ids reais do index.html, para que
// qualquer referencia a elemento inexistente apareca como falha.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const expect = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// --- ids que realmente existem no HTML --------------------------------------
const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// --- DOM falso ---------------------------------------------------------------
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); return this._s.has(c); },
      contains(c) { return this._s.has(c); },
    };
    this.textContent = '';
    this.value = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.parentNode = null;
    this.listeners = {};
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(k, v) { this.dataset[k] = v; }
  getAttribute(k) { return this.dataset[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatch(type, ev = {}) { for (const f of this.listeners[type] || []) f({ target: this, ...ev }); }
  querySelector(sel) {
    if (sel.startsWith('#')) return document.getElementById(sel.slice(1));
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    if (cls) {
      const find = (el) => {
        for (const c of el.children) {
          if (c.classList?.contains(cls)) return c;
          const r = find(c);
          if (r) return r;
        }
        return null;
      };
      return find(this) || new FakeEl();
    }
    return new FakeEl();
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
}

const byId = new Map();
const document = {
  getElementById(id) {
    if (!byId.has(id)) {
      // só cria se o id existir no HTML: referência a id inexistente vira erro
      if (!htmlIds.has(id)) {
        problems.push(`ui.js pediu o id "${id}", que NAO existe no index.html`);
        return null;
      }
      byId.set(id, new FakeEl('div', id));
    }
    return byId.get(id);
  },
  createElement(tag) { return new FakeEl(tag); },
  createTextNode(t) { return { textContent: t }; },
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    return new FakeEl();
  },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  body: new FakeEl('body'),
  documentElement: new FakeEl('html'),
};

const store = new Map();
globalThis.document = document;
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
globalThis.EventSource = class { constructor() { this.onmessage = null; } close() {} };

// --- carrega e exercita ------------------------------------------------------
try {
  const { UI } = await import('../public/js/ui.js');

  const handlers = {
    onRun() {},
    onStop() {},
    onSpeed() {},
    onSelect() {},
    onTheme() {},
  };

  const ui = new UI(handlers);

  // métodos que o main.js chama — todos precisam existir.
  // renderEvents não entra na lista: handlers.js chama com `?.` porque é
  // opcional, e a UI atual repovoa o log por outro caminho.
  const required = [
    'addEvent',
    'addTokens',
    'resetTokens',
    'clearLog',
    'setRunState',
    'setAgentStatus',
    'renderPlan',
    'resetPlan',
    'markPlanTask',
    'renderDiff',
    'resetDiff',
    'selectAgent',
    'setMode',
    'renderRateLimit',
  ];

  for (const m of required) {
    expect(typeof ui[m] === 'function', `UI.${m} deveria ser funcao (main.js chama)`);
  }

  // eventos que o servidor emite precisam ser aceitos sem lançar
  const sample = [
    { id: '1', ts: Date.now(), type: 'run_started', agentId: null, label: 'Projeto real', cycle: 1 },
    { id: '2', ts: Date.now(), type: 'plan_created', agentId: 'planner', tasks: [{ id: 't1', agent: 'coder-1', instruction: 'x', dependsOn: [] }], waveCount: 1 },
    { id: '3', ts: Date.now(), type: 'agent_spawned', agentId: 'coder-1' },
    { id: '4', ts: Date.now(), type: 'agent_thinking', agentId: 'coder-1', text: 'analisando' },
    { id: '5', ts: Date.now(), type: 'tool_call', agentId: 'coder-1', tool: 'read_file', args: 'a.js' },
    { id: '6', ts: Date.now(), type: 'tool_result', agentId: 'coder-1', tool: 'read_file', ok: true, summary: '3 linhas' },
    { id: '7', ts: Date.now(), type: 'token_usage', agentId: 'coder-1', in: 10, out: 5, cost: 0.001 },
    { id: '8', ts: Date.now(), type: 'rate_limit', remaining: 38, limit: 40, resetAt: null },
    { id: '9', ts: Date.now(), type: 'agent_done', agentId: 'coder-1', summary: 'ok', taskId: 't1' },
    { id: '10', ts: Date.now(), type: 'agent_error', agentId: 'coder-1', text: 'falhou' },
    { id: '11', ts: Date.now(), type: 'diff_ready', files: ['a.js'], diff: '+x', branch: 'agent-town/x', committed: true },
    { id: '12', ts: Date.now(), type: 'run_finished', agentId: null, reason: 'budget', error: 'teto', hint: 'aumente MAX_TOKENS' },
  ];

  for (const ev of sample) {
    try {
      ui.addEvent(ev);
    } catch (err) {
      problems.push(`addEvent(${ev.type}) lançou: ${err.message}`);
    }
  }

  // caminhos chamados pelo main.js
  const calls = [
    ['resetTokens', () => ui.resetTokens()],
    ['resetPlan', () => ui.resetPlan()],
    ['resetDiff', () => ui.resetDiff()],
    ['clearLog', () => ui.clearLog()],
    ['setRunState', () => ui.setRunState({ running: true, speed: 1, totals: { in: 1, out: 2, cost: 0 } })],
    ['setRunState(parado)', () => ui.setRunState({ running: false })],
    ['setMode', () => ui.setMode('real', { projectsEnabled: true })],
    ['setAgentStatus', () => ui.setAgentStatus('coder-1', 'trabalhando', 'working')],
    ['setAgentStatus(null)', () => ui.setAgentStatus(null, 'erro', 'error')],
    ['addTokens', () => ui.addTokens('coder-1', 100)],
    ['selectAgent', () => ui.selectAgent('coder-1')],
    ['selectAgent(null)', () => ui.selectAgent(null)],
    ['renderRateLimit', () => ui.renderRateLimit()],
    ['markPlanTask', () => ui.markPlanTask('t1', 'done')],
  ];

  for (const [label, fn] of calls) {
    try {
      fn();
    } catch (err) {
      problems.push(`${label} lançou: ${err.message}`);
    }
  }

  // o log não pode crescer sem limite
  for (let i = 0; i < 500; i++) {
    ui.addEvent({ id: `x${i}`, ts: Date.now(), type: 'agent_thinking', agentId: 'coder-1', text: 'x' });
  }
  expect(
    !ui.logEl || ui.logEl.children.length <= 320,
    `o log deveria ser limitado (~300), tem ${ui.logEl?.children.length}`,
  );
} catch (err) {
  problems.push(`ui.js nao carregou/construiu: ${err.message}\n${err.stack?.split('\n').slice(0, 4).join('\n')}`);
}

if (problems.length) {
  console.error(`${problems.length} problema(s):`);
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.log('OK — ui.js carrega, constroi e aceita todos os eventos');
}
