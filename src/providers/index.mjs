// Fábrica de provedores + semáforos por provedor.

import { createCompatProvider } from './openai.mjs';
import { createGeminiProvider } from './gemini.mjs';
import { Semaphore } from '../limiter.mjs';

export function createProvider(providerConfig, model) {
  if (providerConfig.kind === 'gemini') {
    return createGeminiProvider(providerConfig, model);
  }
  return createCompatProvider(providerConfig, model);
}

/**
 * Cria um provider por papel, compartilhando um semáforo por provedor.
 * Assim os 4 agentes nunca passam do limite de concorrência da API.
 */
export function createProvidersForRoles(config) {
  const limiters = {};
  for (const [key, p] of Object.entries(config.providers)) {
    limiters[key] = new Semaphore(p.concurrency, p.label);
  }

  const byRole = {};
  for (const [roleId, role] of Object.entries(config.roles)) {
    const ref = role.modelRef;
    if (!ref) continue;
    const providerConfig = config.providers[ref.providerKey];
    if (!providerConfig) continue;

    const provider = createProvider(providerConfig, ref.model);
    byRole[roleId] = {
      ...provider,
      role: roleId,
      roleName: role.name,
      limiter: limiters[ref.providerKey],
      get label() {
        return `${providerConfig.label} · ${ref.model}`;
      },
    };
  }

  return { byRole, limiters };
}
