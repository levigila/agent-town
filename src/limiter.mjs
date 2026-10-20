// Semáforo de concorrência.
//
// A Verboo aceita 2 requisições simultâneas. Sem isso, o orquestrador
// dispara 4 chamadas, toma 429 e a execução inteira falha.

export class Semaphore {
  constructor(limit = 1, label = '') {
    this.limit = Math.max(1, Math.floor(limit) || 1);
    this.label = label;
    this.active = 0;
    this.queue = [];
    this.peak = 0;
  }

  get pending() {
    return this.queue.length;
  }

  stats() {
    return { label: this.label, limit: this.limit, active: this.active, pending: this.queue.length, peak: this.peak };
  }

  _acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  _release() {
    const next = this.queue.shift();
    if (next) {
      // a vaga passa direto para o próximo da fila
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  /** Executa fn respeitando o limite. */
  async run(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }
}

/** Espera com backoff exponencial + jitter. */
export function backoff(attempt, baseMs = 600, capMs = 12000) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = Math.random() * 0.3 * exp;
  return Math.round(exp + jitter);
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('abortado'));
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('abortado'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
