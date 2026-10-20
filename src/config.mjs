// Configuração derivada do ambiente.

import { envNumber, envString } from './env.mjs';

export const PROVIDERS = {
  verboo: {
    key: 'verboo',
    label: 'Verboo',
    kind: 'openai', // formato chat/completions
    apiKeyEnv: 'VERBOO_API_KEY',
    baseUrlEnv: 'VERBOO_BASE_URL',
    // Confirmado na documentação oficial (code.verboo.ai/en/docs/api):
    // GET /models e POST /chat/completions sob este prefixo.
    defaultBaseUrl: 'https://code.verboo.ai/router/v1',
    concurrencyEnv: 'VERBOO_CONCURRENCY',
    defaultConcurrency: 2,
  },
  gemini: {
    key: 'gemini',
    label: 'Gemini',
    kind: 'gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    concurrencyEnv: 'GEMINI_CONCURRENCY',
    defaultConcurrency: 4,
  },
};

/** Papéis que existem na tela, com o modelo padrão de cada um. */
export const ROLES = {
  planner: {
    id: 'planner',
    name: 'Planner',
    role: 'Orquestrador',
    envKey: 'PLANNER_MODEL',
    fallback: 'verboo:deepseek-v4.1-flash',
  },
  researcher: {
    id: 'researcher',
    name: 'Researcher',
    role: 'Pesquisa',
    envKey: 'RESEARCHER_MODEL',
    fallback: 'verboo:glm-5.3-flash',
  },
  coder: {
    id: 'coder',
    name: 'Coder',
    role: 'Implementacao',
    envKey: 'CODER_MODEL',
    fallback: 'verboo:deepseek-v4.1-flash',
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Revisao',
    envKey: 'REVIEWER_MODEL',
    // Família diferente do Coder: quem escreveu foi o DeepSeek,
    // quem revisa é o Qwen. Revisão cruzada pega mais erro.
    fallback: 'verboo:qwen3.8-27b',
  },
};

/**
 * Interpreta "provedor:modelo".
 * Sem prefixo, assume verboo.
 */
export function parseModelRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i < 0) return { providerKey: 'verboo', model: raw, ref: `verboo:${raw}` };
  const providerKey = raw.slice(0, i).trim().toLowerCase();
  const model = raw.slice(i + 1).trim();
  if (!PROVIDERS[providerKey]) return null;
  if (!model) return null;
  return { providerKey, model, ref: `${providerKey}:${model}` };
}

export function loadConfig() {
  const providers = {};

  for (const p of Object.values(PROVIDERS)) {
    providers[p.key] = {
      ...p,
      apiKey: envString(p.apiKeyEnv, ''),
      baseUrl: envString(p.baseUrlEnv, p.defaultBaseUrl).replace(/\/+$/, ''),
      concurrency: envNumber(p.concurrencyEnv, p.defaultConcurrency, { min: 1, max: 16 }),
    };
  }

  const roles = {};
  for (const r of Object.values(ROLES)) {
    const parsed = parseModelRef(envString(r.envKey, r.fallback));
    roles[r.id] = { ...r, modelRef: parsed || parseModelRef(r.fallback) };
  }

  const host = envString('HOST', '127.0.0.1');
  const projectRoots = parseRoots(envString('PROJECT_ROOTS', ''));

  return {
    mode: envString('ORCHESTRATOR', 'sim').toLowerCase(),
    providers,
    roles,
    limits: {
      maxSteps: envNumber('MAX_STEPS', 10, { min: 1, max: 40 }),
      maxTasks: envNumber('MAX_TASKS', 6, { min: 1, max: 12 }),
      budgetUsd: envNumber('BUDGET_USD', 0.5, { min: 0, max: 100 }),
      maxTokens: envNumber('MAX_TOKENS', 200000, { min: 0, max: 5_000_000 }),
      timeoutSec: envNumber('TIMEOUT_SEC', 600, { min: 10, max: 3600 }),
    },
    projectRoots,
    // Servidor local: só esta máquina alcança a API, então você escolhe
    // qualquer pasta sem lista fixa. Exposto: PROJECT_ROOTS é obrigatório.
    allowAnyPath: isLoopback(host),
    server: { port: envNumber('PORT', 4173, { min: 1, max: 65535 }), host },
  };
}

/** O host só é alcançável desta máquina? */
export function isLoopback(host) {
  if (!host) return true;
  const h = String(host).trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

/** "C:\a; C:\b" ou "C:\a,C:\b" -> array de caminhos. */
function parseRoots(raw) {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Diz o que falta para o modo real funcionar.
 * @returns {{ok: boolean, problems: string[], warnings: string[]}}
 */
export function validateRealMode(config) {
  const problems = [];
  const warnings = [];

  const used = new Set();
  for (const role of Object.values(config.roles)) {
    const ref = role.modelRef;
    if (!ref) {
      problems.push(`${role.name}: modelo invalido`);
      continue;
    }
    used.add(ref.providerKey);

    const provider = config.providers[ref.providerKey];
    if (!provider) {
      problems.push(`${role.name}: provedor "${ref.providerKey}" desconhecido`);
      continue;
    }
    if (isPlaceholderKey(provider.apiKey)) {
      problems.push(`${role.name} usa ${provider.label}, mas ${provider.apiKeyEnv} ainda tem o texto de exemplo`);
    } else if (!provider.apiKey) {
      problems.push(`${role.name} usa ${provider.label}, mas ${provider.apiKeyEnv} esta vazio no .env`);
    }
  }

  if (config.providers.verboo.apiKey && config.providers.verboo.concurrency > 2) {
    warnings.push(
      `VERBOO_CONCURRENCY=${config.providers.verboo.concurrency} — o plano informado permite 2 requisicoes simultaneas.`,
    );
  }

  if (!used.size) problems.push('nenhum provedor configurado');

  return { ok: problems.length === 0, problems, warnings };
}

/** Chave que ainda contem o texto de exemplo do .env.example. */
export function isPlaceholderKey(value) {
  return !!value && /COLE_SUA_CHAVE|SUA_CHAVE|sua-chave|placeholder|^x+$/i.test(value);
}
