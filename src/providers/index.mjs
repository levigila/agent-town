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
 * Cria um provider por papel E por instância, compartilhando um semáforo
 * por provedor.
 *
 * O semáforo é o ponto crítico: ter 6 agentes não adianta se o plano da API
 * só permite 2 requisições simultâneas. As instâncias se revezam na fila.
 *
 * @param {object} config
 * @returns {{byRole: object, byInstance: object, limiters: object}}
 */
export function createProvidersForRoles(config) {
  const limiters = {};
  for (const [key, p] of Object.entries(config.providers)) {
    limiters[key] = new Semaphore(p.concurrency, p.label);
  }

  const byRole = {};

  const makeProvider = (roleId, roleName, ref) => {
    const providerConfig = config.providers[ref.providerKey];
    if (!providerConfig) return null;

    const provider = createProvider(providerConfig, ref.model);
    return {
      ...provider,
      role: roleId,
      roleName,
      limiter: limiters[ref.providerKey],
      get label() {
        return `${providerConfig.label} · ${ref.model}`;
      },
    };
  };

  for (const [roleId, role] of Object.entries(config.roles)) {
    const ref = role.modelRef;
    if (!ref) continue;
    const provider = makeProvider(roleId, role.name, ref);
    if (provider) byRole[roleId] = provider;
  }

  // Uma instância por agente (coder-1, coder-2...). Reaproveita o provider do
  // papel: mesma configuração e mesmo semáforo, mas cada agente roda a sua
  // própria conversa — o estado fica nas mensagens, não no provider.
  //
  // Agentes vindos do OpenCode não têm papel interno: eles trazem o próprio
  // modelRef, então criamos um provider novo (mas com o mesmo semáforo).
  const byInstance = {};
  for (const agent of config.agents || []) {
    const reuse = byRole[agent.role];
    if (reuse) {
      byInstance[agent.id] = reuse;
      continue;
    }

    const ref = agent.modelRef;
    if (!ref) continue;

    const provider = makeProvider(agent.id, agent.name || agent.id, ref);
    if (provider) byInstance[agent.id] = provider;
  }

  return { byRole, byInstance, limiters };
}
