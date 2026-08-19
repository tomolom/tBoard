import { isDirectory } from '../services/filesystem';
import path from 'node:path';

import { genericProfile } from './generic';
import { roeProfile } from './roe';
import { ROE_REPO_MAPPING_SPECS } from './roe/repoMappingScanner';
import type { WorkflowProfile } from './types';

export type { WorkflowProfile } from './types';
export { genericProfile } from './generic';
export { roeProfile } from './roe';

export type ProfileId = 'generic' | 'roe';

const PROFILES: Record<ProfileId, WorkflowProfile> = {
  generic: genericProfile,
  roe: roeProfile,
};

export function getProfile(id: ProfileId): WorkflowProfile {
  return PROFILES[id];
}

export function isProfileId(value: unknown): value is ProfileId {
  return value === 'generic' || value === 'roe';
}

/**
 * Picks the workflow profile for a workspace when none is explicitly configured:
 * uses the Roe profile if any known Roe source repo exists directly under the
 * root, otherwise the generic profile. This keeps the existing Roe workflow
 * zero-config while defaulting every other project to generic discovery.
 */
export async function detectProfile(workspaceRoot: string): Promise<WorkflowProfile> {
  for (const spec of ROE_REPO_MAPPING_SPECS) {
    if (await isDirectory(path.join(workspaceRoot, spec.sourceRepoName))) {
      return roeProfile;
    }
  }
  return genericProfile;
}
