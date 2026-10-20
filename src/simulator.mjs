// Simulador de orquestracao multi-agente.
//
// ESTE E O ARQUIVO QUE VOCE TROCA PELO ORQUESTRADOR REAL.
//
// Ele so precisa emitir os mesmos eventos. O contrato e:
//
//   { id, ts, type, agentId, runId, ...payload }
//
// Tipos suportados pelo frontend:
//   run_started    { label, cycle }
//   run_finished   { reason, total }
//   agent_spawned  { cycle }
//   agent_thinking { text }
//   agent_message  { to, text }
//   tool_call      { tool, args }
//   tool_result    { tool, ok, summary }
//   token_usage    { model, in, out, cost }
//   agent_done     { summary }
//   agent_error    { text }
//
// Nada aqui e aleatorio de verdade: e um roteiro. Isso deixa a demo
// deterministica, revisavel e sem custo de API.

let seq = 0;
const nextId = () => `e${(++seq).toString(36).padStart(4, '0')}`;

const AGENT_IDS = ['planner', 'researcher', 'coder', 'reviewer'];

class AbortRun extends Error {}

const clampSpeed = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(8, Math.max(0.5, n));
};

export class Simulator {
  constructor(emit) {
    this.emit = emit;
    this.running = false;
    this.speed = 1;
    this.runId = null;
    this._token = 0;
    this.totals = { in: 0, out: 0, cost: 0 };
    this.perAgent = {};
  }

  getState() {
    return {
      running: this.running,
      speed: this.speed,
      runId: this.runId,
      totals: { ...this.totals },
      perAgent: JSON.parse(JSON.stringify(this.perAgent)),
    };
  }

  // -- emissao ---------------------------------------------------------------

  emitEvent(type, agentId = null, payload = {}) {
    const ev = { id: nextId(), ts: Date.now(), type, agentId, runId: this.runId, ...payload };
    this.emit(ev);
    return ev;
  }

  usage(agentId, model, tin, tout, cost) {
    const acc = (this.perAgent[agentId] ||= { model, in: 0, out: 0, cost: 0 });
    acc.in += tin;
    acc.out += tout;
    acc.cost += cost;
    this.totals.in += tin;
    this.totals.out += tout;
    this.totals.cost += cost;
    this.emitEvent('token_usage', agentId, { model, in: tin, out: tout, cost });
  }

  // -- controle --------------------------------------------------------------

  /**
   * Aceita tanto um número (velocidade) quanto o objeto vindo da API.
   * O simulador ignora tarefa e projeto: ele só demonstra o fluxo visual.
   */
  start(options) {
    const speed = typeof options === 'number' ? options : options?.speed;
    if (speed != null) this.speed = clampSpeed(speed);
    if (this.running) return this.getState();

    this.running = true;
    this.runId = `run_${Date.now().toString(36)}`;
    this.totals = { in: 0, out: 0, cost: 0 };
    this.perAgent = {};

    const token = ++this._token;
    this.loop(token).catch((err) => {
      if (err instanceof AbortRun) return;
      console.error('[simulator] falhou', err);
      this.running = false;
    });
    return this.getState();
  }

  stop() {
    if (!this.running) return this.getState();
    this.running = false;
    this._token += 1;
    this.emitEvent('run_finished', null, { reason: 'stopped', total: { ...this.totals } });
    return this.getState();
  }

  setSpeed(speed) {
    this.speed = clampSpeed(speed);
    return this.getState();
  }

  // -- infraestrutura --------------------------------------------------------

