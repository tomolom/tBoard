import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CardDto,
  CardPriority,
  CardSeverity,
  CardStatus,
  CardType,
  CommandApplyResult,
  CommandPreviewResult,
  CommandRunDto,
  CommandRunKind,
  CommandRunOutputDto,
  CommandRunOutputStream,
  ComponentVariantOverviewDto,
  DiffOverviewDto,
  DiffScanResult,
  EvidenceDto,
  EvidenceImportResult,
  EvidenceType,
  GitStatusSnapshotDto,
  MappingKind,
  ReleaseCopyApplyResult,
  ReleaseCopyPreviewResult,
  RepoMappingDto,
  RepoRole,
  ScanResult,
} from '../../shared/api';
import { useFocusTrap } from './useFocusTrap';

const WORKSPACE_ROOT_PLACEHOLDER = 'Folder containing your project repos';
const STATUSES: CardStatus[] = [
  'backlog',
  'developing',
  'untested',
  'needs_fix',
  'approved',
  'released',
  'archived',
];
const IMPORTABLE_EVIDENCE_TYPES: EvidenceType[] = ['snapshot', 'recording', 'log', 'screenshot', 'other'];
const CARD_TYPES: CardType[] = ['component', 'bug', 'task', 'release', 'evidence'];
const CARD_PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];
const CARD_SEVERITIES: CardSeverity[] = ['none', 'low', 'medium', 'high', 'critical'];
const REPO_ROLES: RepoRole[] = ['source', 'target'];
const RUN_HISTORY_PAGE = 25;

type RailTabId = 'inventory' | 'diffs' | 'release' | 'commands' | 'evidence';

const RAIL_TABS: { id: RailTabId; label: string }[] = [
  { id: 'inventory', label: 'Inventory' },
  { id: 'diffs', label: 'Diffs' },
  { id: 'release', label: 'Release' },
  { id: 'commands', label: 'Commands' },
  { id: 'evidence', label: 'Evidence' },
];
const COMMAND_KINDS: CommandRunKind[] = ['git', 'build', 'test', 'lint', 'release', 'custom'];

/**
 * Words that must not be Title-Cased naively. Keyed by the lowercased token.
 * Covers acronyms plus product names with internal capitals.
 */
const LABEL_SPECIAL_CASES: Record<string, string> = {
  osnr: 'OSNR',
  osrsps: 'OSRSPS',
  osrs: 'OSRS',
  mcp: 'MCP',
  iat: 'IAT',
  pe: 'PE',
  db: 'DB',
  ui: 'UI',
  id: 'ID',
  url: 'URL',
  sha: 'SHA',
  wal: 'WAL',
  api: 'API',
  cwd: 'CWD',
  roelite: 'RoeLite',
};

/**
 * Turns an enum value or identifier into a display label:
 * `needs_fix` → "Needs Fix", `osnr` → "OSNR", `git` → "Git".
 *
 * Only the DISPLAY changes — enum values sent to the backend are untouched.
 */
