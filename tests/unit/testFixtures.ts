import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createTempWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'tboard-'));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Creates a directory that looks like a git repo (has a `.git` folder), for
 * exercising board creation and branch discovery without a real clone.
 */
export async function createGitRepo(root: string, name: string): Promise<string> {
  const repoPath = path.join(root, name);
  await mkdir(path.join(repoPath, '.git'), { recursive: true });
  await writeFile(path.join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await writeFile(path.join(repoPath, 'README.md'), `# ${name}\n`, 'utf8');
  return repoPath;
}
