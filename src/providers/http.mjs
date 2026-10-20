// HTTP com retry — 429 e 5xx sao esperados com limite de 2 requisicoes.

import { backoff, sleep } from '../limiter.mjs';

export class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false, body = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/**
 * POST JSON com retry exponencial.
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.headers
 * @param {object} opts.body
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.retries]
 * @param {(msg: string) => void} [opts.onRetry]
 */
export async function postJson({ url, headers, body, signal, retries = 3, onRetry, timeoutMs = 120000 }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: combined,
      });

      if (res.ok) {
        return await res.json();
      }

      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;

      if (retryable && attempt < retries) {
        const wait = backoff(attempt);
        onRetry?.(`HTTP ${res.status} — tentando de novo em ${wait}ms`);
        await sleep(wait, signal);
        lastError = new ProviderError(`HTTP ${res.status}`, { status: res.status, retryable: true, body: text });
        continue;
      }

      throw new ProviderError(
        `HTTP ${res.status}: ${text.slice(0, 400) || res.statusText}`,
        { status: res.status, retryable, body: text },
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        if (!err.retryable || attempt >= retries) throw err;
        lastError = err;
        continue;
      }

      if (signal?.aborted) throw new Error('abortado');

      const wrapped = wrapNetworkError(err);

      // Erro de certificado/proxy não melhora tentando de novo.
      if (!wrapped.retryable) throw wrapped;

      if (attempt < retries) {
        const wait = backoff(attempt);
        onRetry?.(`${wrapped.message} — tentando de novo em ${wait}ms`);
        await sleep(wait, signal);
        lastError = wrapped;
        continue;
      }
      throw wrapped;
    }
  }

  throw lastError || new ProviderError('falha desconhecida');
}

// Códigos que indicam rede corporativa (proxy com interceptação TLS).
const PROXY_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * O fetch do Node reporta qualquer falha de rede como "fetch failed",
 * escondendo a causa. Aqui a causa real (ENOTFOUND, SELF_SIGNED_CERT_IN_CHAIN…)
 * volta na mensagem — é a diferença entre "deu erro" e "seu proxy bloqueia".
 */
export function wrapNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';
  const detail = err?.cause?.message || '';

  if (PROXY_CODES.has(code)) {
    return new ProviderError(
      `TLS rejeitado (${code}) — rede corporativa com interceptação de certificado`,
      { retryable: false, body: code },
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ProviderError(`DNS nao resolveu (${code}) — confira a URL base`, { retryable: false, body: code });
  }

  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return new ProviderError(`conexao recusada (${code})`, { retryable: true, body: code });
  }

  const message = detail ? `${err.message} (${code || detail})` : err.message;
  return new ProviderError(message, { retryable: true, body: code });
}

export async function getJson({ url, headers, signal, timeoutMs = 30000 }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(url, { headers, signal: combined });
  } catch (err) {
    throw wrapNetworkError(err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  }
  return res.json();
}
