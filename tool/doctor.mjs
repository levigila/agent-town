// Diagnóstico: verifica .env, chaves e conectividade com cada provedor.
//
//   npm run doctor
//
// Roda sem gastar quase nada: só uma chamada curta por provedor configurado.

import { loadEnv, mask } from '../src/env.mjs';
import { loadConfig, validateRealMode } from '../src/config.mjs';
import { createProvider } from '../src/providers/index.mjs';

const OK = '\x1b[32m✔\x1b[0m';
const BAD = '\x1b[31m\u2716\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const line = (icon, text, extra = '') => console.log(`  ${icon} ${text}${extra ? ` ${DIM}${extra}${OFF}` : ''}`);

// Detecta o texto de exemplo que ficou no lugar da chave real.
const isPlaceholder = (value) => !!value && /COLE_SUA_CHAVE|SUA_CHAVE|sua-chave|xxx+|placeholder/i.test(value);

async function main() {
  console.log('\nagent-town · diagnóstico\n');

  const env = loadEnv('.env');
  console.log('Arquivo .env');
  if (!env.found) {
    line(WARN, 'não encontrado', '→ Copy-Item .env.example .env');
    console.log(`  ${DIM}seguindo com as variáveis de ambiente do sistema, se houver${OFF}`);
  } else {
    line(OK, env.file);
  }

  const config = loadConfig();

  console.log('\nChaves');
  for (const p of Object.values(config.providers)) {
    const value = p.apiKey;
    if (isPlaceholder(value)) {
      line(WARN, `${p.label.padEnd(8)} ainda com o texto de exemplo`, `troque por ${p.apiKeyEnv}`);
    } else if (value) {
      line(OK, `${p.label.padEnd(8)} ${mask(value)}`, `concorrência ${p.concurrency}`);
    } else {
      line(WARN, `${p.label.padEnd(8)} vazia`, p.apiKeyEnv);
    }
  }

  console.log('\nPapéis');
  for (const role of Object.values(config.roles)) {
    const ref = role.modelRef;
    line(OK, `${role.name.padEnd(11)} ${ref ? ref.ref : '(inválido)'}`);
  }

  console.log('\nModo');
  line(OK, `ORCHESTRATOR=${config.mode}`);
  const check = validateRealMode(config);
  for (const p of check.problems) line(BAD, p);
  for (const w of check.warnings) line(WARN, w);

  if (config.mode !== 'real') {
    console.log(`\n${DIM}Para testar as APIs, defina ORCHESTRATOR=real no .env${OFF}\n`);
  }

  // --- conectividade -------------------------------------------------------
  const toTest = new Map();
  for (const role of Object.values(config.roles)) {
    const ref = role.modelRef;
    if (!ref) continue;
    const provider = config.providers[ref.providerKey];
    if (!provider?.apiKey || isPlaceholder(provider.apiKey)) continue;
    if (!toTest.has(ref.providerKey)) toTest.set(ref.providerKey, { provider, model: ref.model });
  }

  if (!toTest.size) {
    console.log('\nNenhum provedor com chave real para testar.');
    console.log(`${DIM}Preencha VERBOO_API_KEY e GEMINI_API_KEY no .env e rode de novo.${OFF}\n`);
    return;
  }

  console.log('\nConectividade');
  for (const [key, { provider, model }] of toTest) {
    const client = createProvider(provider, model);
    const started = Date.now();

    try {
      const res = await client.chat({
        messages: [
          { role: 'system', content: 'Responda apenas com a palavra OK.' },
          { role: 'user', content: 'ping' },
        ],
        maxTokens: 16,
        temperature: 0,
      });

      const ms = Date.now() - started;
      const reply = (res.text || '').trim().slice(0, 40) || '(vazio)';
      line(OK, `${provider.label.padEnd(8)} respondeu em ${ms}ms`, `"${reply}" · ${res.usage.in}/${res.usage.out} tok`);
    } catch (err) {
      const ms = Date.now() - started;
      line(BAD, `${provider.label.padEnd(8)} falhou em ${ms}ms`, err.message.slice(0, 160));

      if (/401|403/.test(err.message)) {
        console.log(`      ${DIM}chave inválida ou sem permissão para o modelo "${model}"${OFF}`);
      } else if (/404/.test(err.message)) {
        console.log(`      ${DIM}modelo ou URL base errados — confira ${provider.baseUrlEnv} e o nome do modelo${OFF}`);
      } else if (/429/.test(err.message)) {
        console.log(`      ${DIM}limite de requisições — reduza a concorrência${OFF}`);
      } else if (/TLS rejeitado|certificado/i.test(err.message)) {
        console.log(`      ${DIM}rede corporativa interceptando TLS. Este provedor não funciona nesta máquina.${OFF}`);
        console.log(`      ${DIM}Use outro provedor, rede pessoal (hotspot) ou rode numa VPS.${OFF}`);
      } else if (/DNS/i.test(err.message)) {
        console.log(`      ${DIM}endereço não resolve — confira ${provider.baseUrlEnv}${OFF}`);
      }
    }
  }

  // --- listagem de modelos (ajuda a acertar os nomes) ----------------------
  console.log('\nModelos disponíveis');
  for (const [key, { provider }] of toTest) {
    const client = createProvider(provider, 'x');
    try {
      const models = await client.listModels();
      if (!models.length) {
        line(WARN, `${provider.label}: lista vazia`);
        continue;
      }
      const shown = models.slice(0, 14);
      console.log(`  ${DIM}${provider.label}:${OFF} ${shown.join(', ')}${models.length > shown.length ? ` (+${models.length - shown.length})` : ''}`);
    } catch (err) {
      line(WARN, `${provider.label}: não foi possível listar`, err.message.slice(0, 80));
    }
  }

  console.log(`\n${DIM}Use os nomes acima em PLANNER_MODEL / CODER_MODEL etc, no formato provedor:modelo${OFF}\n`);
}

main().catch((err) => {
  console.error('\nerro no diagnóstico:', err.message, '\n');
  process.exitCode = 1;
});
