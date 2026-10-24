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
    this._html = '';
    this.hidden = false;
    this.disabled = false;
    this.parentNode = null;
    this.listeners = {};
  }

  /**
   * innerHTML precisa se comportar como no DOM real: atribuir '' LIMPA os
   * filhos. Sem isso, `el.innerHTML = ''` num elemento do teste deixava os
   * filhos antigos no lugar e as asserções viam listas duplicadas.
   */
  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value ?? '');
    if (this._html === '') this.children.length = 0;
  }

  /** className alimenta o classList, como no DOM real. */
  get className() {
    return [...this.classList._s].join(' ');
  }

  set className(value) {
    this.classList._s = new Set(String(value ?? '').split(/\s+/).filter(Boolean));
  }

  /** textContent agrega o dos filhos, como no DOM real. */
  get textContent() {
    if (this.children.length) {
      return this.children.map((c) => c.textContent ?? '').join('');
    }
    return this._text ?? '';
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children.length = 0;
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
  {
    const models = [
      { id: 'planner', role: 'planner', modelRef: { model: 'deepseek-v4.1-flash-free', ref: 'verboo:deepseek-v4.1-flash-free' } },
      { id: 'researcher', role: 'researcher', modelRef: { model: 'glm-5.3-flash-free' } },
      { id: 'coder', role: 'coder', modelRef: { model: 'kimi-k2.7-code' } },
      { id: 'reviewer', role: 'reviewer', modelRef: { model: 'claude-haiku-5-5' } },
    ];
    ui.setAgentModels(models);
    expect(ui.cards.get('coder-1').model.textContent === 'kimi-k2.7-code', 'card deve mostrar modelo configurado no servidor');
    expect(ui.cards.get('coder-2').model.textContent === 'kimi-k2.7-code', 'instancias do mesmo papel devem mostrar modelo novo');
    const { agentOf } = await import('../public/js/config.js');
    expect(agentOf('reviewer-1').model === 'claude-haiku-5-5', 'definicao da cena deve receber modelo novo');
    ui.setAgentModels(models.map((item) => item.role === 'coder'
      ? { ...item, modelRef: { model: '<modelo-novo>' } }
      : item));
    expect(ui.cards.get('coder-1').model.textContent === '<modelo-novo>', 'troca futura deve atualizar texto sem HTML');
  }
  ui.renderDiff({ files: [], branch: 'agent-town/run_test', committed: true, commit: 'a'.repeat(40) });
  expect(ui.btnPublish.disabled === false, 'commit dos agentes deve habilitar publicacao');
  let publishClicks = 0;
  handlers.onPublish = () => { publishClicks++; };
  ui.btnPublish.dispatch('click');
  expect(publishClicks === 1, 'um clique deve solicitar a publicacao');
  ui.resetDiff();
  expect(ui.btnPublish.disabled === true, 'nova execucao deve limpar a publicacao anterior');
  ui.renderDiff({ files: [], branch: 'agent-town/run_test', committed: false });
  expect(ui.btnPublish.disabled === true, 'falha no commit nao deve permitir publicar');
  ui.resetDiff();

  // métodos que o main.js chama — todos precisam existir.
  const required = [
    'addEvent',
    'addTokens',
    'resetTokens',
    'clearLog',
    'renderEvents',
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
    'setMeeting',
    'renderMeeting',
    'decideMeeting',
    'resetMeeting',
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

  // -------------------------------------------------------------------------
  // Card de eventos: renderEvents precisa REPOVOAR a partir do snapshot.
  //
  // Este era o bug: handlers.js chamava `ui.renderEvents?.(list)`, o metodo
  // nao existia, e recarregar a pagina no meio de uma execucao deixava o card
  // vazio mesmo com 150 eventos guardados no servidor.
  // -------------------------------------------------------------------------
  {
    ui.renderEvents(sample);
    const depoisDoSnapshot = ui.logEl.children.length;
    expect(depoisDoSnapshot > 0, `renderEvents deveria repovoar o log, ficou com ${depoisDoSnapshot}`);

    // e nao pode duplicar: repovoar duas vezes da o mesmo tamanho
    ui.renderEvents(sample);
    expect(
      ui.logEl.children.length === depoisDoSnapshot,
      `renderEvents deveria limpar antes de repovoar (${depoisDoSnapshot} -> ${ui.logEl.children.length})`,
    );

    // lista vazia nao pode quebrar
    ui.renderEvents([]);
    expect(ui.logEl.children.length === 0, 'renderEvents([]) deveria limpar o log');
    expect(ui.emptyEl.hidden === false, 'com log vazio, o aviso "Nenhum evento" deveria voltar');
  }

  // -------------------------------------------------------------------------
  // Card da reuniao
  // -------------------------------------------------------------------------
  {
    const propostas = [
      {
        id: 'p_coder-1',
        agentId: 'coder-1',
        agentName: 'Caio',
        kind: 'visual',
        title: 'Cadeado no agente bloqueado',
        why: 'nao da para ver quem travou',
        how: 'desenhar acima da cabeca',
        files: ['public/js/sprite.js'],
        effort: 'pequeno',
        benefits: 'reduz dúvidas durante a execução',
        risks: 'o indicador pode cobrir a animação',
        impact: 'alto',
        complexity: 'pequeno',
        dependencies: ['status de tarefa'],
        createdAt: 1730000000000,
        feedback: [{ agentId: 'reviewer-1', agentName: 'Vera', critique: 'validar contraste', suggestion: 'adicionar teste visual' }],
        votes: [{ agentId: 'reviewer-1', agentName: 'Vera', value: 'adjust', comment: 'boa proposta' }],
        status: 'proposal',
      },
      {
        id: 'p_reviewer-1',
        agentId: 'reviewer-1',
        agentName: 'Vera',
        kind: 'implementacao',
        title: 'Botao de reexecutar so a tarefa que falhou',
        why: '',
        how: '',
        files: [],
        effort: 'medio',
        status: 'proposal',
      },
    ];

    ui.setMeeting({ active: true, busy: false, proposals: propostas, target: 'C:\\agent-town' });

    expect(ui.meetingPanel.hidden === false, 'o card deveria aparecer com propostas');
    expect(ui.meetingList.children.length === 2, `deveria renderizar 2 propostas, tem ${ui.meetingList.children.length}`);
    expect(ui.meetingList.children[0].textContent.includes('riscos: o indicador'), 'o card deveria exibir riscos');
    expect(ui.meetingList.children[0].textContent.includes('crítica: validar contraste'), 'o card deveria exibir crítica');
    expect(ui.meetingList.children[0].textContent.includes('voto ajustar'), 'o card deveria exibir voto');
    expect(ui.meetingMeta.textContent.includes('2 card'), `meta deveria contar: ${ui.meetingMeta.textContent}`);

    // selecionar uma proposta habilita o botao de implementar
    expect(ui.btnMeetingApprove.disabled === true, 'sem selecao, o botao deveria estar desabilitado');
    ui.meetingSelection.add('p_coder-1');
    ui.renderMeeting();
    expect(ui.btnMeetingApprove.disabled === false, 'com selecao, o botao deveria habilitar');
    expect(
      ui.btnMeetingApprove.textContent.includes('aprovar e implementar 1'),
      `o botao deveria avisar que aprova e inicia a implementacao: ${ui.btnMeetingApprove.textContent}`,
    );

    // decideMeeting repassa a selecao para o handler
    let recebido = null;
    handlers.onMeetingDecide = (payload) => {
      recebido = payload;
    };
    ui.decideMeeting({ approve: ['p_coder-1'] });
    expect(recebido?.approve?.[0] === 'p_coder-1', `deveria repassar a aprovacao: ${JSON.stringify(recebido)}`);

    // proposta aprovada sai da selecao e ganha selo
    ui.setMeeting({
      active: true,
      busy: false,
      proposals: [{ ...propostas[0], status: 'approved' }, propostas[1]],
    });
    expect(ui.meetingSelection.size === 0, 'proposta aprovada nao deveria continuar selecionavel');
    const aprovada = ui.meetingList.children[0];
    expect(aprovada.dataset.status === 'approved', 'a proposta aprovada deveria mudar de status');
    expect(aprovada.querySelector('.proposal-status')?.textContent === 'aprovada', 'deveria ganhar selo');
    expect(aprovada.querySelector('.proposal-implement')?.disabled === true, 'projeto nao inicia antes de fechar a reuniao');

    let projectProposal = null;
    handlers.onMeetingImplement = (ids) => {
      projectProposal = ids[0];
    };
    ui.setMeeting({ active: false, busy: false, proposals: [{ ...propostas[0], status: 'approved' }] });
    ui.meetingList.children[0].querySelector('.proposal-implement')?.dispatch('click');
    expect(projectProposal === propostas[0].id, 'cada proposta aprovada deveria iniciar seu proprio projeto');

    // rejeitadas permanecem no historico
    ui.setMeeting({ active: true, busy: false, proposals: [propostas[0], { ...propostas[1], status: 'rejected' }] });
    expect(ui.meetingList.children.length === 2, 'proposta rejeitada deveria permanecer no card');
    expect(ui.meetingList.children[1].dataset.status === 'rejected', 'proposta rejeitada precisa mostrar o status');

    // estado vazio esconde o card
    ui.setMeeting({ active: false, busy: false, proposals: [] });
    expect(ui.meetingPanel.hidden === true, 'sem nada, o card deveria sumir');

    // busy mostra o aviso
    ui.setMeeting({ active: true, busy: true, proposals: [] });
    expect(ui.meetingList.children.length === 1, 'durante a reuniao deveria mostrar o aviso de andamento');
    expect(ui.btnMeetingApprove.disabled === true, 'durante a reuniao nao da para aprovar');

    // erro do servidor aparece
    ui.setMeeting({ active: true, busy: false, proposals: [], error: 'nenhum agente devolveu proposta' });
    expect(
      ui.meetingList.textContent.includes('nenhum agente'),
      'o erro deveria aparecer no card',
    );
  }

  // eventos novos da reuniao nao podem quebrar o log
  for (const ev of [
    { type: 'meeting_started', agentId: null, agents: [] },
    { type: 'proposal', agentId: 'coder-1', proposal: { title: 'x', kind: 'visual' } },
    { type: 'meeting_done', agentId: null, meeting: { proposals: [] } },
  ]) {
    try {
      ui.addEvent({ id: 'm', ts: Date.now(), ...ev });
    } catch (err) {
      problems.push(`addEvent(${ev.type}) lançou: ${err.message}`);
    }
  }
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
