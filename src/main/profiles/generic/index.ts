import path from 'node:path';

import { isDirectory, listDirectories, pathExists } from '../../services/filesystem';
import type { ComponentScan, RepoMappingScan, WorkflowProfile } from '../types';

/**
 * Slugifies a directory name into a stable canonical/key form.
 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * The generic (default) workflow profile. It makes tBoard usable on ANY
 * workspace with zero configuration:
 *
 * - Discovery: each immediate child directory of the workspace root that is a
 *   git repository (`<dir>/.git` exists) becomes a `single` mapping — a primary
 *   repo with no release target. There is no source->target pairing, so diff
 *   and release-copy do not apply.
 * - Components: the repo itself is its single component (root = repo root). This
 *   is the YAGNI default; per-subdir component discovery can be layered later.
 */
export const genericProfile: WorkflowProfile = {
  id: 'generic',
  displayName: 'Generic (any git repo)',
  profileTag: 'generic',

  async scanRepoMappings(workspaceRoot: string): Promise<RepoMappingScan> {
    if (!(await pathExists(workspaceRoot)) || !(await isDirectory(workspaceRoot))) {
      return {
        mappings: [],
        warnings: [
          { code: 'workspace_root_missing', message: 'Workspace root does not exist or is not a directory.', path: workspaceRoot },
        ],
      };
    }

    const childNames = await listDirectories(workspaceRoot);
    const mappings = [];
    const seenKeys = new Set<string>();

    for (const name of childNames) {
      if (name.startsWith('.')) {
        continue;
      }
      const repoPath = path.join(workspaceRoot, name);
      if (!(await isDirectory(path.join(repoPath, '.git')))) {
        continue;
      }

      let mappingKey = slugify(name) || name.toLowerCase();
      // Guard against slug collisions across differently-named dirs.
      let suffix = 2;
      while (seenKeys.has(mappingKey)) {
        mappingKey = `${slugify(name) || name.toLowerCase()}-${suffix}`;
        suffix += 1;
      }
      seenKeys.add(mappingKey);

      mappings.push({
        mappingKey,
        displayName: name,
        mappingKind: 'single' as const,
        sourceRepoName: name,
        sourceRepoPath: repoPath,
        sourceExists: true,
        targetRepoName: null,
        targetRepoPath: null,
        targetExists: false,
        enabled: true,
      });
    }

    return { mappings, warnings: [] };
  },

  async scanComponents(repoPath: string, context): Promise<ComponentScan> {
    // Only the primary (source) repo has components in a single mapping; a
    // generic mapping has no target repo to scan.
    if (context.role !== 'source') {
      return { components: [], warnings: [] };
    }
    if (!(await isDirectory(repoPath))) {
      return {
        components: [],
        warnings: [{ code: 'repo_missing', message: `Repository path does not exist: ${repoPath}`, path: repoPath }],
      };
    }

    const rootName = path.basename(repoPath);
    const canonicalName = `${context.mappingKey}/${slugify(rootName) || rootName.toLowerCase()}`;

    return {
      components: [
        {
          canonicalName,
          displayName: rootName,
          descriptorName: null,
          packageHint: null,
          rootName,
          rootPath: repoPath,
          descriptorPath: null,
        },
      ],
      warnings: [],
    };
  },
};