  _alive(token) {
    return this.running && token === this._token;
  }

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, Math.max(15, ms / this.speed)));
    if (!this.running) throw new AbortRun();
  }

  async loop(token) {
    let cycle = 1;
    this.emitEvent('run_started', null, { label: 'Ciclo de desenvolvimento', cycle });
    try {
      while (this._alive(token)) {
        await this.playScenario(token, cycle);
        await this.sleep(2600);
        cycle += 1;
        if (!this._alive(token)) break;
        this.emitEvent('run_started', null, { label: 'Ciclo de desenvolvimento', cycle });
      }
    } catch (err) {
      if (!(err instanceof AbortRun)) throw err;
    }
  }

  // -- roteiro ---------------------------------------------------------------

  async playScenario(token, cycle) {
    const ev = (type, agent, payload) => this.emitEvent(type, agent, payload);
    const wait = (ms) => this.sleep(ms);
    const alive = () => this._alive(token);

    for (const id of AGENT_IDS) ev('agent_spawned', id, { cycle });
    await wait(500);
    if (!alive()) return;

    // --- planejamento -------------------------------------------------------
    ev('agent_thinking', 'planner', { text: 'Objetivo: parser de precos. Vou quebrar em tarefas.' });
    this.usage('planner', 'v4 pro', 1840, 96, 0.0042);
    await wait(1500);

    ev('tool_call', 'planner', { tool: 'read_file', args: 'docs/spec.md' });
    await wait(950);
    ev('tool_result', 'planner', { tool: 'read_file', ok: true, summary: '142 linhas' });
    await wait(500);

    ev('agent_message', 'planner', { to: 'researcher', text: 'Levanta 3 concorrentes e o preco medio' });
    await wait(2500);
    if (!alive()) return;

    // --- pesquisa -----------------------------------------------------------
    ev('agent_thinking', 'researcher', { text: 'Busca: preco medio de similar no varejo' });
    this.usage('researcher', 'GLM 5.3 Flash', 620, 210, 0.0004);
    await wait(1000);

    ev('tool_call', 'researcher', { tool: 'web_search', args: 'preco similar 2025' });
    await wait(1400);
    ev('tool_result', 'researcher', { tool: 'web_search', ok: true, summary: '3 resultados' });
    await wait(450);

    ev('agent_message', 'researcher', { to: 'planner', text: 'Achei 3 concorrentes · media R$ 42,90' });
    this.usage('researcher', 'GLM 5.3 Flash', 380, 140, 0.0003);
    await wait(2400);
    if (!alive()) return;

    // --- implementacao ------------------------------------------------------
    ev('agent_message', 'planner', { to: 'coder', text: 'Implementa o parser seguindo o spec' });
    await wait(2200);

    ev('agent_thinking', 'coder', { text: 'Vou tratar virgula decimal e simbolo de moeda' });
    this.usage('coder', 'v4.1 flash', 2100, 480, 0.0011);
    await wait(900);

    ev('tool_call', 'coder', { tool: 'write_file', args: 'src/parser.js' });
    await wait(1500);
    ev('tool_result', 'coder', { tool: 'write_file', ok: true, summary: 'novo arquivo' });
    await wait(350);

    ev('tool_call', 'coder', { tool: 'run_tests', args: 'parser' });
    await wait(1350);
    ev('tool_result', 'coder', { tool: 'run_tests', ok: false, summary: '2 falhas: input vazio' });
    await wait(900);

    ev('agent_thinking', 'coder', { text: 'Input vazio quebra o split. Corrigindo...' });
    await wait(950);

    ev('tool_call', 'coder', { tool: 'write_file', args: 'src/parser.js' });
    await wait(1250);
    ev('tool_result', 'coder', { tool: 'write_file', ok: true, summary: 'patch aplicado' });
    await wait(300);

    ev('tool_call', 'coder', { tool: 'run_tests', args: 'parser' });
    await wait(1200);
    ev('tool_result', 'coder', { tool: 'run_tests', ok: true, summary: '18/18 passando' });
    this.usage('coder', 'v4.1 flash', 1450, 620, 0.0009);
    await wait(400);

    ev('agent_message', 'coder', { to: 'reviewer', text: 'PR #12 pronto, revisa?' });
    await wait(2400);
    if (!alive()) return;

    // --- revisao ------------------------------------------------------------
    ev('agent_thinking', 'reviewer', { text: 'Vou olhar o diff renderizado e o comportamento' });
    this.usage('reviewer', 'v4 flash vision exp', 3400, 320, 0.0026);
    await wait(950);

    ev('tool_call', 'reviewer', { tool: 'screenshot', args: 'checkout.html' });
    await wait(900);
    ev('tool_result', 'reviewer', { tool: 'screenshot', ok: true, summary: '1280x800' });
    await wait(300);

    ev('tool_call', 'reviewer', { tool: 'analyze_image', args: 'diff' });
    await wait(1150);
    ev('tool_result', 'reviewer', { tool: 'analyze_image', ok: true, summary: 'sem regressao visual' });
    await wait(400);

    ev('agent_message', 'reviewer', { to: 'coder', text: 'Faltou tratar input vazio no fallback' });
    await wait(2300);

    ev('agent_message', 'coder', { to: 'reviewer', text: 'Corrigido, valida de novo' });
    await wait(2300);
    if (!alive()) return;

    ev('tool_call', 'reviewer', { tool: 'run_tests', args: 'parser' });
    await wait(1200);
    ev('tool_result', 'reviewer', { tool: 'run_tests', ok: true, summary: '18/18 passando' });
    this.usage('reviewer', 'v4 flash vision exp', 900, 180, 0.0008);
    await wait(350);

    ev('agent_message', 'reviewer', { to: 'planner', text: 'Aprovado ✓' });
    await wait(2100);
    if (!alive()) return;

    // --- encerramento -------------------------------------------------------
    ev('agent_done', 'coder', { summary: 'parser implementado e testado' });
    await wait(450);
    ev('agent_done', 'researcher', { summary: '3 concorrentes mapeados' });
    await wait(450);
    ev('agent_done', 'reviewer', { summary: 'PR #12 aprovado' });
    await wait(450);
    ev('agent_done', 'planner', { summary: 'tarefa concluida' });
    await wait(900);

    this.emitEvent('run_finished', null, { reason: 'completed', cycle, total: { ...this.totals } });
    await wait(600);
  }
}
