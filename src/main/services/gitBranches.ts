import path from 'node:path';

import type { BranchListResult } from '../../shared/api';
import { isDirectory } from './filesystem';
import { runProcess } from './processRunner';

/**
 * Returns true if `repoPath` looks like a git repository (has a `.git` entry —
 * a directory for normal clones, a file for worktrees/submodules).
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  if (!(await isDirectory(repoPath))) {
    return false;
  }
  // `.git` is a directory for a normal repo, or a file for a linked worktree.
  const gitPath = path.join(repoPath, '.git');
  if (await isDirectory(gitPath)) {
    return true;
  }
  const probe = await runProcess({
    command: 'git',
    args: ['rev-parse', '--is-inside-work-tree'],
    cwd: repoPath,
    timeoutMs: 10_000,
  });
  return !probe.spawnError && probe.exitCode === 0 && probe.stdout.trim() === 'true';
}

/**
 * Lists local git branches for a repo, flagging the currently checked-out one.
 * Read-only: runs `git branch` via argv (no shell). Never throws — failures are
 * returned as an `error` string.
 */
export async function listBranches(repoPath: string): Promise<BranchListResult> {
  if (!(await isDirectory(repoPath))) {
    return { branches: [], current: null, error: `Repo path does not exist: ${repoPath}` };
  }

  const result = await runProcess({
    command: 'git',
    // %(HEAD) is '*' for the current branch, ' ' otherwise; refname:short is the name.
    args: ['for-each-ref', '--format=%(HEAD)%00%(refname:short)', 'refs/heads/'],
    cwd: repoPath,
    timeoutMs: 15_000,
  });

  if (result.spawnError) {
    return { branches: [], current: null, error: result.spawnErrorMessage ?? 'git could not be started' };
  }
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `git exited ${result.exitCode ?? 'unknown'}`;
    return { branches: [], current: null, error: message };
  }

  const branches = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [headFlag, name] = line.split('\u0000');
      return { name: name ?? '', current: headFlag === '*' };
    })
    .filter((branch) => branch.name.length > 0);

  const current = branches.find((branch) => branch.current)?.name ?? null;
  return { branches, current, error: null };
}
