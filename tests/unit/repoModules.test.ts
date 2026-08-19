import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listModules } from '../../src/main/services/repoModules';
import { createTempWorkspace } from './testFixtures';

describe('listModules', () => {
  it('lists top-level folders, ignoring noise dirs, and expands monorepo containers', async () => {
    const ws = await createTempWorkspace();
    try {
      const repo = path.join(ws.root, 'repo');
      for (const dir of [
        'src',
        'docs',
        '.git',
        'node_modules',
        'dist',
        'packages/core',
        'packages/ui',
        'apps/web',
      ]) {
        await mkdir(path.join(repo, dir), { recursive: true });
      }

      const modules = await listModules(repo);
      // Noise dirs excluded.
      expect(modules).not.toContain('.git');
      expect(modules).not.toContain('node_modules');
      expect(modules).not.toContain('dist');
      // Plain top-level folders kept; the container itself is not listed once expanded.
      expect(modules).toContain('src');
      expect(modules).toContain('docs');
      expect(modules).not.toContain('packages');
      // Monorepo containers expanded one level.
      expect(modules).toContain('packages/core');
      expect(modules).toContain('packages/ui');
      expect(modules).toContain('apps/web');
      // Sorted.
      expect([...modules]).toEqual([...modules].sort((a, b) => a.localeCompare(b)));
    } finally {
      await ws.cleanup();
    }
  });

  it('keeps an empty container folder as its own module', async () => {
    const ws = await createTempWorkspace();
    try {
      const repo = path.join(ws.root, 'repo');
      await mkdir(path.join(repo, 'packages'), { recursive: true });
      const modules = await listModules(repo);
      expect(modules).toContain('packages');
    } finally {
      await ws.cleanup();
    }
  });

  it('returns an empty list for a non-existent path', async () => {
    expect(await listModules('/definitely/not/real/xyz')).toEqual([]);
  });
});
