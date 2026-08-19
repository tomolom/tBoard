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

export async function createRoePlugin(repoRoot: string, rootName: string, packageName: string, displayName: string): Promise<void> {
  const packageDir = path.join(repoRoot, rootName, 'src/main/java/net/runelite/client/plugins/roe', packageName);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, 'ExamplePlugin.java'),
    `package net.runelite.client.plugins.roe.${packageName};

import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;

@PluginDescriptor(
  name = "${displayName}",
  description = "Fixture plugin"
)
public class ExamplePlugin extends Plugin {
}
`,
    'utf8',
  );
}

export async function createRepo(root: string, name: string): Promise<string> {
  const repoPath = path.join(root, name);
  await mkdir(repoPath, { recursive: true });
  return repoPath;
}

/**
 * Creates a plain git repo (a directory with a `.git` folder and one file) under
 * the workspace root, for exercising the generic profile's discovery.
 */
export async function createGitRepo(root: string, name: string, files: Record<string, string> = { 'README.md': '# repo' }): Promise<string> {
  const repoPath = path.join(root, name);
  await mkdir(path.join(repoPath, '.git'), { recursive: true });
  await writeFile(path.join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  for (const [rel, contents] of Object.entries(files)) {
    const filePath = path.join(repoPath, rel);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  return repoPath;
}
