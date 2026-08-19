import { runProcess } from './processRunner';

export type GitStatusEntry = {
  /** Two-char porcelain XY status code, e.g. ' M', '??', 'A '. */
  code: string;
  path: string;
};

export type GitStatusSnapshot = {
  isRepo: boolean;
  branch: string | null;
  headSha: string | null;
  /** True when there are staged, unstaged, or untracked changes. */
  dirty: boolean;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  /** Populated when git could not be run or the path is not a repo. */
  error: string | null;
};

const GIT_TIMEOUT_MS = 30_000;

function parseBranchHeader(line: string): { branch: string | null; ahead: number; behind: number } {
  // Format: "## branch...tracking [ahead N, behind M]" or "## HEAD (no branch)".
  const withoutPrefix = line.replace(/^## /, '');
  const branchPart = withoutPrefix.split(/\.{3}| /)[0];
  const branch = branchPart && branchPart !== 'HEAD' ? branchPart : null;

  let ahead = 0;
  let behind = 0;
  const aheadMatch = withoutPrefix.match(/ahead (\d+)/);
  const behindMatch = withoutPrefix.match(/behind (\d+)/);
  if (aheadMatch) {
    ahead = Number(aheadMatch[1]);
  }
  if (behindMatch) {
    behind = Number(behindMatch[1]);
  }
  return { branch, ahead, behind };
}

/**
 * Reads a read-only git status snapshot for a repo working directory.
 *
 * Uses `git status --porcelain=v1 -b --untracked-files=all` plus
 * `git rev-parse HEAD`. Purely read-only: it never mutates the repo. Returns a
 * structured snapshot rather than throwing, so callers can capture before/after
 * state around a mutation without special-casing non-repos.
 */
export async function readGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const empty: GitStatusSnapshot = {
    isRepo: false,
    branch: null,
    headSha: null,
    dirty: false,
    ahead: 0,
    behind: 0,
    entries: [],
    error: null,
  };

  const statusRun = await runProcess({
    command: 'git',
    args: ['status', '--porcelain=v1', '-b', '--untracked-files=all'],
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });

  if (statusRun.spawnError) {
    return { ...empty, error: statusRun.spawnErrorMessage ?? 'Failed to spawn git.' };
  }

  if (statusRun.exitCode !== 0) {
    // Not a git repo, or git errored. Surface stderr as the error.
    const message = statusRun.stderr.trim() || `git status exited with code ${statusRun.exitCode}.`;
    return { ...empty, error: message };
  }

  const lines = statusRun.stdout.split('\n').filter((line) => line.length > 0);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = parseBranchHeader(line);
      branch = header.branch;
      ahead = header.ahead;
      behind = header.behind;
      continue;
    }
    // Porcelain entry: "XY path" where XY is exactly two status chars.
    const code = line.slice(0, 2);
    const path = line.slice(3);
    entries.push({ code, path });
  }

  const headRun = await runProcess({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const headSha = headRun.exitCode === 0 ? headRun.stdout.trim() || null : null;

  return {
    isRepo: true,
    branch,
    headSha,
    dirty: entries.length > 0,
    ahead,
    behind,
    entries,
    error: null,
  };
}
