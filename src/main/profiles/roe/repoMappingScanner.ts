import path from 'node:path';

import type { ScanWarning } from '../../../shared/api';
import { isDirectory, pathExists } from '../../services/filesystem';
import type { RepoMappingCandidate, RepoMappingScan } from '../types';

export type RoeRepoMappingSpec = {
  mappingKey: string;
  displayName: string;
  sourceRepoName: string;
  targetRepoName: string;
};

export const ROE_REPO_MAPPING_SPECS: RoeRepoMappingSpec[] = [
  { mappingKey: 'main', displayName: 'Main', sourceRepoName: 'Roe-apiv3', targetRepoName: 'community-plugins' },
  { mappingKey: 'ferox', displayName: 'Ferox', sourceRepoName: 'Roe-apiv3-ferox', targetRepoName: 'community-plugins-ferox' },
  { mappingKey: 'orion', displayName: 'Orion', sourceRepoName: 'Roe-apiv3-orion', targetRepoName: 'community-plugins-orion' },
  { mappingKey: 'osnr', displayName: 'OSNR', sourceRepoName: 'Roe-apiv3-osnr', targetRepoName: 'community-plugins-osnr' },
  { mappingKey: 'osrsps', displayName: 'OSRSPS', sourceRepoName: 'Roe-apiv3-osrsps', targetRepoName: 'community-plugins-osrsps' },
  { mappingKey: 'reason', displayName: 'Reason', sourceRepoName: 'Roe-apiv3-reason', targetRepoName: 'community-plugins-reason' },
  { mappingKey: 'amascut', displayName: 'Amascut', sourceRepoName: 'Roe-apiv3-amascut', targetRepoName: 'community-plugins-amascut' },
];

export async function scanRoeRepoMappings(workspaceRoot: string): Promise<RepoMappingScan> {
  const warnings: ScanWarning[] = [];

  if (!(await pathExists(workspaceRoot)) || !(await isDirectory(workspaceRoot))) {
    return {
      mappings: [],
      warnings: [
        {
          code: 'workspace_root_missing',
          message: 'Workspace root does not exist or is not a directory.',
          path: workspaceRoot,
        },
      ],
    };
  }

  const mappings: RepoMappingCandidate[] = [];

  for (const spec of ROE_REPO_MAPPING_SPECS) {
    const sourceRepoPath = path.join(workspaceRoot, spec.sourceRepoName);
    const targetRepoPath = path.join(workspaceRoot, spec.targetRepoName);
    const sourceExists = await isDirectory(sourceRepoPath);
    const targetExists = await isDirectory(targetRepoPath);

    if (!sourceExists && !targetExists) {
      continue;
    }

    if (!sourceExists) {
      warnings.push({
        code: 'source_repo_missing',
        message: `Source repo is missing for ${spec.displayName}.`,
        path: sourceRepoPath,
      });
    }

    if (!targetExists) {
      warnings.push({
        code: 'target_repo_missing',
        message: `Target repo is missing for ${spec.displayName}.`,
        path: targetRepoPath,
      });
    }

    mappings.push({
      mappingKey: spec.mappingKey,
      displayName: spec.displayName,
      mappingKind: 'source_target',
      sourceRepoName: spec.sourceRepoName,
      sourceRepoPath,
      sourceExists,
      targetRepoName: spec.targetRepoName,
      targetRepoPath,
      targetExists,
      enabled: sourceExists && targetExists,
    });
  }

  return { mappings, warnings };
}
