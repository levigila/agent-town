// Importa agentes definidos para o OpenCode.
//
// O OpenCode guarda agentes como arquivos Markdown com frontmatter YAML:
//
//   ---
//   description: Escreve documentacao
//   mode: subagent
//   model: anthropic/claude-sonnet-4
//   permission:
//     edit: deny
//     shell: ask
//   ---
//   Voce e um escritor tecnico...
//
// Este modulo le esses arquivos e os converte em agentes do agent-town:
// o corpo do Markdown vira o system prompt, e o frontmatter define o modo
// (read-only ou com escrita) e o modelo.
//
// A leitura e tolerante: frontmatter invalido nao derruba a importacao, e um
// arquivo com problema e reportado sem impedir os outros.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Onde o OpenCode procura agentes, do mais específico para o mais global. */
export function openCodeAgentDirs(projectRoot) {
  const dirs = [];
  if (projectRoot) dirs.push(path.join(projectRoot, '.opencode', 'agent'));
  dirs.push(path.join(projectRoot || '', '.opencode', 'agents'));

  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  dirs.push(path.join(configHome, 'opencode', 'agent'));
  dirs.push(path.join(configHome, 'opencode', 'agents'));

  return [...new Set(dirs.filter((d) => d && !d.startsWith('.opencode')))];
}

/**
 * Lê o frontmatter YAML de um Markdown.
 *
 * Não é um parser YAML completo — só o subconjunto que o OpenCode usa:
 * chave: valor, e um nível de aninhamento para "permission" e "tools".
 * Um YAML completo exigiria dependência, e o projeto é zero-dependency.
 */
export function parseFrontmatter(text) {
  const meta = {};
  let body = text;

  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta, body: text, hadFrontmatter: false };

  const [, rawMeta, rest] = match;
  body = rest;

  let parent = null;

  for (const line of rawMeta.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indented = /^\s+/.test(line);

    // "chave: valor" ou "chave:" (abre um bloco aninhado)
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    let value = kv[2].trim();

    if (indented && parent) {
      meta[parent][key] = cleanScalar(value);
      continue;
    }

    if (value === '') {
      parent = key;
      meta[key] = {};
      continue;
    }

    parent = null;
    meta[key] = cleanScalar(value);
  }

  return { meta, body, hadFrontmatter: true };
}

function cleanScalar(value) {
  const v = String(value).trim();

  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;

  // remove aspas simples/duplas em volta
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }

  // lista inline: [a, b, c]
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => cleanScalar(s))
      .filter((s) => s !== '');
  }

  return v;
}

/**
 * Traduz as permissões do OpenCode para o que o agent-town sabe fazer.
 *
 * O agent-town só tem 4 ferramentas e não executa shell arbitrário, então o
 * mapeamento é simples: quem não pode editar vira read-only.
 */
export function toolsFromPermissions(meta) {
  const edit = meta?.permission?.edit;
  const canEdit = edit !== 'deny' && edit !== false;

  // O OpenCode também aceita "tools: { write: false }"
  const tools = meta?.tools || {};
  const writeOff = tools.write === false || tools.edit === false;

  return canEdit && !writeOff
    ? ['list_files', 'read_file', 'write_file', 'run_tests']
    : ['list_files', 'read_file'];
}

/**
 * Converte um arquivo de agente do OpenCode em um agente do agent-town.
 *
 * @param {string} name nome do arquivo sem extensão
 * @param {string} text conteúdo do arquivo
 * @param {string} source caminho de origem (para rastrear)
 */
export function toAgent(name, text, source = '') {
  const { meta, body } = parseFrontmatter(text);
  const prompt = body.trim();

  if (!prompt) return null;

  const mode = meta.mode || 'subagent';

  return {
    id: name,
    name: meta.description ? titleFromDescription(meta.description, name) : name,
    description: meta.description || '',
    mode,
    model: meta.model || null,
    // Um agente "primary" do OpenCode pode editar; "plan"/read-only não.
    toolNames: toolsFromPermissions(meta),
    canEdit: toolsFromPermissions(meta).includes('write_file'),
    prompt,
    source,
    meta,
  };
}

/** "Writes and maintains project documentation" -> "Writes and maintains..." */
function titleFromDescription(description, fallback) {
  const first = String(description).split(/[.,;\n]/)[0].trim();
  if (!first) return fallback;
  return first.length > 48 ? `${first.slice(0, 45)}...` : first;
}

/**
 * Lê todos os agentes do OpenCode disponíveis.
 *
 * @param {string} [projectRoot] pasta do projeto (para .opencode/agent)
 * @returns {Promise<{agents: object[], errors: string[], dirs: string[]}>}
 */
export async function loadOpenCodeAgents(projectRoot) {
  const dirs = openCodeAgentDirs(projectRoot);
  const agents = [];
  const errors = [];
  const seen = new Set();

  for (const dir of dirs) {
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;

      const name = entry.name.replace(/\.md$/i, '');
      if (seen.has(name)) continue; // o primeiro diretório vence (mais específico)

      const file = path.join(dir, entry.name);

      try {
        const text = await readFile(file, 'utf8');
        const agent = toAgent(name, text, file);
        if (!agent) {
          errors.push(`${name}: arquivo sem instrucoes (corpo vazio)`);
          continue;
        }
        seen.add(name);
        agents.push(agent);
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
  }

  return { agents, errors, dirs };
}

/** Valida o nome de um agente do OpenCode como id do agent-town. */
export function isValidAgentId(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name);
}
