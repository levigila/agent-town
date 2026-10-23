// UI da pagina: roster de agentes, log de eventos e controles.

import {
  AGENT_LIST,
  TOOL_LABELS,
  THEME_IDS,
  FLOOR_THEMES,
  DEFAULT_THEME,
  visuals,
  loadVisuals,
  setTheme,
  setShirt,
  shirtOf,
  agentOf,
} from './config.js';

const STATE_LABEL = {
  idle: 'ocioso',
  walking: 'andando',
  working: 'trabalhando',
  thinking: 'pensando',
  done: 'concluido',
  error: 'erro',
};

const MAX_LOG = 300;

/** Rotulo curto do tipo de proposta (espelha src/brainstorm.mjs). */
const KIND_LABEL = {
  visual: 'visual',
  agente: 'novo agente',
  implementacao: 'implementacao',
  processo: 'processo',
};

const PROPOSAL_STATUS = {
  proposal: 'proposta',
  analysis: 'em análise',
  approved: 'aprovada',
  rejected: 'rejeitada',
  implementing: 'em implementação',
  validating: 'em validação',
  completed: 'concluída',
  archived: 'arquivada',
};

const VOTE_LABEL = { approve: 'aprovar', adjust: 'ajustar', reject: 'rejeitar' };

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString('pt-BR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Escapa texto vindo do modelo antes de injetar em innerHTML. */
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Escapa valor para atributo (inclusive aspas simples). */
const escapeAttr = (value) => escapeHtml(value).replace(/'/g, '&#39;');

export class UI {
  constructor(handlers) {
    this.handlers = handlers;
    this.filter = null;
    this.cards = new Map();
    this.tokens = {};
    this.logEl = document.getElementById('log');
    this.rosterEl = document.getElementById('roster');
    this.statusEl = document.getElementById('runStatus');
    this.btnRun = document.getElementById('btnRun');
    this.btnStop = document.getElementById('btnStop');
    this.speedEl = document.getElementById('speed');
    this.emptyEl = document.getElementById('logEmpty');

    this.taskEl = document.getElementById('taskInput');
    this.modeEl = document.getElementById('modeSelect');
    this.templateEl = document.getElementById('templateSelect');
    this.projectEl = document.getElementById('projectInput');
    this.templateField = document.getElementById('templateField');
    this.projectField = document.getElementById('projectField');
    this.modeBadge = document.getElementById('modeBadge');
    this.rateBadge = document.getElementById('rateBadge');

    this.planPanel = document.getElementById('planPanel');
    this.planList = document.getElementById('planList');
    this.planMeta = document.getElementById('planMeta');
    this.planRows = new Map();

    this.diffPanel = document.getElementById('diffPanel');
    this.diffBody = document.getElementById('diffBody');
    this.diffMeta = document.getElementById('diffMeta');

    // card da reuniao (propostas de melhoria)
    this.meetingPanel = document.getElementById('meetingPanel');
    this.meetingList = document.getElementById('meetingList');
    this.meetingMeta = document.getElementById('meetingMeta');
    this.meetingFoot = document.getElementById('meetingFoot');
    this.btnMeetingApprove = document.getElementById('btnMeetingApprove');
    this.btnMeetingReject = document.getElementById('btnMeetingReject');
    this.btnMeetingStop = document.getElementById('btnMeetingStop');
    this.meetingSelection = new Set();
    this.meetingState = { active: false, busy: false, proposals: [] };

    this.recentEl = document.getElementById('recentProjects');
    this.picker = {
      dialog: document.getElementById('pickerDialog'),
      path: document.getElementById('pickerPath'),
      list: document.getElementById('pickerList'),
      note: document.getElementById('pickerNote'),
      up: document.getElementById('pickerUp'),
      home: document.getElementById('pickerHome'),
      pick: document.getElementById('pickerPick'),
      close: document.getElementById('pickerClose'),
    };
    this.pickerState = { path: '', parent: null };

    // personalizacao visual (tema do piso + camisa por agente)
    this.themeEl = null;
    this.shirtEls = new Map();

    this.buildVisuals();
    this.buildRoster();
    this.wire();
  }

  wire() {
    this.btnRun.addEventListener('click', () => this.handlers.onRun(this.getRequest()));
    this.btnStop.addEventListener('click', () => this.handlers.onStop());
    this.speedEl.addEventListener('change', () => this.handlers.onSpeed(Number(this.speedEl.value)));
    document.getElementById('btnClear').addEventListener('click', () => this.clearLog());

    this.modeEl.addEventListener('change', () => this.syncMode());

    this.btnMeetingApprove?.addEventListener('click', () => {
      this.decideMeeting({ approve: [...this.meetingSelection] });
    });
    this.btnMeetingReject?.addEventListener('click', () => {
      this.decideMeeting({ reject: [...this.meetingSelection] });
    });
    this.btnMeetingStop?.addEventListener('click', () => this.handlers.onMeetingStop?.());
    this.taskEl.addEventListener('keydown', (e) => {
      // Ctrl+Enter inicia sem sair do campo
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !this.btnRun.disabled) {
        e.preventDefault();
        this.handlers.onRun(this.getRequest());
      }
    });

    document.getElementById('btnBrowse').addEventListener('click', () => this.openPicker());
    this.picker.close.addEventListener('click', () => this.picker.dialog.close());
    this.picker.up.addEventListener('click', () => {
      if (this.pickerState.parent) this.loadPicker(this.pickerState.parent);
    });
    this.picker.home.addEventListener('click', () => this.loadPicker(''));
    this.picker.pick.addEventListener('click', () => {
      if (this.pickerState.path) {
        this.projectEl.value = this.pickerState.path;
        this.rememberProject(this.pickerState.path);
        this.picker.dialog.close();
      }
    });

    this.wireVisuals();
    this.syncMode();
  }

  // -- personalizacao visual ------------------------------------------------

  /**
   * Monta o bloco de personalizacao no painel lateral: select do tema do piso
   * e um <input type="color"> por agente para a camisa. Os valores iniciais
   * vem do localStorage (config.loadVisuals), com fallback no padrao.
   */
  buildVisuals() {
    loadVisuals();

    const box = document.createElement('section');
    box.className = 'visuals-panel';
    box.id = 'visualsPanel';
    box.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:8px 0;';

    const title = document.createElement('div');
    title.className = 'visuals-title';
    title.textContent = 'personalizacao';
    title.style.cssText = 'font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;';
    box.appendChild(title);

    // tema do piso
    const themeRow = document.createElement('label');
    themeRow.className = 'visuals-row';
    themeRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    themeRow.innerHTML = '<span>piso</span>';

    const select = document.createElement('select');
    select.id = 'themeSelect';
    select.className = 'theme-select';
    select.innerHTML = THEME_IDS.map(
      (id) => `<option value="${escapeAttr(id)}">${escapeHtml(FLOOR_THEMES[id].label)}</option>`,
    ).join('');
    select.value = FLOOR_THEMES[visuals.theme] ? visuals.theme : DEFAULT_THEME;
    themeRow.appendChild(select);
    box.appendChild(themeRow);

    // camisa por agente
    const shirts = document.createElement('div');
    shirts.className = 'visuals-shirts';
    shirts.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

    for (const def of AGENT_LIST) {
      const row = document.createElement('label');
      row.className = 'visuals-row';
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

      const name = document.createElement('span');
      name.textContent = def.name;

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'shirt-input';
      input.id = `shirt-${def.id}`;
      input.dataset.agent = def.id;
      input.value = shirtOf(def.id);

      row.append(name, input);
      shirts.appendChild(row);
      this.shirtEls.set(def.id, input);
    }
    box.appendChild(shirts);

    // insere logo antes do roster (fica no topo do painel lateral)
    this.visualsEl = box;
    this.themeEl = select;
    if (this.rosterEl?.parentNode) this.rosterEl.parentNode.insertBefore(box, this.rosterEl);
    else document.body.appendChild(box);
  }

  wireVisuals() {
    this.themeEl?.addEventListener('change', () => {
      setTheme(this.themeEl.value);
      this.handlers.onTheme?.(this.themeEl.value);
    });

    for (const [id, input] of this.shirtEls) {
      // 'input' pinta ao vivo; o valor so e persistido se for hex valido
      input.addEventListener('input', () => {
        setShirt(id, input.value);
        this.handlers.onShirt?.(id, input.value);
      });
    }
  }

  /** Reaplica os valores salvos nos controles (ex: ao iniciar a pagina). */
  syncVisuals() {
    if (this.themeEl) this.themeEl.value = FLOOR_THEMES[visuals.theme] ? visuals.theme : DEFAULT_THEME;
    for (const [id, input] of this.shirtEls) input.value = shirtOf(id);
  }

  // -- seletor de pastas ----------------------------------------------------

  async openPicker() {
    const start = this.projectEl.value.trim();
    this.picker.dialog.showModal();
    await this.loadPicker(start);
  }

  async loadPicker(target) {
    this.picker.list.innerHTML = '<li class="picker-note">carregando…</li>';
    this.picker.note.textContent = '';

    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(target || '')}`);
      const data = await res.json();

      if (!data.ok) {
        this.picker.list.innerHTML = '';
        this.picker.note.textContent = data.error || 'nao foi possivel abrir esta pasta';
        return;
      }

      this.pickerState = { path: data.path, parent: data.parent };
      this.picker.path.textContent = data.path;
      this.picker.up.disabled = !data.parent;

      if (!data.entries.length) {
        this.picker.list.innerHTML = '<li class="picker-note">nenhuma subpasta</li>';
      } else {
        this.picker.list.innerHTML = data.entries
          .map(
            (e) => `
            <li>
              <button class="picker-item" type="button" data-path="${escapeAttr(e.path)}">
                <span class="folder-icon">▸</span>
                <span>${escapeHtml(e.name)}</span>
                ${e.isRepo ? '<span class="repo-badge">git</span>' : ''}
              </button>
            </li>`,
          )
          .join('');

        for (const btn of this.picker.list.querySelectorAll('.picker-item')) {
          btn.addEventListener('click', () => this.loadPicker(btn.dataset.path));
        }
      }

      this.picker.note.textContent = data.isRepo
        ? 'esta pasta é um repositório git — pode ser usada'
        : 'esta pasta não é um repositório git; escolha uma que tenha o selo "git"';
    } catch (err) {
      this.picker.list.innerHTML = '';
      this.picker.note.textContent = `falha ao listar: ${err.message}`;
    }
  }

  /** Guarda os últimos caminhos usados no próprio navegador. */
  rememberProject(path) {
    try {
      const key = 'agent-town:recent-projects';
      const list = JSON.parse(localStorage.getItem(key) || '[]').filter((p) => p !== path);
      list.unshift(path);
      const top = list.slice(0, 8);
      localStorage.setItem(key, JSON.stringify(top));
      this.renderRecent();
    } catch {
      /* localStorage indisponível: segue sem sugestões */
    }
  }

  renderRecent() {
    try {
      const list = JSON.parse(localStorage.getItem('agent-town:recent-projects') || '[]');
      this.recentEl.innerHTML = list
        .map((p) => `<option value="${escapeAttr(p)}"></option>`)
        .join('');
    } catch {
      /* ignora */
    }
  }

  /** Corpo enviado para /api/run. */
  getRequest() {
    return {
      task: this.taskEl.value.trim(),
      mode: this.modeEl.value,
      projectPath: this.projectEl.value.trim(),
      template: this.templateEl.value,
      speed: Number(this.speedEl.value),
    };
  }

  /** Mostra o campo certo conforme o modo escolhido. */
  syncMode() {
    const isProject = this.modeEl.value === 'project';
    this.projectField.hidden = !isProject;
    this.templateField.hidden = isProject;

    if (isProject && !this.taskEl.value.trim()) {
      this.taskEl.placeholder = 'O que deve ser feito neste projeto? Ex: extraia a validação de CPF para um helper';
    } else {
      this.taskEl.placeholder =
        'O que os agentes devem fazer? Ex: implemente parsePrice em src/price.mjs conforme SPEC.md';
    }
  }

  /**
   * Mostra as requisicoes restantes na janela do provedor.
   *
   * Este e o consumo REAL de uma chave de plano: o limite e por requisicao,
   * nao por token. O valor em dolar do rodape e so uma estimativa local.
   */
  renderRateLimit() {
    const el = this.rateBadge;
    if (!el) return;

    const rl = this.rateLimit;
    if (!rl || rl.remaining === null || rl.remaining === undefined) {
      el.hidden = true;
      return;
    }

    el.hidden = false;
    el.textContent = `${rl.remaining}/${rl.limit ?? '?'} req`;
    el.dataset.tone = rl.remaining <= 0 ? 'out' : rl.remaining <= 5 ? 'low' : 'ok';
    el.title = rl.resetAt
      ? `Requisicoes restantes na janela · renova as ${new Date(rl.resetAt).toLocaleTimeString('pt-BR')}`
      : 'Requisicoes restantes na janela do provedor';
  }

  setMode(mode, { projectsEnabled } = {}) {
    const real = mode === 'real';
    this.modeBadge.textContent = real ? 'real · api' : 'simulado';
    this.modeBadge.classList.toggle('is-real', real);

    if (projectsEnabled === false) {
      const opt = this.modeEl.querySelector('option[value="project"]');
      if (opt) {
        opt.disabled = true;
        opt.textContent = 'projeto real (indisponível)';
      }
      document.getElementById('btnBrowse').disabled = true;
      this.projectEl.placeholder = 'servidor exposto sem PROJECT_ROOTS';
    }

    this.renderRecent();
  }

  // -- plano ----------------------------------------------------------------

  renderPlan(ev) {
    this.planRows.clear();
    this.planList.innerHTML = '';

    const tasks = ev.tasks || [];
    this.planPanel.hidden = false;
    this.planMeta.textContent = `${tasks.length} tarefa(s) · ${ev.waveCount} onda(s)${
      ev.fellBack ? ' · fallback' : ''
    }`;

    for (const task of tasks) {
      const li = document.createElement('li');
      li.className = 'plan-item';
      li.dataset.task = task.id;
      li.style.setProperty('--accent', agentOf(task.agent)?.accent || '#4be0c8');
      li.innerHTML = `
        <span class="plan-id">${escapeHtml(task.id)}</span>
        <span class="plan-agent">${escapeHtml(task.agent)}</span>
        <span class="plan-text">${escapeHtml(task.instruction)}${
          task.dependsOn?.length
            ? `<span class="plan-deps">depende de: ${escapeHtml(task.dependsOn.join(', '))}</span>`
            : ''
        }</span>
      `;
      this.planList.appendChild(li);
      this.planRows.set(task.id, li);
    }
  }

  markPlanTask(taskId, state) {
    const row = this.planRows.get(taskId);
    if (!row) return;
    row.classList.remove('is-running', 'is-done', 'is-failed');
    if (state === 'running') row.classList.add('is-running');
    if (state === 'done') row.classList.add('is-done');
    if (state === 'failed') row.classList.add('is-failed');
  }

  markAgentRunning(agentId) {
    for (const [id, row] of this.planRows) {
      if (row.querySelector('.plan-agent')?.textContent === agentId) {
        if (!row.classList.contains('is-done') && !row.classList.contains('is-failed')) {
          row.classList.add('is-running');
        }
      }
    }
  }

  resetPlan() {
    this.planRows.clear();
    this.planList.innerHTML = '';
    this.planPanel.hidden = true;
    this.planMeta.textContent = '';
  }

  // -- diff -----------------------------------------------------------------

  renderDiff(ev) {
    this.diffPanel.hidden = false;
    const files = ev.files || [];
    const count = files.length;

    this.diffMeta.textContent = `${count} arquivo(s) · branch ${ev.branch}${ev.committed ? ' · commit ok' : ''}`;

    const chips = files
      .map(
        (f) =>
          `<span class="diff-file" data-status="${escapeHtml(f.status[0] || '?')}">${escapeHtml(f.file)}</span>`,
      )
      .join('');

    const body = (ev.diff || '')
      .split('\n')
      .map((line) => {
        const safe = escapeHtml(line);
        if (line.startsWith('+++') || line.startsWith('---')) return `<span class="hunk">${safe}</span>`;
        if (line.startsWith('+')) return `<span class="add">${safe}</span>`;
        if (line.startsWith('-')) return `<span class="del">${safe}</span>`;
        if (line.startsWith('@@')) return `<span class="hunk">${safe}</span>`;
        return safe;
      })
      .join('\n');

    this.diffBody.innerHTML =
      `<div class="diff-files">${chips}</div>` +
      (body || '<span class="hunk">(sem diff)</span>') +
      (ev.truncated ? '\n<span class="hunk">… diff truncado</span>' : '');
  }

  resetDiff() {
    this.diffPanel.hidden = true;
    this.diffBody.innerHTML = '';
    this.diffMeta.textContent = '';
  }

  // -- reuniao: propostas de melhoria ---------------------------------------

  /**
   * Atualiza o card da reuniao.
   *
   * @param {object} m estado vindo do servidor (ou do evento meeting_done)
   */
  setMeeting(m) {
    this.meetingState = {
      active: !!m?.active,
      busy: !!m?.busy,
      proposals: Array.isArray(m?.proposals) ? m.proposals : [],
      errors: Array.isArray(m?.errors) ? m.errors : [],
      error: m?.error || null,
      target: m?.target || '',
    };

    // Some com a selecao de propostas que nao existem mais
    const alive = new Set(this.meetingState.proposals.filter((p) => p.status === 'proposal').map((p) => p.id));
    for (const id of [...this.meetingSelection]) if (!alive.has(id)) this.meetingSelection.delete(id);

    this.renderMeeting();
  }

  renderMeeting() {
    const panel = this.meetingPanel;
    if (!panel) return;

    const { busy, proposals, errors, error, target } = this.meetingState;
    const visible = proposals;

    // O card so aparece quando ha algo para mostrar
    if (!busy && !visible.length && !error && !errors.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    const approved = proposals.filter((p) => p.status === 'approved').length;

    this.meetingMeta.textContent = busy
      ? 'os agentes estao pensando…'
      : [
          `${visible.length} card(s)`,
          approved ? `${approved} aprovada(s)` : '',
          target ? `alvo: ${target.split(/[\\/]/).pop()}` : '',
        ]
          .filter(Boolean)
          .join(' · ');

    this.meetingList.innerHTML = '';

    if (busy) {
      const li = document.createElement('li');
      li.className = 'proposal is-busy';
      li.textContent = 'reuniao em andamento — cada agente esta propondo uma melhoria';
      this.meetingList.appendChild(li);
    }

    for (const p of visible) {
      this.meetingList.appendChild(this.buildProposal(p));
    }

    // rodape: aprovar selecionadas
    const count = this.meetingSelection.size;
    if (this.btnMeetingApprove) {
      this.btnMeetingApprove.disabled = count === 0 || busy;
      this.btnMeetingApprove.textContent = count > 0 ? `aprovar ${count}` : 'aprovar';
    }
    if (this.btnMeetingReject) this.btnMeetingReject.disabled = count === 0 || busy;
    if (this.meetingFoot) this.meetingFoot.hidden = false;

    if (error) {
      const li = document.createElement('li');
      li.className = 'proposal is-err';
      li.textContent = error;
      this.meetingList.appendChild(li);
    }

    for (const e of errors.slice(0, 3)) {
      const li = document.createElement('li');
      li.className = 'proposal is-err';
      li.textContent = `${e.agentId}: ${e.problem}`;
      this.meetingList.appendChild(li);
    }
  }

  buildProposal(p) {
    const def = agentOf(p.agentId);
    const accent = def?.accent || '#4be0c8';

    const li = document.createElement('li');
    li.className = 'proposal';
    li.dataset.id = p.id;
    li.dataset.status = p.status || 'proposal';
    li.style.setProperty('--accent', accent);

    const head = document.createElement('div');
    head.className = 'proposal-head';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'proposal-check';
    check.checked = this.meetingSelection.has(p.id);
    check.disabled = !['proposal', 'analysis'].includes(p.status);
    check.addEventListener('change', () => {
      if (check.checked) this.meetingSelection.add(p.id);
      else this.meetingSelection.delete(p.id);
      this.renderMeeting();
    });

    const title = document.createElement('span');
    title.className = 'proposal-title';
    title.textContent = p.title;

    head.append(check, title);
    li.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'proposal-meta';
    meta.innerHTML = [
      `<span class="proposal-kind" data-kind="${escapeAttr(p.kind)}">${escapeHtml(KIND_LABEL[p.kind] || p.kind)}</span>`,
      `<span class="proposal-effort">complexidade: ${escapeHtml(p.complexity || p.effort)}</span>`,
      `<span class="proposal-effort">impacto: ${escapeHtml(p.impact || '—')}</span>`,
      `<span class="proposal-author" style="color:${escapeAttr(accent)}">${escapeHtml(p.agentName || p.agentId)}</span>`,
      `<span class="proposal-area">área: ${escapeHtml(p.role || '—')}</span>`,
      `<span class="proposal-id">${escapeHtml(p.id)}</span>`,
      p.createdAt ? `<span class="proposal-date">${escapeHtml(new Date(p.createdAt).toLocaleDateString('pt-BR'))}</span>` : '',
    ].join('');
    li.appendChild(meta);

    const status = document.createElement('span');
    status.className = 'proposal-status';
    status.textContent = PROPOSAL_STATUS[p.status] || p.status || 'proposta';
    li.appendChild(status);

    if (p.benefits || p.why) {
      const why = document.createElement('p');
      why.className = 'proposal-text';
      why.textContent = `benefício esperado: ${p.benefits || p.why}`;
      li.appendChild(why);
    }
    if (p.how) {
      const how = document.createElement('p');
      how.className = 'proposal-text is-how';
      how.textContent = p.how;
      li.appendChild(how);
    }
    if (p.files?.length) {
      const files = document.createElement('div');
      files.className = 'proposal-files';
      files.textContent = p.files.join(' · ');
      li.appendChild(files);
    }

    if (p.risks) {
      const risks = document.createElement('p');
      risks.className = 'proposal-text is-risk';
      risks.textContent = `riscos: ${p.risks}`;
      li.appendChild(risks);
    }
    if (p.dependencies?.length) {
      const deps = document.createElement('p');
      deps.className = 'proposal-text';
      deps.textContent = `dependências: ${p.dependencies.join(', ')}`;
      li.appendChild(deps);
    }
    for (const item of p.feedback || []) {
      for (const [label, value] of [['crítica', item.critique], ['ajuste sugerido', item.suggestion]]) {
        if (!value) continue;
        const feedback = document.createElement('p');
        feedback.className = 'proposal-text';
        feedback.textContent = `${item.agentName || item.agentId} · ${label}: ${value}`;
        li.appendChild(feedback);
      }
    }
    for (const vote of p.votes || []) {
      const entry = document.createElement('p');
      entry.className = 'proposal-text';
      entry.textContent = `voto ${VOTE_LABEL[vote.value] || vote.value}: ${vote.agentName || vote.agentId}${vote.comment ? ` — ${vote.comment}` : ''}`;
      li.appendChild(entry);
    }

    if (p.status === 'approved') {
      const implement = document.createElement('button');
      implement.className = 'ghost proposal-discard proposal-implement';
      implement.type = 'button';
      implement.disabled = this.meetingState.active || this.meetingState.busy;
      implement.textContent = 'implementar como projeto';
      implement.addEventListener('click', () => this.handlers.onMeetingImplement?.([p.id]));
      li.appendChild(implement);
    } else if (p.status === 'validating') {
      const complete = document.createElement('button');
      complete.className = 'ghost proposal-discard';
      complete.type = 'button';
      complete.textContent = 'marcar como concluída';
      complete.addEventListener('click', () =>
        this.handlers.onMeetingStatus?.({ id: p.id, status: 'completed' }),
      );
      li.appendChild(complete);
    } else if (!['completed', 'archived'].includes(p.status)) {
      const archive = document.createElement('button');
      archive.className = 'ghost proposal-discard';
      archive.type = 'button';
      archive.textContent = 'arquivar';
      archive.addEventListener('click', () =>
        this.handlers.onMeetingStatus?.({ id: p.id, status: 'archived' }),
      );
      li.appendChild(archive);
    }

    return li;
  }

  decideMeeting({ approve = [], reject = [], dismiss = [] }) {
    this.handlers.onMeetingDecide?.({ approve, reject, dismiss });
  }

  resetMeeting() {
    this.meetingSelection.clear();
    this.meetingState = { active: false, busy: false, proposals: [] };
    if (this.meetingPanel) this.meetingPanel.hidden = true;
    if (this.meetingList) this.meetingList.innerHTML = '';
  }

  // -- log de eventos -------------------------------------------------------

  /**
   * Repovoa o log a partir de uma lista de eventos (usado no snapshot).
   *
   * Sem isso, recarregar a pagina no meio de uma execucao deixava o card de
   * eventos vazio, mesmo com o servidor tendo 150 eventos guardados — o
   * handlers.js chamava `ui.renderEvents?.(...)` e o metodo nao existia.
   */
  renderEvents(list) {
    this.clearLog();
    const events = Array.isArray(list) ? list : [];
    for (const ev of events) {
      if (ev && ev.type) this.addEvent(ev);
    }
    if (events.length && this.emptyEl) this.emptyEl.hidden = true;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  buildRoster() {
    this.rosterEl.innerHTML = '';
    for (const def of AGENT_LIST) {
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.id = def.id;
      card.style.setProperty('--accent', def.accent);
      card.innerHTML = `
        <span class="card-dot"></span>
        <span class="card-body">
          <span class="card-top">
            <strong>${def.name}</strong>
            <span class="card-model">${def.model}</span>
          </span>
          <span class="card-sub">
            <span class="card-role">${def.roleName || def.role}</span>
            <span class="card-state">ocioso</span>
            <span class="card-tokens">0 tok</span>
          </span>
        </span>
      `;
      card.addEventListener('click', () => {
        const id = this.filter === def.id ? null : def.id;
        this.handlers.onSelect(id);
      });
      this.rosterEl.appendChild(card);
      this.cards.set(def.id, {
        root: card,
        state: card.querySelector('.card-state'),
        tokens: card.querySelector('.card-tokens'),
      });
    }
  }

  selectAgent(id) {
    this.filter = id;
    for (const [key, c] of this.cards) {
      c.root.classList.toggle('is-selected', key === id);
    }
    this.logEl.classList.toggle('is-filtered', !!id);
    this.applyFilter();
  }

  applyFilter() {
    for (const li of this.logEl.children) {
      const match = !this.filter || li.dataset.agent === this.filter;
      li.classList.toggle('is-hidden', !match);
    }
  }

  setRunState(state) {
    const running = !!state.running;
    this.statusEl.textContent = running ? 'executando' : 'parado';
    this.statusEl.classList.toggle('is-live', running);
    this.btnRun.disabled = running;
    this.btnStop.disabled = !running;
    if (state.speed) this.speedEl.value = String(state.speed);
  }

  setAgentStatus(id, label, tone) {
    const c = this.cards.get(id);
    if (!c) return;
    c.state.textContent = label;
    c.root.dataset.state = tone || 'idle';
  }

  addTokens(id, count) {
    this.tokens[id] = (this.tokens[id] || 0) + count;
    const c = this.cards.get(id);
    if (c) c.tokens.textContent = `${fmtTokens(this.tokens[id])} tok`;
  }

  resetTokens() {
    this.tokens = {};
    for (const c of this.cards.values()) c.tokens.textContent = '0 tok';
    for (const c of this.cards.values()) c.state.textContent = STATE_LABEL.idle;

    // O limite de requisicoes e do provedor, nao da execucao: ele continua
    // valendo entre execucoes, entao nao zeramos aqui. So limpamos se nunca
    // houve leitura.
    this.renderRateLimit();
  }

  clearLog() {
    this.logEl.innerHTML = '';
    if (this.emptyEl) this.emptyEl.hidden = false;
  }

  /** @returns {void} */
  addEvent(ev) {
    const entry = this.buildEntry(ev);
    if (!entry) return;

    if (this.emptyEl) this.emptyEl.hidden = true;

    const nearBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 48;
    this.logEl.appendChild(entry);
    while (this.logEl.children.length > MAX_LOG) this.logEl.removeChild(this.logEl.firstChild);
    if (nearBottom) this.logEl.scrollTop = this.logEl.scrollHeight;

    if (this.filter) this.applyFilter();
  }

  buildEntry(ev) {
    const li = document.createElement('li');
    li.className = 'entry';
    li.dataset.agent = ev.agentId || '';

    const time = document.createElement('span');
    time.className = 'entry-time';
    time.textContent = fmtTime(ev.ts);

    const who = document.createElement('span');
    who.className = 'entry-who';

    const msg = document.createElement('span');
    msg.className = 'entry-msg';

    const def = agentOf(ev.agentId);

    switch (ev.type) {
      case 'run_started':
        li.classList.add('is-run');
        who.textContent = 'RUN';
        msg.textContent = `${ev.label || 'execucao'} #${ev.cycle || 1} iniciada`;
        break;

      case 'rate_limit':
        // Consumo REAL de uma chave de plano: requisições na janela.
        li.classList.add('is-run');
        who.textContent = 'LIMITE';
        msg.textContent =
          `${ev.remaining ?? '?'}/${ev.limit ?? '?'} requisicoes restantes` +
          (ev.resetAt ? ` · renova ${new Date(ev.resetAt).toLocaleTimeString('pt-BR')}` : '');
        this.rateLimit = ev;
        this.renderRateLimit?.();
        break;

      case 'run_finished':
        li.classList.add('is-run');
        who.textContent = 'RUN';
        if (ev.reason === 'completed') {
          const extra = ev.unverified?.length ? ` · ${ev.unverified.length} sem teste` : '';
          msg.textContent = `concluido${extra}`;
        } else if (ev.reason === 'parcial') {
          msg.textContent = `concluido parcialmente${ev.failed?.length ? ` (falhou: ${ev.failed.join(', ')})` : ''}`;
        } else if (ev.reason === 'setup_failed') {
          msg.textContent = `falha na preparacao · ${ev.error || ''}`;
        } else if (ev.reason === 'budget') {
          msg.textContent = `parado por orcamento · ${ev.error || ''}${ev.hint ? ` · ${ev.hint}` : ''}`;
        } else {
          msg.textContent = `encerrado (${ev.reason || 'parado'})`;
        }
        break;

      case 'plan_created':
        li.classList.add('is-run');
        who.textContent = 'PLANO';
        msg.textContent = `${(ev.tasks || []).length} tarefas em ${ev.waveCount || 0} onda(s)${
          ev.fellBack ? ' · fallback do pipeline' : ''
        }`;
        break;

      case 'diff_ready':
        li.classList.add('is-run');
        who.textContent = 'GIT';
        msg.textContent = `${(ev.files || []).length} arquivo(s) em ${ev.branch}${
          ev.committed ? ' · commit feito (nunca push)' : ''
        }`;
        break;

      case 'agent_thinking':
        li.classList.add('is-think');
        who.textContent = def ? def.name.toUpperCase() : '?';
        msg.textContent = `pensando · ${ev.text}`;
        break;

      case 'agent_message':
        li.classList.add('is-msg');
        who.textContent = def ? def.name.toUpperCase() : '?';
        msg.textContent = `→ ${(ev.to || '').toUpperCase()}: ${ev.text}`;
        break;

      case 'tool_call':
        li.classList.add('is-tool');
        who.textContent = def ? def.name.toUpperCase() : '?';
        msg.textContent = `${TOOL_LABELS[ev.tool] || ev.tool}(${ev.args || ''})`;
        break;

      case 'tool_result':
        li.classList.add(ev.ok ? 'is-ok' : 'is-err');
        who.textContent = def ? def.name.toUpperCase() : '?';
        msg.textContent = `${ev.ok ? 'ok' : 'falhou'} · ${ev.tool} · ${ev.summary || ''}`;
        break;

      case 'agent_done':
        li.classList.add('is-ok');
        who.textContent = def ? def.name.toUpperCase() : '?';
        msg.textContent = `concluiu · ${ev.summary || ''}`;
        break;

      case 'agent_error':
        li.classList.add('is-err');
        who.textContent = def ? def.name.toUpperCase() : 'SYS';
        msg.textContent = ev.text || 'erro';
        break;

      case 'agent_spawned':
      case 'token_usage':
        return null;

      default:
        who.textContent = ev.agentId ? String(ev.agentId).toUpperCase() : 'SYS';
        msg.textContent = ev.type;
        break;
    }

    if (def) li.style.setProperty('--accent', def.accent);
    li.append(time, who, msg);
    return li;
  }
}
