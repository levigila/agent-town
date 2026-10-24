import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(root, args) {
  try {
    const { stdout } = await exec('git', ['--no-pager', ...args], {
      cwd: root,
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`git ${args[0]} falhou: ${String(err.stderr || err.message).trim()}`, { cause: err });
  }
}

async function ancestor(root, before, after) {
  try {
    await git(root, ['merge-base', '--is-ancestor', before, after]);
    return true;
  } catch (err) {
    // Only exit code 1 means divergence; operational failures must be surfaced.
    if (err.cause?.code === 1) return false;
    throw err;
  }
}

async function inspect(root) {
  if (await git(root, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('ha alteracoes locais; commite ou guarde seu trabalho antes de sincronizar/publicar');
  }
  const remote = await git(root, ['config', '--get', 'remote.origin.url']);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote)) {
    throw new Error('origin deve apontar para um repositorio do github.com (HTTPS ou SSH)');
  }
  const head = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const main = head.match(/^ref: refs\/heads\/([^\s]+)\s+HEAD/m)?.[1];
  if (!main) throw new Error('nao foi possivel descobrir a branch principal de origin');
  const current = await git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (current !== main) throw new Error(`selecione a branch principal "${main}" antes de sincronizar/publicar`);
  await git(root, ['fetch', '--no-tags', 'origin', `refs/heads/${main}:refs/remotes/origin/${main}`]);
  return { main, remote };
}

export async function syncRepository(root) {
  const { main } = await inspect(root);
  const before = await git(root, ['rev-parse', 'HEAD']);
  const remote = await git(root, ['rev-parse', `refs/remotes/origin/${main}`]);
  if (!(await ancestor(root, before, remote))) {
    throw new Error('branch local possui commits nao publicados ou divergiu do GitHub; sincronizacao bloqueada');
  }
  await git(root, ['merge', '--ff-only', remote]);
  return { ok: true, branch: main, updated: before !== remote, commit: remote };
}

export async function publishRepository(root, branch, expectedCommit) {
  if (!/^agent-town\/[a-zA-Z0-9_-]+$/.test(branch || '') || !/^[a-f0-9]{40,64}$/.test(expectedCommit || '')) {
    throw new Error('execucao sem branch/commit valido para publicar');
  }
  const { main } = await inspect(root);
  const remote = await git(root, ['rev-parse', `refs/remotes/origin/${main}`]);
  const local = await git(root, ['rev-parse', 'HEAD']);
  const work = await git(root, ['rev-parse', `refs/heads/${branch}`]);
  if (work !== expectedCommit) throw new Error('a branch dos agentes mudou depois da execucao; publicacao bloqueada');
  if (!(await ancestor(root, local, remote)) || !(await ancestor(root, remote, work))) {
    throw new Error('historicos divergentes; revise e integre as branches manualmente antes de publicar');
  }
  await git(root, ['merge', '--ff-only', work]);
  await git(root, ['push', 'origin', `${work}:refs/heads/${main}`]);
  return { ok: true, branch: main, commit: work };
}
