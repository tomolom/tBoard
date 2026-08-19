import type { WorkflowProfile } from '../types';
import { scanRoeComponents } from './componentScanner';
import { scanRoeRepoMappings } from './repoMappingScanner';

/**
 * The Roe/RuneLite workflow profile: discovers the fixed Roe-apiv3* ->
 * community-plugins* source/target pairs and RuneLite `@PluginDescriptor`
 * plugin components. Behavior is unchanged from the original hardcoded path.
 */
export const roeProfile: WorkflowProfile = {
  id: 'roe',
  displayName: 'RoeLite plugins',
  profileTag: 'roe',
  scanRepoMappings: (workspaceRoot) => scanRoeRepoMappings(workspaceRoot),
  scanComponents: (repoPath, context) => scanRoeComponents(repoPath, `${context.mappingKey}:${context.role}`),
};
