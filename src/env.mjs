// Carregador de .env sem dependências.
// Node 20+ tem --env-file, mas assim funciona em qualquer versão e
// permite validar antes de subir o servidor.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Lê o .env e injeta em process.env sem sobrescrever variáveis
 * que já existem no ambiente (o ambiente sempre ganha).
 */
export function loadEnv(file = '.env') {
  const full = path.resolve(process.cwd(), file);
  const found = existsSync(full);
  const values = {};

  if (found) {
    for (const rawLine of readFileSync(full, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq < 0) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      values[key] = value;
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return { found, file: full, values };
}

/** Número do ambiente, com fallback e limites. */
export function envNumber(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(process.env[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** String do ambiente, com fallback. */
export function envString(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Mascara uma chave para exibição segura em log. */
export function mask(secret) {
  if (!secret) return '(vazia)';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
