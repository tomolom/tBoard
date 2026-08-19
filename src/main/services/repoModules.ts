import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isDirectory } from './filesystem';

/** Directories that are never useful as "modules". */
const IGNORED_DIRS = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.turbo',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Container folders whose immediate children are the real modules (monorepos). */
const MONOREPO_CONTAINERS = new Set(['packages', 'apps', 'modules', 'services', 'libs', 'plugins', 'crates']);

function isVisible(name: string): boolean {
  return !name.startsWith('.') && !IGNORED_DIRS.has(name) && !IGNORED_DIRS.has(name.toLowerCase());
}

/**
 * Discovers candidate "modules" in a repo: top-level subdirectories, plus one
 * level into known monorepo container folders (packages/*, apps/*, …) expressed
 * as "packages/foo". Read-only; returns a sorted, de-duplicated list. Never
 * throws — an unreadable repo yields an empty list.
 */
export async function listModules(repoPath: string): Promise<string[]> {
  if (!(await isDirectory(repoPath))) {
    return [];
  }

  let topEntries;
  try {
    topEntries = await readdir(repoPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const modules = new Set<string>();

  for (const entry of topEntries) {
    if (!entry.isDirectory() || !isVisible(entry.name)) {
      continue;
    }

    if (MONOREPO_CONTAINERS.has(entry.name.toLowerCase())) {
      // Expand one level: packages/foo, apps/bar, …
      let children: Dirent[] = [];
      try {
        children = await readdir(path.join(repoPath, entry.name), { withFileTypes: true });
      } catch {
        children = [];
      }
      let expanded = false;
      for (const child of children) {
        if (child.isDirectory() && isVisible(child.name)) {
          modules.add(`${entry.name}/${child.name}`);
          expanded = true;
        }
      }
      // If the container had no usable children, keep the container itself.
      if (!expanded) {
        modules.add(entry.name);
      }
      continue;
    }

    modules.add(entry.name);
  }

  return [...modules].sort((a, b) => a.localeCompare(b));
}
