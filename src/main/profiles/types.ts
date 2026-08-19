import type { MappingKind, ScanWarning } from '../../shared/api';

/**
 * A discovered repo mapping candidate produced by a workflow profile's scanner.
 *
 * A `single` mapping has only a primary repo (stored as the "source"); its
 * `targetRepoPath` is null and diff/release do not apply. A `source_target`
 * mapping pairs a source (dev) repo with a target (release) repo.
 */
export type RepoMappingCandidate = {
  mappingKey: string;
  displayName: string;
  mappingKind: MappingKind;
  sourceRepoName: string;
  sourceRepoPath: string;
  sourceExists: boolean;
  /** Null for `single` mappings. */
  targetRepoName: string | null;
  targetRepoPath: string | null;
  targetExists: boolean;
  enabled: boolean;
};

export type RepoMappingScan = {
  mappings: RepoMappingCandidate[];
  warnings: ScanWarning[];
};

/**
 * A component discovered inside one repo. `canonicalName` is the stable key used
 * to line up the same component across a source/target pair.
 */
export type ComponentCandidate = {
  canonicalName: string;
  displayName: string;
  descriptorName: string | null;
  packageHint: string | null;
  rootName: string;
  rootPath: string;
  descriptorPath: string | null;
};

export type ComponentScan = {
  components: ComponentCandidate[];
  warnings: ScanWarning[];
};

export type ComponentScanContext = {
  /** 'source' for the primary/dev repo, 'target' for the release repo. */
  role: 'source' | 'target';
  mappingKey: string;
};

/**
 * A workflow profile decouples discovery (what repos/components exist in a
 * workspace) from the rest of the app. Roe is one profile; a generic profile
 * treats each git repo directory as a single-repo project.
 */
export type WorkflowProfile = {
  id: string;
  displayName: string;
  /** Discovers repo mappings under the workspace root. */
  scanRepoMappings(workspaceRoot: string): Promise<RepoMappingScan>;
  /** Discovers components inside one repo of a mapping. */
  scanComponents(repoPath: string, context: ComponentScanContext): Promise<ComponentScan>;
  /** Stable string stored in component_variants metadata (`{ profile }`). */
  readonly profileTag: string;
};
