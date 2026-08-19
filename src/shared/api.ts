export type ScanWarning = {
  code: string;
  message: string;
  path?: string;
};

export type ScanResult = {
  repoMappingsFound: number;
  reposFound: number;
  componentsFound: number;
  componentVariantsFound: number;
  warnings: ScanWarning[];
};

/**
 * Whether a mapping is a single primary repo (no release target) or a
 * source->target pair. `single` mappings have a null target and disable
 * diff/release, which are inherently source-vs-target operations.
 */
export type MappingKind = 'single' | 'source_target';

export type RepoMappingDto = {
  id: number;
  mappingKey: string;
  displayName: string;
  mappingKind: MappingKind;
  sourceRepoPath: string;
  /** Null for `single` mappings (no release target). */
  targetRepoPath: string | null;
  enabled: boolean;
  lastScannedAt: string | null;
};

export type ComponentVariantOverviewDto = {
  componentVariantId: number;
  componentId: number;
  canonicalName: string;
  componentDisplayName: string;
  mappingKey: string;
  mappingDisplayName: string;
  mappingKind: MappingKind;
  sourceExists: boolean;
  targetExists: boolean;
  lifecycleStatus: string;
  approvalState: string;
  testedState: string;
  releaseState: string;
  sourceComponentRootPath: string | null;
  targetComponentRootPath: string | null;
  openBugCount: number;
  evidenceCount: number;
};

export type DiffFileChangeStatus = 'added' | 'deleted' | 'modified' | 'unchanged';

export type DiffFileChange = {
  path: string;
  status: DiffFileChangeStatus;
};

export type DiffSnapshotSummary = {
  addedCount: number;
  deletedCount: number;
  modifiedCount: number;
  unchangedCount: number;
  sourceFileCount: number;
  targetFileCount: number;
  scannedAt: string;
};

export type DiffScanResult = {
  componentVariantsScanned: number;
  diffSnapshotsCreated: number;
  addedFilesTotal: number;
  modifiedFilesTotal: number;
  deletedFilesTotal: number;
  warnings: ScanWarning[];
};

export type DiffOverviewDto = {
  componentVariantId: number;
  componentId: number;
  canonicalName: string;
  componentDisplayName: string;
  mappingKey: string;
  mappingDisplayName: string;
  mappingKind: MappingKind;
  diffSnapshotId: number | null;
  createdAt: string | null;
  addedCount: number;
  deletedCount: number;
  modifiedCount: number;
  unchangedCount: number;
  sourceComponentRootPath: string | null;
  targetComponentRootPath: string | null;
};

export type EvidenceType = 'snapshot' | 'recording' | 'log' | 'screenshot' | 'note' | 'agent_summary' | 'other';

export type EvidenceDto = {
  id: number;
  componentId: number | null;
  componentVariantId: number | null;
  cardId: number | null;
  type: EvidenceType;
  title: string;
  originalPath: string | null;
  storedPath: string;
  hashSha256: string | null;
  sizeBytes: number | null;
  importedAt: string;
  createdBy: string;
};

export type EvidenceImportResult = {
  imported: EvidenceDto[];
  warnings: ScanWarning[];
};

export type ReleaseCopyFileStatus = 'added' | 'modified';

export type ReleaseCopyFileEntry = {
  path: string;
  status: ReleaseCopyFileStatus;
};

export type ReleaseCopyPreviewSummary = {
  filesToCopyCount: number;
  addedCount: number;
  modifiedCount: number;
  targetOnlyPreservedCount: number;
  unchangedCount: number;
  scannedAt: string;
};

export type ReleaseCopyPreviewResult = {
  pendingOperationId: number | null;
  componentVariantId: number;
  summary: ReleaseCopyPreviewSummary | null;
  warnings: ScanWarning[];
};

export type ReleaseCopyApplyResult = {
  pendingOperationId: number;
  applied: boolean;
  copiedCount: number;
  warnings: ScanWarning[];
};

export type RepoRole = 'source' | 'target';

export type CommandRunKind = 'git' | 'build' | 'test' | 'lint' | 'release' | 'custom';

export type GitStatusEntryDto = {
  code: string;
  path: string;
};

export type GitStatusSnapshotDto = {
  repoMappingId: number | null;
  role: RepoRole | null;
  cwd: string | null;
  isRepo: boolean;
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  entries: GitStatusEntryDto[];
  error: string | null;
};

export type CommandPreviewInput = {
  repoMappingId: number;
  role: RepoRole;
  kind: CommandRunKind;
  /** Executable, resolved from PATH. Never passed through a shell. */
  command: string;
  /** Argument vector, passed verbatim to the child process. */
  args?: string[];
  cardId?: number | null;
  timeoutMs?: number;
};

export type CommandPreviewSummary = {
  repoMappingId: number;
  role: RepoRole;
  cwd: string;
  kind: CommandRunKind;
  command: string;
  args: string[];
  beforeStatus: GitStatusSnapshotDto;
  previewedAt: string;
};

export type CommandPreviewResult = {
  pendingOperationId: number | null;
  summary: CommandPreviewSummary | null;
  warnings: ScanWarning[];
};

export type CommandApplyResult = {
  pendingOperationId: number;
  applied: boolean;
  commandRunId: number | null;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  stdoutPath: string | null;
  stderrPath: string | null;
  durationMs: number;
  beforeStatus: GitStatusSnapshotDto | null;
  afterStatus: GitStatusSnapshotDto | null;
  warnings: ScanWarning[];
};

export type CommandRunDto = {
  id: number;
  repoId: number | null;
  repoMappingId: number | null;
  componentVariantId: number | null;
  cardId: number | null;
  kind: CommandRunKind;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string;
};

