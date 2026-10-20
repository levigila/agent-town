// Modo projeto real: qual pasta, com quais comandos, com quais limites.
//
// MODELO DE SEGURANÇA — duas situações:
//
//   1. Servidor em loopback (127.0.0.1) — só a sua máquina alcança a API.
//      Qualquer pasta é aceita. Você escolhe na hora, sem lista fixa.
//
//   2. Servidor exposto (0.0.0.0 ou IP) — qualquer um na rede poderia
//      apontar os agentes para C:\Windows. Nesse caso PROJECT_ROOTS é
//      obrigatório e funciona como allowlist.
//
// O navegador manda apenas o caminho; a decisão é sempre tomada aqui.

import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_FILE = '.agent-town.json';

export const DEFAULT_PROJECT_CONFIG = {
  testCommand: null, // ex: ["npm", "test"] ou ["flutter", "test"]
  ignore: [],
  maxSteps: null, // sobrescreve MAX_STEPS
};

/**
 * Normaliza e autoriza um caminho de projeto.
 *
 * @param {string} raw caminho vindo da requisição
 * @param {string[]} allowedRoots raízes permitidas (do .env)
 * @param {{allowAny?: boolean}} [options] allowAny = servidor local (loopback)
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
export function resolveProjectPath(raw, allowedRoots, options = {}) {
  const allowAny = options.allowAny === true;

  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'caminho do projeto vazio' };
  }

  // Aceita caminho colado com aspas e/ou barra final.
  const cleaned = raw.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '');
  if (!cleaned) return { ok: false, error: 'caminho do projeto vazio' };

  const candidate = path.resolve(cleaned);

  if (allowAny) return { ok: true, path: candidate };

  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return {
      ok: false,
      error:
        'servidor exposto sem PROJECT_ROOTS. Defina PROJECT_ROOTS no .env ou rode em 127.0.0.1 para escolher qualquer pasta.',
    };
  }

  for (const root of allowedRoots) {
    const normalizedRoot = path.resolve(root);
    const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;

    if (candidate === normalizedRoot || candidate.startsWith(withSep)) {
      return { ok: true, path: candidate };
    }
  }

  return {
    ok: false,
    error: `caminho fora das raizes permitidas (${allowedRoots.join(', ')})`,
  };
}

/** O diretório existe e é uma pasta? */
export async function assertDirectory(fullPath) {
  try {
    const info = await stat(fullPath);
    if (!info.isDirectory()) return { ok: false, error: 'o caminho nao e uma pasta' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'pasta nao encontrada' };
  }
}

/**
 * Lê .agent-town.json do projeto, se existir.
 * Arquivo ausente ou inválido = configuração padrão (nunca quebra).
 */
export async function loadProjectConfig(root) {
  const file = path.join(root, PROJECT_CONFIG_FILE);
  if (!existsSync(file)) return { ...DEFAULT_PROJECT_CONFIG, source: 'default' };

  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return {
      testCommand: normalizeCommand(raw.testCommand),
      ignore: Array.isArray(raw.ignore) ? raw.ignore.map(String) : [],
      maxSteps: Number.isFinite(raw.maxSteps) ? Number(raw.maxSteps) : null,
      source: PROJECT_CONFIG_FILE,
    };
  } catch {
    return { ...DEFAULT_PROJECT_CONFIG, source: 'default (arquivo invalido)' };
  }
}

function normalizeCommand(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    // string vira comando de shell, não array — sinalizado no validador
    return value.trim().split(/\s+/);
  }
  return null;
}

/**
 * Monta o contexto inicial do projeto para o Planner e os agentes.
 * Só nomes de arquivo — não o conteúdo. Conteúdo é lido com read_file.
 */
export async function projectContext(root, { maxFiles = 60 } = {}) {
  const { readdir } = await import('node:fs/promises');
  const skip = new Set([
    '.git',
    'node_modules',
    'build',
    '.dart_tool',
    '.idea',
    '.vscode',
    'dist',
    'out',
    'target',
    'vendor',
    '__pycache__',
    '.venv',
  ]);

  const lines = [];

  async function walk(dir, depth = 0) {
    if (lines.length >= maxFiles || depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (lines.length >= maxFiles) return;
      // arquivos ocultos são ruído para o agente (inclui .git, .env, config)
      if (entry.name.startsWith('.')) continue;
      if (skip.has(entry.name)) continue;

      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory()) {
        lines.push(`${rel}/`);
        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        lines.push(rel);
      }
    }
  }

  await walk(root);

  const truncated = lines.length >= maxFiles;
  return {
    tree: lines.join('\n') + (truncated ? `\n... (limitado a ${maxFiles} itens)` : ''),
    fileCount: lines.length,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Navegador de pastas
// ---------------------------------------------------------------------------

/**
 * Lista as subpastas de um diretório para o seletor da UI.
 *
 * Só devolve PASTAS (não arquivos) e marca quais são repositórios git,
 * para você achar o projeto certo de relance.
 *
 * @param {string} target caminho a listar
 * @param {{allowAny?: boolean, allowedRoots?: string[]}} [options]
 * @returns {Promise<{ok: boolean, path?: string, parent?: string|null, entries?: object[], error?: string}>}
 */
export async function browseDirectory(target, options = {}) {
  const allowAny = options.allowAny === true;

  // Sem caminho, começa no diretório do usuário.
  const start = target && target.trim() ? target.trim() : os.homedir();
  const resolved = path.resolve(start);

  // Mesma autorização do modo projeto: no local pode tudo, exposto respeita a lista.
  const auth = resolveProjectPath(resolved, options.allowedRoots || [], { allowAny });
  if (!auth.ok) return { ok: false, error: auth.error };

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (err) {
    const reason = err.code === 'EACCES' ? 'sem permissao de leitura' : 'pasta nao encontrada';
    return { ok: false, error: `${reason}: ${resolved}` };
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // esconde lixo que nunca é projeto
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const full = path.join(resolved, entry.name);
    dirs.push({
      name: entry.name,
      path: full,
      isRepo: existsSync(path.join(full, '.git')),
    });
  }

  dirs.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name, 'pt-BR'));

  const parent = path.dirname(resolved);
  return {
    ok: true,
    path: resolved,
    parent: parent === resolved ? null : parent,
    isRepo: existsSync(path.join(resolved, '.git')),
    entries: dirs.slice(0, 200),
  };
}
