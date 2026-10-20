// Operações git para trabalhar num projeto REAL com segurança.
//
// Regras invioláveis deste módulo:
//   1. Nunca `git push`. Em nenhuma circunstância.
//   2. Nunca commitar na branch em que o usuário estava.
//   3. Nunca começar com alterações pendentes em arquivos rastreados
//      (senão não dá para separar o que o agente fez do que já estava lá).
//
// Tudo roda via spawn com saída em arquivo (sem pipe), pelo mesmo motivo
// das outras ferramentas: funciona em ambientes restritos.

import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

function run(command, args, cwd, { timeoutMs = 30000, tmpDir, trim = true } = {}) {
  return new Promise((resolve) => {
    const logPath = path.join(tmpDir, `git-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`);
    let fd;
    try {
      fd = openSync(logPath, 'w');
    } catch (err) {
      return resolve({ code: -1, output: `nao foi possivel abrir log: ${err.message}` });
    }

    let settled = false;
    let child;

    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        /* já fechado */
      }
      let output = '';
      try {
        output = readFileSync(logPath, 'utf8');
      } catch {
        /* sem log */
      }
      rmSync(logPath, { force: true });

      // NÃO dar trim() em saída de `status --porcelain`: o espaço inicial é
      // parte do formato (" M arquivo"). Trimar aqui desloca todas as colunas.
      const combined = output + extra;
      resolve({ code, output: trim ? combined.trim() : combined });
    };

    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* já morreu */
      }
      finish(-1, `[timeout ${timeoutMs}ms]`);
    }, timeoutMs);

    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true });
    } catch (err) {
      return finish(-1, `falha ao iniciar: ${err.message}`);
    }

    child.on('error', (err) => finish(-1, err.message));
    child.on('close', (code) => finish(code ?? -1));
  });
}

const git = (cwd, args, opts) => run('git', args, cwd, opts);

/** O diretório é um repositório git? */
export async function isRepo(root, tmpDir) {
  const res = await git(root, ['rev-parse', '--is-inside-work-tree'], { tmpDir });
  return res.code === 0 && res.output.includes('true');
}

/**
 * O repositório tem pelo menos um commit?
 *
 * `git init` numa pasta cria um repositório sem commits ("unborn HEAD").
 * Nesse estado não existe base para comparar diff, então o modo projeto
 * precisa recusar com uma mensagem clara em vez de falhar de forma estranha.
 */
export async function hasCommits(root, tmpDir) {
  const res = await git(root, ['rev-parse', '--verify', 'HEAD'], { tmpDir });
  return res.code === 0;
}

/**
 * Nome da branch atual.
 *
 * Usa `symbolic-ref` em vez de `rev-parse --abbrev-ref HEAD`: em repositório
 * sem commits, rev-parse falha com "ambiguous argument 'HEAD'", enquanto
 * symbolic-ref devolve o nome da branch normalmente.
 */
export async function currentBranch(root, tmpDir) {
  const res = await git(root, ['symbolic-ref', '--short', 'HEAD'], { tmpDir });
  if (res.code === 0 && res.output) return res.output.split('\n').pop().trim();
  return null; // detached HEAD ou repo quebrado
}

/** Lista de arquivos modificados/não rastreados (formato porcelain cru). */
export async function dirtyFiles(root, tmpDir) {
  const res = await git(root, ['status', '--porcelain'], { tmpDir, trim: false });
  if (res.code !== 0) return [];
  return res.output.split('\n').filter((line) => line.length > 3);
}

/** O working tree está limpo? */
export async function isClean(root, tmpDir) {
  const files = await dirtyFiles(root, tmpDir);
  return { clean: files.length === 0, files };
}

/** Cria (ou recria) uma branch a partir da atual. */
export async function createBranch(root, branchName, tmpDir) {
  // se já existe de uma execução anterior, apaga para começar limpo
  await git(root, ['branch', '-D', branchName], { tmpDir });
  const res = await git(root, ['checkout', '-b', branchName], { tmpDir });
  if (res.code !== 0) {
    return { ok: false, error: res.output || 'falha ao criar branch' };
  }
  return { ok: true, branch: branchName };
}

/** Volta para a branch original e remove a branch de trabalho. */
export async function cleanupBranch(root, branchName, originalBranch, tmpDir, { keep = false } = {}) {
  if (originalBranch) {
    await git(root, ['checkout', originalBranch], { tmpDir });
  }
  if (!keep && branchName && branchName !== originalBranch) {
    await git(root, ['branch', '-D', branchName], { tmpDir });
  }
}

/**
 * Resumo do diff (arquivos e linhas), sem o conteúdo.
 * @param {string} base ref de comparação (a branch onde o trabalho começou)
 */
