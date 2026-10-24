import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncRepository, publishRepository } from '../src/repository.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'agent-town-repository-'));
const remote = path.join(root, 'remote.git');
const local = path.join(root, 'local');
const other = path.join(root, 'other');
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const identity = (cwd) => {
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
};

try {
  await mkdir(local);
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(local, 'init', '--initial-branch=main');
  identity(local);
  await writeFile(path.join(local, 'app.txt'), 'initial\n');
  git(local, 'add', 'app.txt');
  git(local, 'commit', '-m', 'initial');
  git(local, 'remote', 'add', 'origin', 'https://github.com/test/agent-town.git');
  git(local, 'config', `url.${remote.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/test/agent-town.git');
  git(local, 'push', '-u', 'origin', 'main');
  assert.equal((await syncRepository(local)).updated, false);
  await writeFile(path.join(local, 'untracked.txt'), 'do not publish');
  await assert.rejects(syncRepository(local), /alteracoes locais/);
  await rm(path.join(local, 'untracked.txt'));

  git(local, 'checkout', '-b', 'agent-town/run_test');
  await writeFile(path.join(local, 'app.txt'), 'agent work\n');
  git(local, 'commit', '-am', 'agent work');
  const commit = git(local, 'rev-parse', 'HEAD');
  git(local, 'checkout', 'main');
  await assert.rejects(publishRepository(local, 'agent-town/run_test', '0'.repeat(40)), /mudou/);
  assert.equal((await publishRepository(local, 'agent-town/run_test', commit)).commit, commit);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'main'), commit);
  assert.equal((await publishRepository(local, 'agent-town/run_test', commit)).ok, true);

  git(root, 'clone', remote, other);
  identity(other);
  await writeFile(path.join(other, 'app.txt'), 'remote update\n');
  git(other, 'commit', '-am', 'remote update');
  git(other, 'push', 'origin', 'main');
  assert.equal((await syncRepository(local)).updated, true);
  await writeFile(path.join(local, 'app.txt'), 'local commit\n');
  git(local, 'commit', '-am', 'local only');
  await assert.rejects(syncRepository(local), /nao publicados|divergiu/);
  await assert.rejects(publishRepository(local, 'agent-town/run_test', commit), /divergentes/);
  git(local, 'remote', 'set-url', 'origin', 'https://example.invalid/test.git');
  await assert.rejects(syncRepository(local), /github.com/);
  console.log('OK — GitHub: publicacao, sincronizacao, repeticao e bloqueios sem rede externa');
} finally {
  await rm(root, { recursive: true, force: true });
}