export type NextWorkResult = {
  /** Cards in actionable statuses, highest priority/severity first. */
  actionableCards: CardDto[];
  /** Component variants whose source has drifted from target (added/modified/deleted > 0). */
  driftedVariants: DiffOverviewDto[];
  /** Component variants with at least one open bug. */
  variantsWithOpenBugs: ComponentVariantOverviewDto[];
  /** Component variants missing a source or target root. */
  variantsMissingSourceOrTarget: ComponentVariantOverviewDto[];
  generatedAt: string;
};

export type CommandRunListResult = {
  runs: CommandRunDto[];
  /** Total number of recorded runs, regardless of the applied limit. */
  totalCount: number;
  /** The effective limit applied (null = no limit / all rows returned). */
  limit: number | null;
};

export type CommandRunOutputStream = {
  /** Absolute path the output was captured to, or null if none was recorded. */
  path: string | null;
  /** Captured text (bounded by a read cap), or empty string if unavailable. */
  text: string;
  /** True when the stored file was larger than the read cap and text was clipped. */
  truncated: boolean;
  /** True when a stored path exists in the DB but the file is missing on disk. */
  missing: boolean;
  /** Full size of the stored file in bytes, when known. */
  sizeBytes: number | null;
};

export type CommandRunOutputDto = {
  runId: number;
  found: boolean;
  stdout: CommandRunOutputStream;
  stderr: CommandRunOutputStream;
};

export type RevealResult = {
  revealed: boolean;
  path: string | null;
  error: string | null;
};

export type ClipboardWriteResult = {
  copied: boolean;
  error: string | null;
};

export type CardType = 'component' | 'bug' | 'task' | 'release' | 'evidence';

export type CardStatus = 'backlog' | 'developing' | 'untested' | 'needs_fix' | 'approved' | 'released' | 'archived';

export type CardPriority = 'low' | 'normal' | 'high' | 'urgent';

export type CardSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type CardDto = {
  id: number;
  type: CardType;
  title: string;
  description: string | null;
  status: CardStatus;
  priority: CardPriority;
  severity: CardSeverity;
  componentId: number | null;
  componentVariantId: number | null;
  repoMappingId: number | null;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  releasedAt: string | null;
  componentDisplayName?: string | null;
  mappingDisplayName?: string | null;
};

export type CreateCardInput = {
  type: CardType;
  title: string;
  description?: string | null;
  status?: CardStatus;
  priority?: CardPriority;
  severity?: CardSeverity;
  componentVariantId?: number | null;
  componentId?: number | null;
  repoMappingId?: number | null;
  source?: string;
  createdBy?: string;
};

export type UpdateCardInput = {
  title?: string;
  description?: string | null;
  status?: CardStatus;
  priority?: CardPriority;
  severity?: CardSeverity;
  componentVariantId?: number | null;
};

export type TBoardApi = {
  settings: {
    getWorkspaceRoot(): Promise<string | null>;
    setWorkspaceRoot(path: string): Promise<void>;
    /** A sensible OS-specific default workspace root (e.g. the user's documents folder). */
    getDefaultWorkspaceRoot(): Promise<string>;
  };
  inventory: {
    scanWorkspace(workspaceRoot?: string): Promise<ScanResult>;
    listRepoMappings(): Promise<RepoMappingDto[]>;
    listComponentVariants(): Promise<ComponentVariantOverviewDto[]>;
  };
  diff: {
    scanDiffs(): Promise<DiffScanResult>;
    listDiffOverviews(): Promise<DiffOverviewDto[]>;
  };
  evidence: {
    importFiles(componentVariantId: number, type: EvidenceType): Promise<EvidenceImportResult>;
    listEvidence(): Promise<EvidenceDto[]>;
    listEvidenceForVariant(componentVariantId: number): Promise<EvidenceDto[]>;
  };
  release: {
    previewCopy(componentVariantId: number): Promise<ReleaseCopyPreviewResult>;
    applyCopy(pendingOperationId: number): Promise<ReleaseCopyApplyResult>;
  };
  cards: {
    createCard(input: CreateCardInput): Promise<CardDto>;
    listCards(): Promise<CardDto[]>;
    updateCard(id: number, input: UpdateCardInput): Promise<CardDto>;
    moveCard(id: number, status: CardStatus): Promise<CardDto>;
  };
  clipboard: {
    /** Copies text to the OS clipboard via the main process (works under sandbox/contextIsolation). */
    writeText(text: string): Promise<ClipboardWriteResult>;
  };
  commands: {
    /** Read-only git status snapshot for one repo of a mapping. No confirmation. */
    gitStatus(repoMappingId: number, role: RepoRole): Promise<GitStatusSnapshotDto>;
    /** Preview a mutating command; records a pending operation. Runs nothing. */
    preview(input: CommandPreviewInput): Promise<CommandPreviewResult>;
    /** Apply a previously previewed command after explicit confirmation. */
    apply(pendingOperationId: number): Promise<CommandApplyResult>;
    /** List recorded command runs, newest first. Optional bounded limit (pass null/omit for all); result includes the total count. */
    listRuns(limit?: number | null): Promise<CommandRunListResult>;
    /** Read the captured stdout/stderr for a recorded run (bounded). */
    readRunOutput(runId: number): Promise<CommandRunOutputDto>;
    /** Open the folder containing a run's captured output in the OS file manager. */
    revealRunOutput(runId: number): Promise<RevealResult>;
  };
};

declare global {
  interface Window {
    tBoard: TBoardApi;
  }
}

export {};