export async function diffStat(root, tmpDir, base = 'HEAD') {
  const res = await git(root, ['diff', '--stat', base], { tmpDir });
  return res.code === 0 ? res.output : '';
}

/**
 * Diff completo, limitado para não estourar a UI.
 *
 * IMPORTANTE: comparar com a branch de origem, não com HEAD. Se compararmos
 * com HEAD depois de commitar, o diff vem vazio — foi exatamente esse o bug
 * que o teste pegou.
 */
export async function diffText(root, tmpDir, { maxChars = 20000, base = 'HEAD' } = {}) {
  const res = await git(root, ['diff', base], { tmpDir });
  if (res.code !== 0) return { ok: false, text: '', truncated: false };
  const text = res.output;
  if (text.length <= maxChars) return { ok: true, text, truncated: false };
  return { ok: true, text: text.slice(0, maxChars), truncated: true };
}

/**
 * Lista de arquivos alterados com status (A/M/D).
 *
 * CUIDADO com o formato porcelain: "XY <caminho>", onde X e Y são colunas
 * fixas. NÃO se pode dar trim() antes de fatiar — " M src/a.mjs" tem um
 * espaço inicial que desloca tudo (foi assim que "src/price.mjs" virou
 * "rc/price.mjs" e o commit falhou).
 *
 * @param {string[]} [baseline] arquivos que já estavam sujos antes da execução
 *   (não rastreados). São excluídos: não foram os agentes que os criaram.
 */
export async function changedFiles(root, tmpDir, baseline = []) {
  const res = await git(root, ['status', '--porcelain'], { tmpDir, trim: false });
  if (res.code !== 0) return [];

  const skip = new Set(baseline);

  return res.output
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      file: line.slice(3).trim(),
    }))
    .filter((entry) => entry.file && !skip.has(entry.file));
}

/**
 * Commit na branch de trabalho, apenas dos arquivos indicados.
 * Nunca faz push. Nunca usa `git add -A` (isso arrastaria lixo não rastreado
 * que já estava no projeto antes da execução).
 */
export async function commitFiles(root, files, message, tmpDir) {
  const list = (files || []).map((f) => (typeof f === 'string' ? f : f.file)).filter(Boolean);
  if (!list.length) return { ok: false, output: 'nada para commitar' };

  await git(root, ['add', '--', ...list], { tmpDir });
  const res = await git(root, ['commit', '-m', message, '--no-verify', '--', ...list], { tmpDir });
  return { ok: res.code === 0, output: res.output };
}

/**
 * Prepara o projeto para uma execução: valida, cria branch, devolve contexto.
 *
 * Regra de limpeza: arquivos RASTREADOS modificados bloqueiam (eles se
 * misturariam ao diff dos agentes). Arquivos NÃO rastreados são tolerados —
 * são registrados como baseline e ignorados, para que lixo como .vscode/
 * não impeça o trabalho nem entre no commit.
 *
 * @returns {Promise<{ok: boolean, error?: string, branch?: string, originalBranch?: string, baseline?: string[], dirty?: string[]}>}
 */
export async function prepareWorkBranch(root, runId, tmpDir) {
  if (!(await isRepo(root, tmpDir))) {
    return {
      ok: false,
      error: 'a pasta escolhida nao e um repositorio git. Rode "git init" e faca um commit inicial nela.',
    };
  }

  if (!(await hasCommits(root, tmpDir))) {
    return {
      ok: false,
      error:
        'o repositorio nao tem nenhum commit ainda. Faca um commit inicial (git add -A; git commit -m "init") antes de rodar.',
    };
  }

  const originalBranch = await currentBranch(root, tmpDir);
  if (!originalBranch) {
    return { ok: false, error: 'nao foi possivel identificar a branch atual (HEAD destacado?)' };
  }

  const { files } = await isClean(root, tmpDir);

  // "??" = não rastreado. Qualquer outro código (M, A, D, R, U) = modificado.
  const untracked = files.filter((line) => line.startsWith('??'));
  const modified = files.filter((line) => !line.startsWith('??'));

  if (modified.length) {
    const list = modified
      .slice(0, 8)
      .map((l) => l.slice(3).trim())
      .join(', ');
    return {
      ok: false,
      error: `ha ${modified.length} arquivo(s) com alteracoes nao commitadas (${list}). Commite ou use "git stash" antes de rodar.`,
      dirty: modified.slice(0, 10),
      originalBranch,
    };
  }

  const branch = `agent-town/${runId}`;
  const created = await createBranch(root, branch, tmpDir);
  if (!created.ok) {
    return { ok: false, error: created.error, originalBranch };
  }

  return {
    ok: true,
    branch,
    originalBranch,
    baseline: untracked.map((line) => line.slice(3).trim()),
  };
}
