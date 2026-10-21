// Maquina de estados de um agente na tela.
//
// Recebe eventos e traduz em uma fila de acoes: andar, falar, trabalhar.
// Isso desacopla o "mundo dos eventos" do "mundo dos pixels".

const WALK_SPEED = 0.075; // px do mundo por ms (~75 px/s)
const MAX_QUEUE = 10; // acima disso, acoes antigas sao descartadas

export class AgentView {
  constructor(def) {
    this.def = def;
    this.pos = { ...def.seat };
    this.home = { ...def.seat };
    this.state = 'idle';
    this.restState = 'idle';
    this.facing = 1;
    this.queue = [];
    this.current = null;
    this.bubble = null;
    this.flash = 0;
    this.inMeeting = false;
  }

  // -- API -------------------------------------------------------------------

  reset() {
    this.queue.length = 0;
    this.current = null;
    this.bubble = null;
    this.state = 'idle';
    this.restState = 'idle';
    this.facing = 1;
    this.inMeeting = false;
    this.pos = { ...this.home };
  }

  setState(state) {
    this.state = state;
    if (state !== 'walking') this.restState = state;
  }

  say(text, tone = 'talk', ms = 2200) {
    this._push({ kind: 'say', text, tone, ms });
  }

  /** Balao imediato, sem passar pela fila (feedback de ferramenta/pensamento). */
  sayNow(text, tone = 'talk', ms = 2200) {
    const now = performance.now();
    this.bubble = { text, tone, born: now, until: now + ms };
  }

  goTo(x, y) {
    const startY = this.pos.y;
    if (Math.abs(this.pos.x - x) > 1) this._push({ kind: 'move', x, y: startY });
    if (Math.abs(startY - y) > 1) this._push({ kind: 'move', x, y });
  }

  goHome() {
    this.goTo(this.home.x, this.home.y);
    this._push({ kind: 'state', state: 'working' });
  }

  faceToward(other) {
    if (!other) return;
    this.facing = other.pos.x < this.pos.x ? -1 : 1;
  }

  /**
   * Vai para o seu lugar na mesa de reuniao e senta.
   *
   * O lugar e fixo por agente (def.meetSpot), entao a cena nao embaralha entre
   * uma reuniao e outra. Limpa a fila antes: se o agente estava no meio de uma
   * conversa, ele vai direto para a mesa em vez de terminar o trajeto antigo.
   */
  goMeet() {
    const spot = this.def.meetSpot;
    if (!spot) return;

    this.queue.length = 0;
    this.current = null;
    this.inMeeting = true;

    // dois trechos para nao atravessar a mesa: alinha em x, depois vai em y.
    this._push({ kind: 'move', x: spot.x, y: this.pos.y });
    this._push({ kind: 'move', x: spot.x, y: spot.y });
    this._push({ kind: 'state', state: 'thinking' });
  }

  /** Levanta da mesa e volta para a propria estacao. */
  leaveMeeting() {
    if (!this.inMeeting) return;
    this.inMeeting = false;
    this.queue.length = 0;
    this.current = null;
    this.state = 'idle';
    this._autoReturn();
  }

  /** O agente esta no seu lugar da mesa? (para o anel de destaque) */
  atMeetingSpot() {
    const spot = this.def.meetSpot;
    if (!spot) return false;
    return Math.hypot(this.pos.x - spot.x, this.pos.y - spot.y) < 2;
  }

  // -- ciclo de vida ---------------------------------------------------------

  _push(action) {
    if (this.queue.length >= MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE + 1);
    this.queue.push(action);
  }

  _atHome() {
    return Math.hypot(this.pos.x - this.home.x, this.pos.y - this.home.y) < 1.5;
  }

  // Agente ocioso nunca fica largado no meio da sala: volta pra mesa.
  // Excecao: na reuniao ele fica sentado onde esta.
  _autoReturn() {
    if (this.inMeeting) return;
    this._push({ kind: 'move', x: this.home.x, y: this.pos.y });
    this._push({ kind: 'move', x: this.home.x, y: this.home.y });
    this._push({ kind: 'state', state: 'working' });
  }

  _advance(now) {
    while (this.queue.length) {
      const a = this.queue.shift();
      if (a.kind === 'state') {
        this.state = a.state;
        if (a.state !== 'walking') this.restState = a.state;
        continue;
      }
      if (a.kind === 'say') {
        this.bubble = { text: a.text, tone: a.tone, born: now, until: now + a.ms };
        this.current = { kind: 'wait', remaining: a.ms };
        return;
      }
      this.current = a.kind === 'wait' ? { kind: 'wait', remaining: a.ms } : a;
      return;
    }
    this.current = null;
  }

  update(dt, now) {
    if (this.bubble && now > this.bubble.until) this.bubble = null;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);

    if (!this.current) {
      this._advance(now);
      if (!this.current) {
        if (this.state === 'walking') this.state = this.restState;
        if (!this._atHome()) this._autoReturn();
        return;
      }
    }

    const a = this.current;

    if (a.kind === 'wait') {
      a.remaining -= dt;
      if (a.remaining <= 0) this.current = null;
      return;
    }

    if (a.kind === 'move') {
      const dx = a.x - this.pos.x;
      const dy = a.y - this.pos.y;
      const dist = Math.hypot(dx, dy);
      const step = WALK_SPEED * dt;

      this.state = 'walking';

      if (dist <= step || dist < 0.4) {
        this.pos.x = a.x;
        this.pos.y = a.y;
        this.current = null;
        if (!this.queue.length) this.state = this.restState;
        return;
      }

      this.pos.x += (dx / dist) * step;
      this.pos.y += (dy / dist) * step;
      if (Math.abs(dx) > 0.05) this.facing = dx > 0 ? 1 : -1;
    }
  }
}

export function createAgents(agentList) {
  const map = {};
  for (const def of agentList) map[def.id] = new AgentView(def);
  return map;
}