function humanizeLabel(value: string): string {
  return value
    .split(/[\s_]+/u)
    .filter(Boolean)
    .map((word) => {
      const special = LABEL_SPECIAL_CASES[word.toLowerCase()];
      if (special) {
        return special;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Short label for a mapping kind. `single` has no release target. */
function mappingKindLabel(kind: MappingKind): string {
  return kind === 'single' ? 'Single repo' : 'Source → target';
}

function MappingKindBadge({ kind }: { kind: MappingKind }) {
  const title =
    kind === 'single'
      ? 'One repo. Diff and release copy do not apply.'
      : 'Paired repos. Diff and release copy compare source against target.';
  return (
    <small className={`kind-badge kind-${kind}`} title={title}>
      {mappingKindLabel(kind)}
    </small>
  );
}

function leafName(path: string | null): string {
  if (!path) {
    return '—';
  }
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'never';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function shortSha(sha: string | null): string {
  if (!sha) {
    return '—';
  }
  return sha.slice(0, 7);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
}

function parseArgs(raw: string): string[] {
  return raw.trim().split(/\s+/u).filter(Boolean);
}

function workingTreeLabel(status: GitStatusSnapshotDto): string {
  if (!status.isRepo) {
    return 'not a repo';
  }
  return status.dirty ? `dirty (${status.entries.length})` : 'clean';
}

function GitStatusView({ label, status }: { label: string; status: GitStatusSnapshotDto }) {
  if (!status.isRepo || status.error) {
    return (
      <div className="git-status">
        <span className="git-status-label">{label}</span>
        <p className="empty">
          {status.error ?? 'Not a git repository.'}
          {status.cwd ? (
            <>
              {' '}
              <code>{status.cwd}</code>
            </>
          ) : null}
        </p>
      </div>
    );
  }
  return (
    <div className="git-status">
      <span className="git-status-label">{label}</span>
      <div className="scan-summary">
        <span className="git-branch">{status.branch ?? 'detached'}</span>
        <span>HEAD {shortSha(status.headSha)}</span>
        <span className={status.dirty ? 'tone-modified' : 'tone-added'}>{workingTreeLabel(status)}</span>
        <span>ahead {status.ahead}</span>
        <span>behind {status.behind}</span>
      </div>
      {status.entries.length ? (
        <ul className="git-entries">
          {status.entries.map((entry, index) => (
            <li key={`${entry.code}-${entry.path}-${index}`}>
              <code className="git-code">{entry.code.padEnd(2, ' ')}</code>
              <span>{entry.path}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">Working tree clean — nothing staged or modified.</p>
      )}
    </div>
  );
}

function StatusDelta({
  before,
  after,
}: {
  before: GitStatusSnapshotDto | null;
  after: GitStatusSnapshotDto | null;
}) {
  if (!before || !after) {
    return null;
  }
  const rows = [
    { label: 'Branch', from: before.branch ?? '—', to: after.branch ?? '—' },
    { label: 'HEAD', from: shortSha(before.headSha), to: shortSha(after.headSha) },
    { label: 'Working tree', from: workingTreeLabel(before), to: workingTreeLabel(after) },
    { label: 'Ahead / behind', from: `${before.ahead} / ${before.behind}`, to: `${after.ahead} / ${after.behind}` },
  ];
  return (
    <div className="status-delta">
      <span className="git-status-label">Before → after</span>
      {rows.map((row) => {
        const changed = row.from !== row.to;
        return (
          <div className={`delta-row${changed ? ' changed' : ''}`} key={row.label}>
            <span className="delta-label">{row.label}</span>
            <code>{row.from}</code>
            <span className="arrow">→</span>
            <code>{row.to}</code>
            {changed ? <span className="delta-flag">changed</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function OutputStream({
  label,
  stream,
  onCopy,
  copied,
}: {
  label: string;
  stream: CommandRunOutputStream;
  onCopy: (label: string, text: string) => void;
  copied: boolean;
}) {
  const hasText = stream.text.length > 0;
  const canCopy = hasText && !stream.missing;
  return (
    <div className={`output-stream stream-${label}`}>
      <div className="output-stream-head">
        <span className="output-stream-name">{label}</span>
        {stream.sizeBytes !== null ? <span className="output-meta">{formatBytes(stream.sizeBytes)}</span> : null}
        {stream.truncated ? <span className="output-meta tone-modified">clipped</span> : null}
        {stream.path ? (
          <code className="output-path" title={stream.path}>
            {stream.path}
          </code>
        ) : null}
        {canCopy ? (
          <button type="button" className="link-button" onClick={() => onCopy(label, stream.text)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
      {stream.missing ? (
        <p className="output-note tone-deleted">Output file no longer on disk.</p>
      ) : hasText ? (
        <>
          <pre className="output-text">{stream.text}</pre>
          {stream.truncated ? (
            <p className="output-note">Output clipped — reveal in folder and open the file for the full log.</p>
          ) : null}
        </>
      ) : (
        <p className="output-note muted">No {label}.</p>
      )}
    </div>
  );
}

function CommandOutputView({
  output,
  busy,
  error,
  onCopy,
  copiedStream,
  copyError,
}: {
  output: CommandRunOutputDto | null;
  busy: boolean;
  error: string | null;
  onCopy: (label: string, text: string) => void;
  copiedStream: string | null;
  copyError: string | null;
}) {
  if (busy) {
    return <p className="empty">Loading output…</p>;
  }
  if (error) {
    return <p className="error">{error}</p>;
  }
  if (!output) {
    return null;
  }
  if (!output.found) {
    return <p className="empty">No stored output for run #{output.runId}.</p>;
  }
  return (
    <div className="command-output">
      {copyError ? <p className="error">{copyError}</p> : null}
      <OutputStream label="stdout" stream={output.stdout} onCopy={onCopy} copied={copiedStream === 'stdout'} />
      <OutputStream label="stderr" stream={output.stderr} onCopy={onCopy} copied={copiedStream === 'stderr'} />
    </div>
  );
}

function driftOf(overview: DiffOverviewDto): number {
  return overview.addedCount + overview.modifiedCount + overview.deletedCount;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [repoMappings, setRepoMappings] = useState<RepoMappingDto[]>([]);
  const [componentVariants, setComponentVariants] = useState<ComponentVariantOverviewDto[]>([]);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffOverviews, setDiffOverviews] = useState<DiffOverviewDto[]>([]);
  const [diffScanResult, setDiffScanResult] = useState<DiffScanResult | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [driftOnly, setDriftOnly] = useState(false);
  const [evidenceItems, setEvidenceItems] = useState<EvidenceDto[]>([]);
  const [evidenceImport, setEvidenceImport] = useState<EvidenceImportResult | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceVariantId, setEvidenceVariantId] = useState<number | null>(null);
  const [evidenceType, setEvidenceType] = useState<EvidenceType>('screenshot');
  const [evidenceScopedToVariant, setEvidenceScopedToVariant] = useState(false);
  const [releaseVariantId, setReleaseVariantId] = useState<number | null>(null);
  const [releasePreview, setReleasePreview] = useState<ReleaseCopyPreviewResult | null>(null);
  const [releaseApply, setReleaseApply] = useState<ReleaseCopyApplyResult | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseApplying, setReleaseApplying] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  const [cards, setCards] = useState<CardDto[]>([]);
  const [cardTitle, setCardTitle] = useState('');
  const [cardType, setCardType] = useState<CardType>('task');
  const [cardPriority, setCardPriority] = useState<CardPriority>('normal');
  const [cardSeverity, setCardSeverity] = useState<CardSeverity>('none');
  const [cardVariantId, setCardVariantId] = useState<number | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [movingCardId, setMovingCardId] = useState<number | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [detailTitle, setDetailTitle] = useState('');
  const [detailDescription, setDetailDescription] = useState('');
  const [detailPriority, setDetailPriority] = useState<CardPriority>('normal');
  const [detailSeverity, setDetailSeverity] = useState<CardSeverity>('none');
  const [detailVariantId, setDetailVariantId] = useState<number | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const setupCloseRef = useRef<HTMLButtonElement | null>(null);
  const setupRef = useRef<HTMLDivElement | null>(null);
  const [showInventoryBoard, setShowInventoryBoard] = useState(false);
  const [activeTab, setActiveTab] = useState<RailTabId>('inventory');
  const [setupOpen, setSetupOpen] = useState(false);
  // null while the saved root is still loading, so first-run copy doesn't flash.
  const [projectConfigured, setProjectConfigured] = useState<boolean | null>(null);
  const [commandMappingId, setCommandMappingId] = useState<number | null>(null);
  const [commandRole, setCommandRole] = useState<RepoRole>('source');
  const [commandKind, setCommandKind] = useState<CommandRunKind>('git');
  const [commandName, setCommandName] = useState('git');
  const [commandArgs, setCommandArgs] = useState('status --porcelain');
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshotDto | null>(null);
  const [gitStatusBusy, setGitStatusBusy] = useState(false);
  const [commandPreview, setCommandPreview] = useState<CommandPreviewResult | null>(null);
  const [commandApply, setCommandApply] = useState<CommandApplyResult | null>(null);
  const [commandPreviewBusy, setCommandPreviewBusy] = useState(false);
  const [commandApplying, setCommandApplying] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandConfirmed, setCommandConfirmed] = useState(false);
  const [commandRuns, setCommandRuns] = useState<CommandRunDto[]>([]);
  const [runTotalCount, setRunTotalCount] = useState(0);
  const [runHistoryLimit, setRunHistoryLimit] = useState<number | null>(RUN_HISTORY_PAGE);
  const [runHistoryBusy, setRunHistoryBusy] = useState(false);
  const runHistoryLimitRef = useRef<number | null>(RUN_HISTORY_PAGE);
  const requestedAllRuns = runHistoryLimit === null;
  const [openOutput, setOpenOutput] = useState<{ source: 'apply' | 'history'; runId: number } | null>(null);
  const [runOutput, setRunOutput] = useState<CommandRunOutputDto | null>(null);
  const [runOutputBusy, setRunOutputBusy] = useState(false);
  const [runOutputError, setRunOutputError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [copiedStream, setCopiedStream] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refreshDiffOverviews(): Promise<void> {
    setDiffOverviews(await window.tBoard.diff.listDiffOverviews());
  }

  async function refreshEvidence(): Promise<void> {
    setEvidenceItems(await window.tBoard.evidence.listEvidence());
  }

  async function refresh(): Promise<void> {
    const [mappings, variants, overviews, evidence, cardList] = await Promise.all([
      window.tBoard.inventory.listRepoMappings(),
      window.tBoard.inventory.listComponentVariants(),
      window.tBoard.diff.listDiffOverviews(),
      window.tBoard.evidence.listEvidence(),
      window.tBoard.cards.listCards(),
    ]);
    setRepoMappings(mappings);
    setComponentVariants(variants);
    setDiffOverviews(overviews);
    setEvidenceItems(evidence);
    setCards(cardList);
  }

  async function refreshCards(): Promise<void> {
    setCards(await window.tBoard.cards.listCards());
  }

  async function refreshCommandRuns(limit: number | null = runHistoryLimitRef.current): Promise<void> {
    runHistoryLimitRef.current = limit;
    const result = await window.tBoard.commands.listRuns(limit);
    setCommandRuns(result.runs);
    setRunTotalCount(result.totalCount);
    setRunHistoryLimit(result.limit);
  }

  async function showAllRuns(): Promise<void> {
    setRunHistoryBusy(true);
    try {
      await refreshCommandRuns(null);
    } catch (listError) {
      setCommandError(listError instanceof Error ? listError.message : String(listError));
    } finally {
      setRunHistoryBusy(false);
    }
  }

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  function clearCopyState(): void {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopiedStream(null);
    setCopyError(null);
  }

  async function copyStreamText(label: string, text: string): Promise<void> {
    clearCopyState();
    try {
      const result = await window.tBoard.clipboard.writeText(text);
      if (!result.copied) {
        setCopyError(result.error ?? 'Could not copy to the clipboard.');
        return;
      }
      setCopiedStream(label);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedStream(null);
      }, 1500);
    } catch (error_) {
      setCopyError(error_ instanceof Error ? error_.message : String(error_));
    }
  }

  function closeRunOutput(): void {
    setOpenOutput(null);
    setRunOutput(null);
    setRunOutputError(null);
    setRevealError(null);
    clearCopyState();
  }

  async function viewRunOutput(source: 'apply' | 'history', runId: number): Promise<void> {
    if (openOutput?.source === source && openOutput.runId === runId) {
      closeRunOutput();
      return;
    }
    setOpenOutput({ source, runId });
    setRunOutput(null);
    setRunOutputError(null);
    setRevealError(null);
    clearCopyState();
    setRunOutputBusy(true);
    try {
      const output = await window.tBoard.commands.readRunOutput(runId);
      setRunOutput(output);
    } catch (outputError) {
      setRunOutputError(outputError instanceof Error ? outputError.message : String(outputError));
    } finally {
      setRunOutputBusy(false);
    }
  }

  async function revealRunOutput(runId: number): Promise<void> {
    setRevealError(null);
    try {
      const result = await window.tBoard.commands.revealRunOutput(runId);
      if (!result.revealed) {
        setRevealError(result.error ?? 'Could not open the output folder.');
      }
    } catch (error_) {
      setRevealError(error_ instanceof Error ? error_.message : String(error_));
    }
  }

  useEffect(() => {
    void (async () => {
      const savedRoot = await window.tBoard.settings.getWorkspaceRoot();
      if (savedRoot) {
        setWorkspaceRoot(savedRoot);
        setProjectConfigured(true);
      } else {
        // Pre-fill only. Nothing is persisted until the user hits Save.
        setWorkspaceRoot(await window.tBoard.settings.getDefaultWorkspaceRoot());
        // No project yet — land the user in setup. Only fires here, on mount.
        setProjectConfigured(false);
        setSetupOpen(true);
      }
      await refresh();
      await refreshCommandRuns();
    })();
  }, []);

  async function saveWorkspaceRoot(): Promise<void> {
    setError(null);
    await window.tBoard.settings.setWorkspaceRoot(workspaceRoot.trim());
    setProjectConfigured(workspaceRoot.trim().length > 0);
  }

  function closeSetup(): void {
    setSetupOpen(false);
  }

  async function runScan(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await saveWorkspaceRoot();
      const result = await window.tBoard.inventory.scanWorkspace(workspaceRoot.trim());
      setScanResult(result);
      await refresh();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setBusy(false);
    }
  }

  async function runDiffScan(): Promise<void> {
    setDiffBusy(true);
    setDiffError(null);
    try {
      const result = await window.tBoard.diff.scanDiffs();
      setDiffScanResult(result);
      await refreshDiffOverviews();
    } catch (scanError) {
      setDiffError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setDiffBusy(false);
    }
  }

  const diffTotals = useMemo(() => {
    return diffOverviews.reduce(
      (totals, overview) => ({
        added: totals.added + overview.addedCount,
        modified: totals.modified + overview.modifiedCount,
        deleted: totals.deleted + overview.deletedCount,
        unchanged: totals.unchanged + overview.unchangedCount,
        drifted: totals.drifted + (driftOf(overview) > 0 ? 1 : 0),
        unscanned: totals.unscanned + (overview.diffSnapshotId === null ? 1 : 0),
      }),
      { added: 0, modified: 0, deleted: 0, unchanged: 0, drifted: 0, unscanned: 0 },
    );
  }, [diffOverviews]);

  const visibleDiffOverviews = useMemo(() => {
    const rows = driftOnly ? diffOverviews.filter((overview) => driftOf(overview) > 0) : diffOverviews;
    return [...rows].sort((left, right) => {
      const byDrift = driftOf(right) - driftOf(left);
      if (byDrift !== 0) {
        return byDrift;
      }
      return left.componentDisplayName.localeCompare(right.componentDisplayName);
    });
  }, [diffOverviews, driftOnly]);

  const variantById = useMemo(() => {
    return new Map(componentVariants.map((variant) => [variant.componentVariantId, variant]));
  }, [componentVariants]);

  // Diff and release copy are source-vs-target operations, so they only apply
  // to paired mappings. A workspace can hold a mix of both kinds.
  const releasableVariants = useMemo(
    () => componentVariants.filter((variant) => variant.mappingKind === 'source_target'),
    [componentVariants],
  );
  const hasPairedMappings = useMemo(
    () => repoMappings.some((mapping) => mapping.mappingKind === 'source_target'),
    [repoMappings],
  );
  const commandMapping = useMemo(
    () => repoMappings.find((mapping) => mapping.id === commandMappingId) ?? null,
    [repoMappings, commandMappingId],
  );
  // A single mapping has no target repo, so 'target' is not a valid role for it.
  const commandRoles = useMemo<RepoRole[]>(
    () => (commandMapping?.mappingKind === 'single' ? ['source'] : REPO_ROLES),
    [commandMapping],
  );

  useEffect(() => {
    if (componentVariants.length === 0) {
      setEvidenceVariantId(null);
      return;
    }
    setEvidenceVariantId((current) =>
      current !== null && variantById.has(current) ? current : componentVariants[0].componentVariantId,
    );
  }, [componentVariants, variantById]);

  // Only paired variants are selectable here — keep the selection inside that set.
  useEffect(() => {
    if (releasableVariants.length === 0) {
      setReleaseVariantId(null);
      return;
    }
    setReleaseVariantId((current) =>
      current !== null && releasableVariants.some((variant) => variant.componentVariantId === current)
        ? current
        : releasableVariants[0].componentVariantId,
    );
  }, [releasableVariants]);

  function selectReleaseVariant(variantId: number): void {
    setReleaseVariantId(variantId);
    setReleasePreview(null);
    setReleaseApply(null);
    setReleaseError(null);
    setApplyConfirmed(false);
  }

  async function runReleasePreview(): Promise<void> {
    if (releaseVariantId === null) {
      return;
    }
    setReleaseBusy(true);
    setReleaseError(null);
    setReleaseApply(null);
    setApplyConfirmed(false);
    try {
      setReleasePreview(await window.tBoard.release.previewCopy(releaseVariantId));
    } catch (previewError) {
      setReleasePreview(null);
      setReleaseError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setReleaseBusy(false);
    }
  }

  async function runReleaseApply(): Promise<void> {
    const pendingOperationId = releasePreview?.pendingOperationId;
    if (pendingOperationId === null || pendingOperationId === undefined) {
      return;
    }
    setReleaseApplying(true);
    setReleaseError(null);
    try {
      const result = await window.tBoard.release.applyCopy(pendingOperationId);
      setReleaseApply(result);
      setApplyConfirmed(false);
      if (result.applied) {
        setReleasePreview(null);
        await refresh();
      }
    } catch (applyError) {
      setReleaseError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setReleaseApplying(false);
    }
  }

  useEffect(() => {
    if (repoMappings.length === 0) {
      setCommandMappingId(null);
      return;
    }
    setCommandMappingId((current) =>
      current !== null && repoMappings.some((mapping) => mapping.id === current) ? current : repoMappings[0].id,
    );
  }, [repoMappings]);

  function resetCommandFlow(): void {
    setCommandPreview(null);
    setCommandApply(null);
    setCommandError(null);
    setCommandConfirmed(false);
    closeRunOutput();
  }

  function selectCommandMapping(mappingId: number): void {
    setCommandMappingId(mappingId);
    setGitStatus(null);
    resetCommandFlow();
  }

  function selectCommandRole(role: RepoRole): void {
    setCommandRole(role);
    setGitStatus(null);
    resetCommandFlow();
  }

  // Switching to a single mapping drops the target role, which it has no repo for.
  useEffect(() => {
    if (commandMapping?.mappingKind === 'single' && commandRole !== 'source') {
      setCommandRole('source');
    }
  }, [commandMapping, commandRole]);

  async function inspectGitStatus(): Promise<void> {
    if (commandMappingId === null) {
      return;
    }
    setGitStatusBusy(true);
    setCommandError(null);
    try {
      setGitStatus(await window.tBoard.commands.gitStatus(commandMappingId, commandRole));
    } catch (statusError) {
      setGitStatus(null);
      setCommandError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setGitStatusBusy(false);
    }
  }

  async function runCommandPreview(): Promise<void> {
    const executable = commandName.trim();
    if (commandMappingId === null) {
      return;
    }
    if (!executable) {
      setCommandError('Command is required.');
      return;
    }
    setCommandPreviewBusy(true);
    setCommandError(null);
    setCommandApply(null);
    setCommandConfirmed(false);
    try {
      setCommandPreview(
        await window.tBoard.commands.preview({
          repoMappingId: commandMappingId,
          role: commandRole,
          kind: commandKind,
          command: executable,
          args: parseArgs(commandArgs),
        }),
      );
    } catch (previewError) {
      setCommandPreview(null);
      setCommandError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setCommandPreviewBusy(false);
    }
  }

  async function runCommandApply(): Promise<void> {
    const pendingOperationId = commandPreview?.pendingOperationId;
    if (pendingOperationId === null || pendingOperationId === undefined) {
      return;
    }
    setCommandApplying(true);
    setCommandError(null);
    try {
      const result = await window.tBoard.commands.apply(pendingOperationId);
      closeRunOutput();
      setCommandApply(result);
      setCommandConfirmed(false);
      setCommandPreview(null);
      if (result.afterStatus) {
        setGitStatus(result.afterStatus);
      }
      await refreshCommandRuns();
    } catch (applyError) {
      setCommandError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setCommandApplying(false);
    }
  }

  async function importEvidence(): Promise<void> {
    if (evidenceVariantId === null) {
      return;
    }
    setEvidenceBusy(true);
    setEvidenceError(null);
    try {
      const result = await window.tBoard.evidence.importFiles(evidenceVariantId, evidenceType);
      setEvidenceImport(result);
      await refresh();
    } catch (importError) {
      setEvidenceError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setEvidenceBusy(false);
    }
  }

  const visibleEvidence = useMemo(() => {
    const rows =
      evidenceScopedToVariant && evidenceVariantId !== null
        ? evidenceItems.filter((item) => item.componentVariantId === evidenceVariantId)
        : evidenceItems;
    return [...rows].sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  }, [evidenceItems, evidenceScopedToVariant, evidenceVariantId]);

  const variantsByStatus = useMemo(() => {
    const grouped = new Map<string, ComponentVariantOverviewDto[]>();
    for (const status of STATUSES) {
      grouped.set(status, []);
    }
    for (const variant of componentVariants) {
      const status = grouped.has(variant.lifecycleStatus) ? variant.lifecycleStatus : 'backlog';
      grouped.get(status)!.push(variant);
    }
    return grouped;
  }, [componentVariants]);

  const cardsByStatus = useMemo(() => {
    const grouped = new Map<CardStatus, CardDto[]>();
    for (const status of STATUSES) {
      grouped.set(status, []);
    }
    for (const card of cards) {
      const status = grouped.has(card.status) ? card.status : 'backlog';
      grouped.get(status)!.push(card);
    }
    for (const list of grouped.values()) {
      list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    return grouped;
  }, [cards]);

  async function createCard(): Promise<void> {
    const title = cardTitle.trim();
    if (!title) {
      setCardError('Title is required.');
      return;
    }
    setCardBusy(true);
    setCardError(null);
    try {
      await window.tBoard.cards.createCard({
        type: cardType,
        title,
        priority: cardPriority,
        severity: cardSeverity,
        componentVariantId: cardVariantId,
      });
      setCardTitle('');
      await refreshCards();
    } catch (createError) {
      setCardError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCardBusy(false);
    }
  }

  async function moveCard(cardId: number, status: CardStatus): Promise<void> {
    setMovingCardId(cardId);
    setCardError(null);
    try {
      await window.tBoard.cards.moveCard(cardId, status);
      await refreshCards();
    } catch (moveError) {
      setCardError(moveError instanceof Error ? moveError.message : String(moveError));
    } finally {
      setMovingCardId(null);
    }
  }

  const applyOutputOpen =
    openOutput?.source === 'apply' &&
    commandApply?.commandRunId !== null &&
    commandApply?.commandRunId !== undefined &&
    openOutput.runId === commandApply.commandRunId;

  function cardVariantLabel(card: CardDto): string | null {
    const variant = card.componentVariantId === null ? undefined : variantById.get(card.componentVariantId);
    const component = card.componentDisplayName ?? variant?.componentDisplayName ?? null;
    const mapping = card.mappingDisplayName ?? variant?.mappingDisplayName ?? null;
    if (component && mapping) {
      return `${component} · ${mapping}`;
    }
    return component ?? mapping;
  }

  const selectedCard = useMemo(
    () => (selectedCardId === null ? null : cards.find((card) => card.id === selectedCardId) ?? null),
    [cards, selectedCardId],
  );

  function openCardDetail(card: CardDto): void {
    setSelectedCardId(card.id);
    setDetailTitle(card.title);
    setDetailDescription(card.description ?? '');
    setDetailPriority(card.priority);
    setDetailSeverity(card.severity);
    setDetailVariantId(card.componentVariantId);
    setDetailError(null);
  }

  function closeCardDetail(): void {
    setSelectedCardId(null);
    setDetailError(null);
  }

  useEffect(() => {
    if (selectedCardId === null) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        closeCardDetail();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Initial focus and restore are owned by useFocusTrap below.
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [selectedCardId]);

  useFocusTrap(selectedCardId !== null, drawerRef, { initialFocusRef: drawerCloseRef });

  // Same overlay contract as the card drawer: Esc closes, background scroll locks,
  // focus lands on the close button.
  useEffect(() => {
    if (!setupOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        closeSetup();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Initial focus and restore are owned by useFocusTrap below.
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [setupOpen]);

  useFocusTrap(setupOpen, setupRef, { initialFocusRef: setupCloseRef });

  // The open card was deleted or filtered away in a refresh — drop the drawer.
  useEffect(() => {
    if (selectedCardId !== null && cards.length > 0 && !cards.some((card) => card.id === selectedCardId)) {
      setSelectedCardId(null);
    }
  }, [cards, selectedCardId]);

  const detailDirty = useMemo(() => {
    if (!selectedCard) {
      return false;
    }
    return (
      detailTitle.trim() !== selectedCard.title ||
      detailDescription !== (selectedCard.description ?? '') ||
      detailPriority !== selectedCard.priority ||
      detailSeverity !== selectedCard.severity ||
      detailVariantId !== selectedCard.componentVariantId
    );
  }, [detailDescription, detailPriority, detailSeverity, detailTitle, detailVariantId, selectedCard]);

  async function saveCardDetail(): Promise<void> {
    if (!selectedCard) {
      return;
    }
    const title = detailTitle.trim();
    if (!title) {
      setDetailError('Title is required.');
      return;
    }
    setDetailBusy(true);
    setDetailError(null);
    try {
      await window.tBoard.cards.updateCard(selectedCard.id, {
        title,
        description: detailDescription.trim() === '' ? null : detailDescription,
        priority: detailPriority,
        severity: detailSeverity,
        componentVariantId: detailVariantId,
      });
      await refreshCards();
    } catch (updateError) {
      setDetailError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setDetailBusy(false);
    }
  }

  async function moveCardDetail(status: CardStatus): Promise<void> {
    if (!selectedCard) {
      return;
    }
    setDetailBusy(true);
    setDetailError(null);
    try {
      await window.tBoard.cards.moveCard(selectedCard.id, status);
      await refreshCards();
    } catch (moveError) {
      setDetailError(moveError instanceof Error ? moveError.message : String(moveError));
    } finally {
      setDetailBusy(false);
    }
  }

  function resetCardDetail(): void {
    if (!selectedCard) {
      return;
    }
    openCardDetail(selectedCard);
  }

  function renderHeader() {
    return (
      <header className="hero">
        <div>
          <p className="eyebrow">tBoard beta</p>
          <h1>Project Workflow Board</h1>
        </div>
        <div className="hero-stats">
          <div className="summary-card">
            <strong>{cards.length}</strong>
            <span>cards</span>
          </div>
          <div className="summary-card">
            <strong>{componentVariants.length}</strong>
            <span>component variants</span>
          </div>
          <button type="button" className="setup-trigger" onClick={() => setSetupOpen(true)}>
            <span aria-hidden="true">⚙</span> Project Setup
          </button>
        </div>
      </header>
    );
  }

    function renderProjectSetup() {
    const firstRun = projectConfigured === false;
    return (
      <div className="setup-overlay" role="presentation" onClick={() => closeSetup()}>
        <div
          className="setup-modal"
          ref={setupRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="setup-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="setup-header">
            <div>
              <h2 id="setup-title">Project Setup</h2>
              <p>
                {firstRun
                  ? 'Point tBoard at the folder that holds your project repos, then scan. Single-repo projects and paired source → target repos are both supported.'
                  : 'Parent folder containing your project repos.'}
              </p>
            </div>
            <button
              type="button"
              className="drawer-close"
              ref={setupCloseRef}
              onClick={() => closeSetup()}
              aria-label="Close project setup"
            >
              ×
            </button>
          </div>

          <div className="setup-body">
            <label className="field setup-field">
              <span>Workspace Root</span>
              <input
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                placeholder={WORKSPACE_ROOT_PLACEHOLDER}
                spellCheck={false}
              />
            </label>

            <div className="setup-actions">
              <button type="button" onClick={() => void saveWorkspaceRoot()} disabled={busy}>
                Save
              </button>
              <button type="button" className="primary" onClick={() => void runScan()} disabled={busy}>
                {busy ? 'Scanning…' : 'Scan for repos'}
              </button>
            </div>

            {error ? <p className="error">{error}</p> : null}
            {scanResult ? (
              <div className="scan-summary">
                <span>{scanResult.repoMappingsFound} mappings</span>
                <span>{scanResult.reposFound} repos</span>
                <span>{scanResult.componentsFound} components</span>
                <span>{scanResult.componentVariantsFound} variants</span>
              </div>
            ) : null}
            {scanResult?.warnings.length ? (
              <ul className="warnings">
                {scanResult.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    <strong>{warning.code}</strong>: {warning.message} {warning.path ? <code>{warning.path}</code> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    );
  }


  function renderInventoryTables() {
    return (
      <section className="grid two-col">
        <div className="panel">
          <h2>Repo Mappings</h2>
          {repoMappings.length ? (
            <table>
              <thead>
                <tr>
                  <th>Mapping</th>
                  <th>Kind</th>
                  <th>Primary Repo</th>
                  <th>Release Target</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {repoMappings.map((mapping) => (
                  <tr key={mapping.id}>
                    <td>{mapping.displayName}</td>
                    <td>
                      <MappingKindBadge kind={mapping.mappingKind} />
                    </td>
                    <td title={mapping.sourceRepoPath}>{leafName(mapping.sourceRepoPath)}</td>
                    <td title={mapping.targetRepoPath ?? undefined}>
                      {mapping.targetRepoPath ? (
                        leafName(mapping.targetRepoPath)
                      ) : (
                        <span className="not-applicable">Not applicable</span>
                      )}
                    </td>
                    <td>{mapping.enabled ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No repos found yet. Run a scan from Project Setup.</p>
          )}
        </div>

        <div className="panel">
          <h2>Component Matrix</h2>
          {componentVariants.length ? (
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Mapping</th>
                  <th>Primary</th>
                  <th>Release Target</th>
                  <th>Test</th>
                </tr>
              </thead>
              <tbody>
                {componentVariants.map((variant) => (
                  <tr key={variant.componentVariantId}>
                    <td>{variant.componentDisplayName}</td>
                    <td>{variant.mappingDisplayName}</td>
                    <td className={variant.sourceExists ? undefined : 'tone-deleted'}>
                      {variant.sourceExists ? 'Yes' : 'No'}
                    </td>
                    <td>
                      {variant.mappingKind === 'single' ? (
                        <span className="not-applicable">N/A</span>
                      ) : (
                        <span className={variant.targetExists ? undefined : 'tone-deleted'}>
                          {variant.targetExists ? 'Yes' : 'No'}
                        </span>
                      )}
                    </td>
                    <td>{humanizeLabel(variant.testedState)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No component variants found yet. Run a scan from Project Setup.</p>
          )}
        </div>
      </section>
    );
  }

  function renderDiffSection() {
    return (
      <section className="panel diff-panel">
        <div className="panel-header">
          <div>
            <h2>Diff Dashboard</h2>
            <p>File-level drift between each source component and its target copy. Paired repos only.</p>
          </div>
          <div className="panel-actions">
            <label className="toggle">
              <input
                type="checkbox"
                checked={driftOnly}
                onChange={(event) => setDriftOnly(event.target.checked)}
              />
              Drift only
            </label>
            <button
              type="button"
              className="primary"
              onClick={() => void runDiffScan()}
              disabled={diffBusy || !hasPairedMappings}
            >
              {diffBusy ? 'Scanning diffs…' : 'Scan diffs'}
            </button>
          </div>
        </div>

        {diffError ? <p className="error">{diffError}</p> : null}

        {diffScanResult ? (
          <div className="scan-summary">
            <span>{diffScanResult.componentVariantsScanned} variants scanned</span>
            <span>{diffScanResult.diffSnapshotsCreated} snapshots</span>
            <span className="tone-added">+{diffScanResult.addedFilesTotal} added</span>
            <span className="tone-modified">~{diffScanResult.modifiedFilesTotal} modified</span>
            <span className="tone-deleted">-{diffScanResult.deletedFilesTotal} deleted</span>
          </div>
        ) : null}

        {diffScanResult?.warnings.length ? (
          <ul className="warnings">
            {diffScanResult.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <strong>{warning.code}</strong>: {warning.message} {warning.path ? <code>{warning.path}</code> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {diffOverviews.length ? (
          <div className="diff-totals">
            <div className="stat">
              <strong className="tone-added">{diffTotals.added}</strong>
              <span>added</span>
            </div>
            <div className="stat">
              <strong className="tone-modified">{diffTotals.modified}</strong>
              <span>modified</span>
            </div>
            <div className="stat">
              <strong className="tone-deleted">{diffTotals.deleted}</strong>
              <span>deleted</span>
            </div>
            <div className="stat">
              <strong>{diffTotals.unchanged}</strong>
              <span>unchanged</span>
            </div>
            <div className="stat">
              <strong>{diffTotals.drifted}</strong>
              <span>variants with drift</span>
            </div>
            <div className="stat">
              <strong>{diffTotals.unscanned}</strong>
              <span>never scanned</span>
            </div>
          </div>
        ) : null}

        {visibleDiffOverviews.length ? (
          <div className="table-scroll">
            <table className="diff-table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Mapping</th>
                  <th className="num">Added</th>
                  <th className="num">Modified</th>
                  <th className="num">Deleted</th>
                  <th className="num">Unchanged</th>
                  <th>Last Scanned</th>
                  <th>Source → Target</th>
                </tr>
              </thead>
              <tbody>
                {visibleDiffOverviews.map((overview) => {
                  const drift = driftOf(overview);
                  const scanned = overview.diffSnapshotId !== null;
                  return (
                    <tr key={overview.componentVariantId} className={drift > 0 ? 'has-drift' : undefined}>
                      <td>
                        <strong>{overview.componentDisplayName}</strong>
                        <small className="muted">{overview.canonicalName}</small>
                      </td>
                      <td title={overview.mappingKey}>{overview.mappingDisplayName}</td>
                      <td className={`num${overview.addedCount ? ' tone-added' : ''}`}>{overview.addedCount}</td>
                      <td className={`num${overview.modifiedCount ? ' tone-modified' : ''}`}>
                        {overview.modifiedCount}
                      </td>
                      <td className={`num${overview.deletedCount ? ' tone-deleted' : ''}`}>{overview.deletedCount}</td>
                      <td className="num muted">{overview.unchangedCount}</td>
                      <td className={scanned ? undefined : 'muted'}>{formatTimestamp(overview.createdAt)}</td>
                      <td className="paths">
                        <span title={overview.sourceComponentRootPath ?? 'no source path'}>
                          {leafName(overview.sourceComponentRootPath)}
                        </span>
                        <span className="arrow">→</span>
                        <span title={overview.targetComponentRootPath ?? 'no target path'}>
                          {leafName(overview.targetComponentRootPath)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">
            {diffOverviews.length
              ? 'No component variants have drift. Clear the filter to see everything.'
              : repoMappings.length === 0
                ? 'Nothing scanned yet. Run a scan from Project Setup.'
                : hasPairedMappings
                  ? 'No diff data yet. Run Scan diffs.'
                  : 'Diffs compare a source repo against a release target, so they apply to paired repos only. This workspace has none.'}
          </p>
        )}
      </section>
    );
  }

  function renderReleaseSection() {
    return (
      <section className="panel release-panel">
        <div className="panel-header">
          <div>
            <h2>Release Copy</h2>
            <p>Copies a source component into its release target. Paired repos only.</p>
          </div>
        </div>

        <p className="note">
          Non-destructive: copies added and modified source files; target-only files are preserved; nothing is deleted.
          Preview first — applying is the only action that writes to the target repo.
        </p>

        <div className="release-controls">
          <label className="field">
            <span>Component Variant</span>
            <select
              value={releaseVariantId ?? ''}
              onChange={(event) => selectReleaseVariant(Number(event.target.value))}
              disabled={releasableVariants.length === 0 || releaseBusy || releaseApplying}
            >
              {releasableVariants.length === 0 ? <option value="">No paired variants available</option> : null}
              {releasableVariants.map((variant) => (
                <option key={variant.componentVariantId} value={variant.componentVariantId}>
                  {variant.componentDisplayName} — {variant.mappingDisplayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void runReleasePreview()}
            disabled={releaseBusy || releaseApplying || releaseVariantId === null}
          >
            {releaseBusy ? 'Previewing…' : 'Preview copy'}
          </button>
        </div>

        {releaseError ? <p className="error">{releaseError}</p> : null}

        {releasePreview?.summary ? (
          <div className="release-totals">
            <div className="stat">
              <strong>{releasePreview.summary.filesToCopyCount}</strong>
              <span>files to copy</span>
            </div>
            <div className="stat">
              <strong className="tone-added">{releasePreview.summary.addedCount}</strong>
              <span>added</span>
            </div>
            <div className="stat">
              <strong className="tone-modified">{releasePreview.summary.modifiedCount}</strong>
              <span>modified</span>
            </div>
            <div className="stat">
              <strong>{releasePreview.summary.targetOnlyPreservedCount}</strong>
              <span>target-only preserved</span>
            </div>
            <div className="stat">
              <strong className="muted">{releasePreview.summary.unchangedCount}</strong>
              <span>unchanged</span>
            </div>
            <div className="stat">
              <strong className="stat-time">{formatTimestamp(releasePreview.summary.scannedAt)}</strong>
              <span>previewed at</span>
            </div>
          </div>
        ) : null}

        {releasableVariants.length === 0 ? (
          <p className="empty">
            {repoMappings.length === 0
              ? 'Nothing scanned yet. Run a scan from Project Setup.'
              : 'Release copy moves files from a source repo into a release target, so it applies to paired repos only. This workspace has none.'}
          </p>
        ) : null}

        {releasePreview && !releasePreview.summary ? (
          <p className="empty">No copy preview available for this variant. Check the warnings or re-run a diff scan.</p>
        ) : null}

        {releasePreview?.warnings.length ? (
          <ul className="warnings">
            {releasePreview.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <strong>{warning.code}</strong>: {warning.message} {warning.path ? <code>{warning.path}</code> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {releasePreview && releasePreview.pendingOperationId !== null ? (
          <div className="danger-zone">
            <div className="danger-copy">
              <strong>Write to target repo</strong>
              <span>
                Copies {releasePreview.summary?.filesToCopyCount ?? 0} file
                {releasePreview.summary?.filesToCopyCount === 1 ? '' : 's'} into{' '}
                {variantById.get(releasePreview.componentVariantId)?.targetComponentRootPath ?? 'the target path'}. This
                cannot be undone from tBoard.
              </span>
            </div>
            <div className="danger-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={applyConfirmed}
                  onChange={(event) => setApplyConfirmed(event.target.checked)}
                  disabled={releaseApplying}
                />
                I understand
              </label>
              <button
                type="button"
                className="danger"
                onClick={() => void runReleaseApply()}
                disabled={!applyConfirmed || releaseApplying}
              >
                {releaseApplying ? 'Applying…' : 'Apply copy to target'}
              </button>
            </div>
          </div>
        ) : null}

        {releaseApply ? (
          <div className={`apply-result ${releaseApply.applied ? 'applied' : 'not-applied'}`}>
            <div className="scan-summary">
              <span className={releaseApply.applied ? 'tone-added' : 'tone-modified'}>
                {releaseApply.applied ? 'Applied' : 'Not applied'}
              </span>
              <span>{releaseApply.copiedCount} files copied</span>
              <span>operation #{releaseApply.pendingOperationId}</span>
            </div>
            {releaseApply.warnings.length ? (
              <ul className="warnings">
                {releaseApply.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    <strong>{warning.code}</strong>: {warning.message}{' '}
                    {warning.path ? <code>{warning.path}</code> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {releasableVariants.length > 0 && !releasePreview && !releaseApply && !releaseError ? (
          <p className="empty">Pick a component variant and run a preview to see what would be copied.</p>
        ) : null}
      </section>
    );
  }

  function renderCommandSection() {
    return (
      <section className="panel command-panel">
        <div className="panel-header">
          <div>
            <h2>Command Runner</h2>
            <p>Inspect git state, then preview and confirm a command before it runs in a repo.</p>
          </div>
        </div>

        <p className="note">
          Commands run without a shell. Enter the executable and its arguments separately — command <code>git</code>,
          args <code>status --porcelain</code>. No pipes, redirects, or globs.
        </p>

        <div className="command-controls">
          <label className="field">
            <span>Repo Mapping</span>
            <select
              value={commandMappingId ?? ''}
              onChange={(event) => selectCommandMapping(Number(event.target.value))}
              disabled={repoMappings.length === 0 || commandApplying}
            >
              {repoMappings.length === 0 ? <option value="">No repos — run a scan first</option> : null}
              {repoMappings.map((mapping) => (
                <option key={mapping.id} value={mapping.id}>
                  {mapping.displayName} ({mappingKindLabel(mapping.mappingKind)})
                </option>
              ))}
            </select>
          </label>
          <label className="field narrow">
            <span>Repo</span>
            <select
              value={commandRole}
              onChange={(event) => selectCommandRole(event.target.value as RepoRole)}
              disabled={commandApplying}
            >
              {commandRoles.map((role) => (
                <option key={role} value={role}>
                  {humanizeLabel(commandMapping?.mappingKind === 'single' ? 'primary' : role)}
                </option>
              ))}
            </select>
          </label>
          <label className="field narrow">
            <span>Kind</span>
            <select
              value={commandKind}
              onChange={(event) => {
                setCommandKind(event.target.value as CommandRunKind);
                resetCommandFlow();
              }}
              disabled={commandApplying}
            >
              {COMMAND_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {humanizeLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="field narrow">
            <span>Command</span>
            <input
              value={commandName}
              onChange={(event) => {
                setCommandName(event.target.value);
                resetCommandFlow();
              }}
              placeholder="git"
              spellCheck={false}
              disabled={commandApplying}
              aria-label="Executable"
            />
          </label>
          <label className="field grow">
            <span>Arguments (space separated)</span>
            <input
              value={commandArgs}
              onChange={(event) => {
                setCommandArgs(event.target.value);
                resetCommandFlow();
              }}
              placeholder="status --porcelain"
              spellCheck={false}
              disabled={commandApplying}
              aria-label="Arguments"
            />
          </label>
        </div>

        <div className="command-actions">
          <button
            type="button"
            onClick={() => void inspectGitStatus()}
            disabled={gitStatusBusy || commandMappingId === null}
          >
            {gitStatusBusy ? 'Inspecting…' : 'Inspect git status'}
          </button>
          <span className="read-only-hint">Read-only — runs no command, no confirmation needed.</span>
          <button
            type="button"
            className="primary"
            onClick={() => void runCommandPreview()}
            disabled={commandPreviewBusy || commandApplying || commandMappingId === null}
          >
            {commandPreviewBusy ? 'Previewing…' : 'Preview command'}
          </button>
        </div>

        {commandError ? <p className="error">{commandError}</p> : null}

        {gitStatus ? (
          <GitStatusView
            label={commandMapping?.mappingKind === 'single' ? 'repo status' : `${commandRole} repo status`}
            status={gitStatus}
          />
        ) : null}

        {commandPreview?.summary ? (
          <div className="command-preview">
            <div className="preview-line">
              <span className="preview-label">Will run</span>
              <code className="command-line">
                {commandPreview.summary.command}
                {commandPreview.summary.args.length ? ` ${commandPreview.summary.args.join(' ')}` : ''}
              </code>
            </div>
            <div className="preview-line">
              <span className="preview-label">In</span>
              <code>{commandPreview.summary.cwd}</code>
            </div>
            <div className="scan-summary">
              <span>{commandPreview.summary.kind}</span>
              <span>{commandPreview.summary.role} repo</span>
              <span>previewed {formatTimestamp(commandPreview.summary.previewedAt)}</span>
            </div>
            <GitStatusView label="Status before running" status={commandPreview.summary.beforeStatus} />
          </div>
        ) : null}

        {commandPreview && !commandPreview.summary ? (
          <p className="empty">No preview was recorded for this command. Check the warnings below.</p>
        ) : null}

        {commandPreview?.warnings.length ? (
          <ul className="warnings">
            {commandPreview.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <strong>{warning.code}</strong>: {warning.message} {warning.path ? <code>{warning.path}</code> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {commandPreview && commandPreview.pendingOperationId !== null ? (
          <div className="danger-zone">
            <div className="danger-copy">
              <strong>Run this command</strong>
              <span>
                Executes <code>{commandName.trim()}</code> in{' '}
                {commandPreview.summary?.cwd ??
                  (commandMapping?.mappingKind === 'single' ? 'the repo' : `the ${commandRole} repo`)}
                . tBoard records the run but cannot undo what the command does.
              </span>
            </div>
            <div className="danger-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={commandConfirmed}
                  onChange={(event) => setCommandConfirmed(event.target.checked)}
                  disabled={commandApplying}
                />
                I understand — this runs a real command
              </label>
              <button
                type="button"
                className="danger"
                onClick={() => void runCommandApply()}
                disabled={!commandConfirmed || commandApplying}
              >
                {commandApplying ? 'Running…' : 'Apply (run command)'}
              </button>
            </div>
          </div>
        ) : null}

        {commandApply ? (
          <div
            className={`apply-result ${commandApply.applied && commandApply.exitCode === 0 ? 'applied' : 'not-applied'}`}
          >
            <div className="scan-summary">
              <span className={commandApply.applied && commandApply.exitCode === 0 ? 'tone-added' : 'tone-deleted'}>
                {commandApply.applied
                  ? commandApply.exitCode === 0
                    ? 'Exited 0'
                    : `Exited ${commandApply.exitCode ?? 'unknown'}`
                  : 'Not applied'}
              </span>
              <span>{formatDuration(commandApply.durationMs)}</span>
              <span>operation #{commandApply.pendingOperationId}</span>
              {commandApply.commandRunId !== null ? <span>run #{commandApply.commandRunId}</span> : null}
              {commandApply.timedOut ? <span className="tone-deleted">timed out</span> : null}
              {commandApply.truncated ? <span className="tone-modified">output truncated</span> : null}
            </div>
            {commandApply.stdoutPath || commandApply.stderrPath ? (
              <div className="output-paths">
                {commandApply.stdoutPath ? (
                  <span>
                    stdout <code>{commandApply.stdoutPath}</code>
                  </span>
                ) : null}
                {commandApply.stderrPath ? (
                  <span>
                    stderr <code>{commandApply.stderrPath}</code>
                  </span>
                ) : null}
              </div>
            ) : null}
            {commandApply.commandRunId !== null ? (
              <div className="output-actions">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void viewRunOutput('apply', commandApply.commandRunId as number)}
                  aria-expanded={applyOutputOpen}
                >
                  {applyOutputOpen ? 'Hide output' : 'View output'}
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void revealRunOutput(commandApply.commandRunId as number)}
                >
                  Reveal in folder
                </button>
              </div>
            ) : null}
            {revealError && openOutput?.source !== 'history' ? <p className="error">{revealError}</p> : null}
            {applyOutputOpen ? (
              <CommandOutputView
                output={runOutput}
                busy={runOutputBusy}
                error={runOutputError}
                onCopy={(label, text) => void copyStreamText(label, text)}
                copiedStream={copiedStream}
                copyError={copyError}
              />
            ) : null}
            <StatusDelta before={commandApply.beforeStatus} after={commandApply.afterStatus} />
            {commandApply.warnings.length ? (
              <ul className="warnings">
                {commandApply.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    <strong>{warning.code}</strong>: {warning.message}{' '}
                    {warning.path ? <code>{warning.path}</code> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {!gitStatus && !commandPreview && !commandApply && !commandError ? (
          <p className="empty">Inspect git status to look around, or preview a command to see what would run.</p>
        ) : null}

        <div className="command-history">
          <div className="command-history-head">
            <h3>Run History</h3>
            {commandRuns.length ? (
              <div className="command-history-meta">
                <span className="muted">
                  Showing {commandRuns.length} of {runTotalCount} run{runTotalCount === 1 ? '' : 's'}
                </span>
                {!requestedAllRuns && runTotalCount > commandRuns.length ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void showAllRuns()}
                    disabled={runHistoryBusy}
                  >
                    {runHistoryBusy ? 'Loading…' : 'Show all'}
                  </button>
                ) : null}
                {requestedAllRuns && runTotalCount > commandRuns.length ? (
                  <span className="muted">Capped at {commandRuns.length}.</span>
                ) : null}
              </div>
            ) : null}
          </div>
          {commandRuns.length ? (
            <div className="table-scroll">
              <table className="runs-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Command</th>
                    <th className="num">Exit</th>
                    <th>Started</th>
                    <th>Working Dir</th>
                    <th>Triggered By</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {commandRuns.map((run) => {
                    const rowOpen = openOutput?.source === 'history' && openOutput.runId === run.id;
                    const hasOutput = Boolean(run.stdoutPath || run.stderrPath);
                    return (
                      <Fragment key={run.id}>
                        <tr className={rowOpen ? 'run-row open' : 'run-row'}>
                          <td>
                            <span className="run-kind">{humanizeLabel(run.kind)}</span>
                          </td>
                          <td className="paths" title={run.command}>
                            <code>{run.command}</code>
                          </td>
                          <td
                            className={`num ${run.exitCode === 0 ? 'tone-added' : run.exitCode === null ? 'muted' : 'tone-deleted'}`}
                          >
                            {run.exitCode ?? '—'}
                          </td>
                          <td>{formatTimestamp(run.startedAt)}</td>
                          <td className="paths muted" title={run.cwd}>
                            {leafName(run.cwd)}
                          </td>
                          <td className="muted">{humanizeLabel(run.triggeredBy)}</td>
                          <td className="run-output-cell">
                            {hasOutput ? (
                              <div className="output-actions">
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => void viewRunOutput('history', run.id)}
                                  aria-expanded={rowOpen}
                                >
                                  {rowOpen ? 'Hide' : 'View'}
                                </button>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => void revealRunOutput(run.id)}
                                >
                                  Reveal
                                </button>
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                        {rowOpen ? (
                          <tr className="run-output-row">
                            <td colSpan={7}>
                              {revealError ? <p className="error">{revealError}</p> : null}
                              <CommandOutputView
                                output={runOutput}
                                busy={runOutputBusy}
                                error={runOutputError}
                                onCopy={(label, text) => void copyStreamText(label, text)}
                                copiedStream={copiedStream}
                                copyError={copyError}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No commands have been run yet.</p>
          )}
          {revealError && !openOutput ? <p className="error">{revealError}</p> : null}
        </div>
      </section>
    );
  }

  function renderEvidenceSection() {
    return (
      <section className="panel evidence-panel">
        <div className="panel-header">
          <div>
            <h2>Evidence Library</h2>
            <p>Imported files are copied into the tBoard store and linked to a component variant.</p>
          </div>
          <div className="panel-actions">
            <label className="toggle">
              <input
                type="checkbox"
                checked={evidenceScopedToVariant}
                onChange={(event) => setEvidenceScopedToVariant(event.target.checked)}
                disabled={evidenceVariantId === null}
              />
              Selected variant only
            </label>
          </div>
        </div>

        <div className="evidence-controls">
          <label className="field">
            <span>Component Variant</span>
            <select
              value={evidenceVariantId ?? ''}
              onChange={(event) => setEvidenceVariantId(Number(event.target.value))}
              disabled={componentVariants.length === 0}
            >
              {componentVariants.length === 0 ? <option value="">No variants — run a scan first</option> : null}
              {componentVariants.map((variant) => (
                <option key={variant.componentVariantId} value={variant.componentVariantId}>
                  {variant.componentDisplayName} — {variant.mappingDisplayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Evidence Type</span>
            <select value={evidenceType} onChange={(event) => setEvidenceType(event.target.value as EvidenceType)}>
              {IMPORTABLE_EVIDENCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {humanizeLabel(type)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary"
            onClick={() => void importEvidence()}
            disabled={evidenceBusy || evidenceVariantId === null}
          >
            {evidenceBusy ? 'Importing…' : 'Import evidence'}
          </button>
        </div>

        {evidenceError ? <p className="error">{evidenceError}</p> : null}

        {evidenceImport ? (
          <div className="scan-summary">
            <span className={evidenceImport.imported.length ? 'tone-added' : undefined}>
              {evidenceImport.imported.length} file{evidenceImport.imported.length === 1 ? '' : 's'} imported
            </span>
            <span>{evidenceItems.length} in library</span>
            {evidenceImport.warnings.length ? (
              <span className="tone-modified">{evidenceImport.warnings.length} warnings</span>
            ) : null}
          </div>
        ) : null}

        {evidenceImport?.warnings.length ? (
          <ul className="warnings">
            {evidenceImport.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <strong>{warning.code}</strong>: {warning.message} {warning.path ? <code>{warning.path}</code> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {visibleEvidence.length ? (
          <div className="table-scroll">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Component</th>
                  <th>Mapping</th>
                  <th>Imported</th>
                  <th className="num">Size</th>
                  <th>Stored File</th>
                  <th>Original</th>
                </tr>
              </thead>
              <tbody>
                {visibleEvidence.map((item) => {
                  const variant = item.componentVariantId === null ? undefined : variantById.get(item.componentVariantId);
                  return (
                    <tr key={item.id}>
                      <td title={item.title}>
                        <strong>{item.title}</strong>
                        {item.hashSha256 ? (
                          <small className="muted">{item.hashSha256.slice(0, 12)}</small>
                        ) : null}
                      </td>
                      <td>
                        <span className={`evidence-type type-${item.type}`}>{humanizeLabel(item.type)}</span>
                      </td>
                      <td className={variant ? undefined : 'muted'}>{variant?.componentDisplayName ?? 'Unlinked'}</td>
                      <td className={variant ? undefined : 'muted'} title={variant?.mappingKey}>
                        {variant?.mappingDisplayName ?? '—'}
                      </td>
                      <td>{formatTimestamp(item.importedAt)}</td>
                      <td className="num muted">{formatBytes(item.sizeBytes)}</td>
                      <td className="paths" title={item.storedPath}>
                        {leafName(item.storedPath)}
                      </td>
                      <td className="paths muted" title={item.originalPath ?? 'no original path'}>
                        {leafName(item.originalPath)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">
            {evidenceItems.length
              ? 'No evidence for the selected variant. Clear the filter to see the whole library.'
              : 'No evidence yet. Pick a component variant and type, then import files.'}
          </p>
        )}
      </section>
    );
  }

  function renderBoardSection() {
    return (
      <section className="panel board-panel">
        <div className="panel-header">
          <div>
            <h2>Board</h2>
            <p>{cards.length} cards across {STATUSES.length} statuses.</p>
          </div>
        </div>

        <div className="card-composer">
          <label className="field grow">
            <span>Title</span>
            <input
              value={cardTitle}
              onChange={(event) => setCardTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createCard();
                }
              }}
              placeholder="What needs doing?"
              aria-label="Card title"
            />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={cardType} onChange={(event) => setCardType(event.target.value as CardType)}>
              {CARD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {humanizeLabel(type)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Priority</span>
            <select
              value={cardPriority}
              onChange={(event) => setCardPriority(event.target.value as CardPriority)}
            >
              {CARD_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {humanizeLabel(priority)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Severity</span>
            <select
              value={cardSeverity}
              onChange={(event) => setCardSeverity(event.target.value as CardSeverity)}
            >
              {CARD_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {humanizeLabel(severity)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Component Variant</span>
            <select
              value={cardVariantId ?? ''}
              onChange={(event) => setCardVariantId(event.target.value === '' ? null : Number(event.target.value))}
            >
              <option value="">None</option>
              {componentVariants.map((variant) => (
                <option key={variant.componentVariantId} value={variant.componentVariantId}>
                  {variant.componentDisplayName} — {variant.mappingDisplayName}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={() => void createCard()} disabled={cardBusy}>
            {cardBusy ? 'Creating…' : 'Create card'}
          </button>
        </div>

        {cardError ? <p className="error">{cardError}</p> : null}

        {cards.length === 0 && componentVariants.length === 0 ? (
          <p className="empty">
            Nothing scanned yet.{' '}
            <button type="button" className="link-button" onClick={() => setSetupOpen(true)}>
              Set up your project
            </button>{' '}
            to pick a workspace root and run a scan.
          </p>
        ) : null}

        <div className="kanban">
          {STATUSES.map((status) => {
            const columnCards = cardsByStatus.get(status) ?? [];
            return (
              <div className="column" key={status}>
                <h3>
                  {humanizeLabel(status)}
                  <span className="count">{columnCards.length}</span>
                </h3>
                {columnCards.map((card) => {
                  const linked = cardVariantLabel(card);
                  return (
                    <article
                      className={`card task-card type-${card.type}${selectedCardId === card.id ? ' is-open' : ''}`}
                      key={card.id}
                    >
                      <button type="button" className="card-open" onClick={() => openCardDetail(card)}>
                        {card.title}
                      </button>
                      {linked ? <span>{linked}</span> : null}
                      <div className="badges">
                        <small className={`card-type type-${card.type}`}>{humanizeLabel(card.type)}</small>
                        <small className={`priority-${card.priority}`}>{humanizeLabel(card.priority)}</small>
                        {card.severity !== 'none' ? (
                          <small className={`severity-${card.severity}`}>{humanizeLabel(card.severity)}</small>
                        ) : null}
                      </div>
                      <select
                        className="card-status"
                        value={card.status}
                        onChange={(event) => void moveCard(card.id, event.target.value as CardStatus)}
                        disabled={movingCardId === card.id}
                        aria-label={`Status for ${card.title}`}
                      >
                        {STATUSES.map((option) => (
                          <option key={option} value={option}>
                            {humanizeLabel(option)}
                          </option>
                        ))}
                      </select>
                    </article>
                  );
                })}
                {columnCards.length === 0 ? <p className="column-empty">—</p> : null}
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function renderInventoryVariants() {
    return showInventoryBoard ? (
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Inventory Variants</h2>
            <p>Scanned component variants by lifecycle status. Read-only — these are not board cards.</p>
          </div>
        </div>
        <div className="kanban">
          {STATUSES.map((status) => (
            <div className="column inventory-column" key={status}>
              <h3>
                {humanizeLabel(status)}
                <span className="count">{(variantsByStatus.get(status) ?? []).length}</span>
              </h3>
              {(variantsByStatus.get(status) ?? []).map((variant) => (
                <article className="card inventory-card" key={variant.componentVariantId}>
                  <strong>{variant.componentDisplayName}</strong>
                  <span>{variant.mappingDisplayName}</span>
                  <div className="badges">
                    <small className={variant.sourceExists ? 'ok' : 'missing'}>
                      {variant.mappingKind === 'single' ? 'repo' : 'source'}
                    </small>
                    {/* A single-repo variant has no target to be missing. */}
                    {variant.mappingKind === 'source_target' ? (
                      <small className={variant.targetExists ? 'ok' : 'missing'}>target</small>
                    ) : null}
                    {variant.openBugCount > 0 ? <small className="warn">{variant.openBugCount} bugs</small> : null}
                    {variant.evidenceCount > 0 ? <small>{variant.evidenceCount} evidence</small> : null}
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      </section>
    ) : null;
  }

  function renderInventorySection() {
    return (
      <>
        {renderInventoryTables()}
        <div className="rail-inline-actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={showInventoryBoard}
              onChange={(event) => setShowInventoryBoard(event.target.checked)}
            />
            Show variants by status
          </label>
          {projectConfigured ? (
            <button type="button" className="link-button" onClick={() => void runScan()} disabled={busy}>
              {busy ? 'Scanning…' : 'Rescan'}
            </button>
          ) : null}
        </div>
        {renderInventoryVariants()}
      </>
    );
  }

  return (
    <main className="app-shell">
      {renderHeader()}

      <div className="workspace-split">
        <div className="board-pane">{renderBoardSection()}</div>

        <aside className="rail">
          <div className="rail-tabs" role="tablist" aria-label="Workspace sections">
            {RAIL_TABS.map((tab) => (
              <button
                type="button"
                key={tab.id}
                id={`rail-tab-${tab.id}`}
                className={`rail-tab${activeTab === tab.id ? ' is-active' : ''}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`rail-panel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            className="rail-body"
            id={`rail-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`rail-tab-${activeTab}`}
          >
            {activeTab === 'inventory' ? renderInventorySection() : null}
            {activeTab === 'diffs' ? renderDiffSection() : null}
            {activeTab === 'release' ? renderReleaseSection() : null}
            {activeTab === 'commands' ? renderCommandSection() : null}
            {activeTab === 'evidence' ? renderEvidenceSection() : null}
          </div>
        </aside>
      </div>

      {setupOpen ? renderProjectSetup() : null}

      {selectedCard ? (
        <div className="drawer-overlay" role="presentation" onClick={() => closeCardDetail()}>
          <aside
            className="drawer"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Card ${selectedCard.id}: ${selectedCard.title}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <div className="badges">
                  <small className={`card-type type-${selectedCard.type}`}>{humanizeLabel(selectedCard.type)}</small>
                  <small>card {selectedCard.id}</small>
                </div>
                <h2>{selectedCard.title}</h2>
                <p>
                  {humanizeLabel(selectedCard.status)} · updated {formatTimestamp(selectedCard.updatedAt)}
                </p>
              </div>
              <button
                type="button"
                className="drawer-close"
                ref={drawerCloseRef}
                onClick={() => closeCardDetail()}
                aria-label="Close card detail"
              >
                ×
              </button>
            </div>

            <div className="drawer-body">
              <div className="drawer-section">
                <label className="field drawer-field">
                  <span>Title</span>
                  <input
                    value={detailTitle}
                    onChange={(event) => setDetailTitle(event.target.value)}
                    disabled={detailBusy}
                  />
                </label>

                <label className="field drawer-field">
                  <span>Description</span>
                  <textarea
                    value={detailDescription}
                    onChange={(event) => setDetailDescription(event.target.value)}
                    disabled={detailBusy}
                    rows={5}
                    placeholder="No description."
                  />
                </label>

                <div className="drawer-row">
                  <label className="field drawer-field">
                    <span>Status</span>
                    <select
                      value={selectedCard.status}
                      onChange={(event) => void moveCardDetail(event.target.value as CardStatus)}
                      disabled={detailBusy}
                    >
                      {STATUSES.map((option) => (
                        <option key={option} value={option}>
                          {humanizeLabel(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field drawer-field">
                    <span>Priority</span>
                    <select
                      value={detailPriority}
                      onChange={(event) => setDetailPriority(event.target.value as CardPriority)}
                      disabled={detailBusy}
                    >
                      {CARD_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {humanizeLabel(priority)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field drawer-field">
                    <span>Severity</span>
                    <select
                      value={detailSeverity}
                      onChange={(event) => setDetailSeverity(event.target.value as CardSeverity)}
                      disabled={detailBusy}
                    >
                      {CARD_SEVERITIES.map((severity) => (
                        <option key={severity} value={severity}>
                          {humanizeLabel(severity)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="field drawer-field">
                  <span>Component Variant</span>
                  <select
                    value={detailVariantId ?? ''}
                    onChange={(event) =>
                      setDetailVariantId(event.target.value === '' ? null : Number(event.target.value))
                    }
                    disabled={detailBusy}
                  >
                    <option value="">None</option>
                    {componentVariants.map((variant) => (
                      <option key={variant.componentVariantId} value={variant.componentVariantId}>
                        {variant.componentDisplayName} — {variant.mappingDisplayName}
                      </option>
                    ))}
                  </select>
                </label>

                {detailError ? <p className="error">{detailError}</p> : null}

                <div className="drawer-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveCardDetail()}
                    disabled={detailBusy || !detailDirty}
                  >
                    {detailBusy ? 'Saving…' : 'Save changes'}
                  </button>
                  <button type="button" onClick={() => resetCardDetail()} disabled={detailBusy || !detailDirty}>
                    Discard
                  </button>
                </div>
              </div>

              <div className="drawer-section">
                <h3>Details</h3>
                <dl className="drawer-meta">
                  <div>
                    <dt>Linked</dt>
                    <dd>{cardVariantLabel(selectedCard) ?? 'Not linked'}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{selectedCard.source}</dd>
                  </div>
                  <div>
                    <dt>Created by</dt>
                    <dd>{selectedCard.createdBy}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatTimestamp(selectedCard.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{formatTimestamp(selectedCard.updatedAt)}</dd>
                  </div>
                  {selectedCard.completedAt ? (
                    <div>
                      <dt>Completed</dt>
                      <dd>{formatTimestamp(selectedCard.completedAt)}</dd>
                    </div>
                  ) : null}
                  {selectedCard.releasedAt ? (
                    <div>
                      <dt>Released</dt>
                      <dd>{formatTimestamp(selectedCard.releasedAt)}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
