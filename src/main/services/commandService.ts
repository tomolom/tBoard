import { open, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CommandApplyResult,
  CommandPreviewInput,
  CommandPreviewResult,
  CommandPreviewSummary,
  CommandRunDto,
  CommandRunKind,
  CommandRunListResult,
  CommandRunOutputDto,
  CommandRunOutputStream,
  GitStatusSnapshotDto,
  RepoRole,
  ScanWarning,
} from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';
import { isDirectory, pathExists } from './filesystem';
import { readGitStatus, type GitStatusSnapshot } from './gitStatus';
import { runProcess } from './processRunner';

/** Max bytes read back from a stored output file for in-app viewing. */
const OUTPUT_READ_CAP_BYTES = 1024 * 1024;

/** Hard cap on rows returned by a single listRuns call, even if a larger limit is requested. */
const MAX_RUN_LIST_LIMIT = 500;

const COMMAND_RUN_KINDS: CommandRunKind[] = ['git', 'build', 'test', 'lint', 'release', 'custom'];
const GIT_OPERATION_TYPES = ['status', 'diff', 'fetch', 'pull', 'checkout', 'copy_folder', 'commit', 'push', 'custom'] as const;
type GitOperationType = (typeof GIT_OPERATION_TYPES)[number];

function nowIso(): string {
  return new Date().toISOString();
}

function isRepoRole(value: unknown): value is RepoRole {
  return value === 'source' || value === 'target';
}

function isCommandRunKind(value: unknown): value is CommandRunKind {
  return typeof value === 'string' && (COMMAND_RUN_KINDS as string[]).includes(value);
}

type RepoMappingRow = {
  id: number;
  source_repo_path: string;
  target_repo_path: string;
};

type RepoRow = {
  id: number;
  path: string;
};

type CommandPayload = {
  repoMappingId: number;
  repoId: number | null;
  role: RepoRole;
  cwd: string;
  kind: CommandRunKind;
  command: string;
  args: string[];
  cardId: number | null;
  timeoutMs: number | null;
};

type PendingOperationRow = {
  id: number;
  kind: string;
  status: string;
  payload_json: string;
};

type CommandRunRow = {
  id: number;
  repo_id: number | null;
  repo_mapping_id: number | null;
  component_variant_id: number | null;
  card_id: number | null;
  kind: string;
  command: string;
  cwd: string;
  exit_code: number | null;
  stdout_path: string | null;
  stderr_path: string | null;
  started_at: string;
  finished_at: string | null;
  triggered_by: string;
};

function toSnapshotDto(
  snapshot: GitStatusSnapshot,
  repoMappingId: number | null,
  role: RepoRole | null,
  cwd: string | null,
): GitStatusSnapshotDto {
  return {
    repoMappingId,
    role,
    cwd,
    isRepo: snapshot.isRepo,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
    dirty: snapshot.dirty,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    entries: snapshot.entries,
    error: snapshot.error,
  };
}

function mapCommandRunRow(row: CommandRunRow): CommandRunDto {
  return {
    id: row.id,
    repoId: row.repo_id,
    repoMappingId: row.repo_mapping_id,
    componentVariantId: row.component_variant_id,
    cardId: row.card_id,
    kind: (isCommandRunKind(row.kind) ? row.kind : 'custom') as CommandRunKind,
    command: row.command,
    cwd: row.cwd,
    exitCode: row.exit_code,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    triggeredBy: row.triggered_by,
  };
}

/** Maps a git argv to a constrained git_operations.operation_type. */
function gitOperationType(args: string[]): GitOperationType {
  const first = args[0];
  if (first && (GIT_OPERATION_TYPES as readonly string[]).includes(first)) {
    return first as GitOperationType;
  }
  return 'custom';
}

/**
 * Runs and records local commands (git/build/test/lint/release/custom) against a
 * mapped repo, under strict safety controls (see PRD §10):
 *
 * - `gitStatus` is read-only and needs no confirmation.
 * - Every mutating command is a two-step preview → apply: `preview` records a
 *   pending_operations row (kind 'command') and runs nothing; `apply` executes
 *   only a still-pending operation after explicit confirmation.
 * - Commands execute via argv (never a shell), so nothing is shell-interpreted.
 * - Every executed command is logged to command_runs with captured stdout/stderr
 *   written to files, and git commands additionally record a git_operations row
 *   with before/after status. A failed/non-zero/timed-out run marks the pending
 *   operation 'failed', never 'applied'.
 */
export class CommandService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly commandOutputRoot: string,
  ) {}

  private getRepoMapping(repoMappingId: number): RepoMappingRow | undefined {
    return this.db
      .prepare('SELECT id, source_repo_path, target_repo_path FROM repo_mappings WHERE id = ?')
      .get(repoMappingId) as RepoMappingRow | undefined;
  }

  private getRepoRow(repoMappingId: number, role: RepoRole): RepoRow | undefined {
    return this.db
      .prepare('SELECT id, path FROM repos WHERE repo_mapping_id = ? AND role = ?')
      .get(repoMappingId, role) as RepoRow | undefined;
  }

  private resolveRepoPath(mapping: RepoMappingRow, role: RepoRole): string {
    return role === 'source' ? mapping.source_repo_path : mapping.target_repo_path;
  }

  async gitStatus(repoMappingId: number, role: RepoRole): Promise<GitStatusSnapshotDto> {
    if (!isRepoRole(role)) {
      return toSnapshotDto(
        { isRepo: false, branch: null, headSha: null, dirty: false, ahead: 0, behind: 0, entries: [], error: `Invalid repo role '${String(role)}'.` },
        repoMappingId,
        null,
        null,
      );
    }

    const mapping = this.getRepoMapping(repoMappingId);
    if (!mapping) {
      return toSnapshotDto(
        { isRepo: false, branch: null, headSha: null, dirty: false, ahead: 0, behind: 0, entries: [], error: `Repo mapping ${repoMappingId} was not found.` },
        repoMappingId,
        role,
        null,
      );
    }

    const cwd = this.resolveRepoPath(mapping, role);
    if (!(await isDirectory(cwd))) {
      return toSnapshotDto(
        { isRepo: false, branch: null, headSha: null, dirty: false, ahead: 0, behind: 0, entries: [], error: `Repo path does not exist: ${cwd}` },
        repoMappingId,
        role,
        cwd,
      );
    }

    const snapshot = await readGitStatus(cwd);
    return toSnapshotDto(snapshot, repoMappingId, role, cwd);
  }

  async preview(input: CommandPreviewInput): Promise<CommandPreviewResult> {
    const warnings: ScanWarning[] = [];

    if (!isRepoRole(input.role)) {
      return { pendingOperationId: null, summary: null, warnings: [{ code: 'invalid_role', message: `Invalid repo role '${String(input.role)}'.` }] };
    }
    if (!isCommandRunKind(input.kind)) {
      return { pendingOperationId: null, summary: null, warnings: [{ code: 'invalid_kind', message: `Invalid command kind '${String(input.kind)}'.` }] };
    }
    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return { pendingOperationId: null, summary: null, warnings: [{ code: 'empty_command', message: 'A non-empty command is required.' }] };
    }

    const mapping = this.getRepoMapping(input.repoMappingId);
    if (!mapping) {
      return { pendingOperationId: null, summary: null, warnings: [{ code: 'repo_mapping_not_found', message: `Repo mapping ${input.repoMappingId} was not found.` }] };
    }

    const cwd = this.resolveRepoPath(mapping, input.role);
    if (!(await isDirectory(cwd))) {
      return { pendingOperationId: null, summary: null, warnings: [{ code: 'repo_path_not_found', message: `Repo path does not exist: ${cwd}`, path: cwd }] };
    }

    const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
    const repoRow = this.getRepoRow(input.repoMappingId, input.role);

    const beforeStatus = toSnapshotDto(await readGitStatus(cwd), input.repoMappingId, input.role, cwd);

    const summary: CommandPreviewSummary = {
      repoMappingId: input.repoMappingId,
      role: input.role,
      cwd,
      kind: input.kind,
      command: input.command,
      args,
      beforeStatus,
      previewedAt: nowIso(),
    };

    const payload: CommandPayload = {
      repoMappingId: input.repoMappingId,
      repoId: repoRow?.id ?? null,
      role: input.role,
      cwd,
      kind: input.kind,
      command: input.command,
      args,
      cardId: input.cardId ?? null,
      timeoutMs: input.timeoutMs ?? null,
    };

    const commandDisplay = [input.command, ...args].join(' ');
    const insertResult = this.db
      .prepare(
        `INSERT INTO pending_operations (kind, status, requested_by, summary, payload_json, preview_json, requires_confirmation)
         VALUES ('command', 'pending', 'user', ?, ?, ?, 1)`,
      )
      .run(
        `Run ${input.kind} command '${commandDisplay}' in ${input.role} repo of mapping ${input.repoMappingId}.`,
        JSON.stringify(payload),
        JSON.stringify(summary),
      );

    return {
      pendingOperationId: Number(insertResult.lastInsertRowid),
      summary,
      warnings,
    };
  }

  async apply(pendingOperationId: number): Promise<CommandApplyResult> {
    const failure = (warnings: ScanWarning[]): CommandApplyResult => ({
      pendingOperationId,
      applied: false,
      commandRunId: null,
      exitCode: null,
      timedOut: false,
      truncated: false,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      beforeStatus: null,
      afterStatus: null,
      warnings,
    });

    const operation = this.db
      .prepare('SELECT id, kind, status, payload_json FROM pending_operations WHERE id = ?')
      .get(pendingOperationId) as PendingOperationRow | undefined;

    if (!operation) {
      return failure([{ code: 'pending_operation_not_found', message: `Pending operation ${pendingOperationId} was not found.` }]);
    }
    if (operation.kind !== 'command') {
      return failure([{ code: 'pending_operation_wrong_kind', message: `Pending operation ${pendingOperationId} has kind '${operation.kind}', expected 'command'.` }]);
    }
    if (operation.status !== 'pending' && operation.status !== 'confirmed') {
      return failure([{ code: 'pending_operation_invalid_status', message: `Pending operation ${pendingOperationId} has status '${operation.status}', which cannot be applied.` }]);
    }

    let payload: CommandPayload;
    try {
      payload = JSON.parse(operation.payload_json) as CommandPayload;
    } catch {
      return failure([{ code: 'pending_operation_payload_invalid', message: `Pending operation ${pendingOperationId} has an unparseable payload.` }]);
    }

    if (!(await isDirectory(payload.cwd))) {
      this.db.prepare("UPDATE pending_operations SET status = 'failed', applied_at = datetime('now') WHERE id = ?").run(pendingOperationId);
      return failure([{ code: 'repo_path_not_found', message: `Repo path does not exist: ${payload.cwd}`, path: payload.cwd }]);
    }

    const beforeStatus = toSnapshotDto(await readGitStatus(payload.cwd), payload.repoMappingId, payload.role, payload.cwd);

    // Record the command_run as started before executing.
    const commandDisplay = [payload.command, ...payload.args].join(' ');
    const insertRun = this.db
      .prepare(
        `INSERT INTO command_runs (repo_id, repo_mapping_id, card_id, kind, command, cwd, started_at, triggered_by)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'user')`,
      )
      .run(payload.repoId, payload.repoMappingId, payload.cardId, payload.kind, commandDisplay, payload.cwd);
    const commandRunId = Number(insertRun.lastInsertRowid);

    const runResult = await runProcess({
      command: payload.command,
      args: payload.args,
      cwd: payload.cwd,
      timeoutMs: payload.timeoutMs ?? undefined,
    });

    // Persist captured output to files (path in DB per schema principle §1).
    let stdoutPath: string | null = null;
    let stderrPath: string | null = null;
    const outputWarnings: ScanWarning[] = [];
    try {
      await mkdir(this.commandOutputRoot, { recursive: true });
      stdoutPath = path.join(this.commandOutputRoot, `run-${commandRunId}.stdout.txt`);
      stderrPath = path.join(this.commandOutputRoot, `run-${commandRunId}.stderr.txt`);
      await writeFile(stdoutPath, runResult.stdout, 'utf8');
      await writeFile(stderrPath, runResult.stderr, 'utf8');
    } catch (error) {
      stdoutPath = null;
      stderrPath = null;
      outputWarnings.push({
        code: 'output_capture_failed',
        message: `Failed to write command output files: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Finalize the command_run row.
    this.db
      .prepare("UPDATE command_runs SET exit_code = ?, stdout_path = ?, stderr_path = ?, finished_at = datetime('now') WHERE id = ?")
      .run(runResult.exitCode, stdoutPath, stderrPath, commandRunId);

    const afterStatus = toSnapshotDto(await readGitStatus(payload.cwd), payload.repoMappingId, payload.role, payload.cwd);

    // Record a git_operations row for git commands (before/after visibility).
    if (payload.kind === 'git') {
      this.db
        .prepare(
          `INSERT INTO git_operations (repo_id, command_run_id, operation_type, dry_run, confirmed_by_user, before_status_json, after_status_json, preview_json, result_json)
           VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?)`,
        )
        .run(
          payload.repoId,
          commandRunId,
          gitOperationType(payload.args),
          JSON.stringify(beforeStatus),
          JSON.stringify(afterStatus),
          JSON.stringify({ command: commandDisplay, cwd: payload.cwd }),
          JSON.stringify({ exitCode: runResult.exitCode, timedOut: runResult.timedOut, truncated: runResult.truncated }),
        );
    }

    const warnings: ScanWarning[] = [...outputWarnings];
    if (runResult.spawnError) {
      warnings.push({ code: 'command_spawn_failed', message: runResult.spawnErrorMessage ?? 'Failed to spawn command.' });
    }
    if (runResult.timedOut) {
      warnings.push({ code: 'command_timed_out', message: `Command timed out after ${runResult.durationMs}ms and was killed.` });
    }
    if (runResult.truncated) {
      warnings.push({ code: 'command_output_truncated', message: 'Captured command output was truncated at the buffer limit.' });
    }
    if (!runResult.spawnError && runResult.exitCode !== 0) {
      warnings.push({ code: 'command_nonzero_exit', message: `Command exited with code ${runResult.exitCode}.` });
    }

    const succeeded = !runResult.spawnError && !runResult.timedOut && runResult.exitCode === 0;
    const finalStatus = succeeded ? 'applied' : 'failed';
    this.db
      .prepare("UPDATE pending_operations SET status = ?, applied_at = datetime('now'), command_run_id = ? WHERE id = ?")
      .run(finalStatus, commandRunId, pendingOperationId);

    return {
      pendingOperationId,
      applied: succeeded,
      commandRunId,
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      truncated: runResult.truncated,
      stdoutPath,
      stderrPath,
      durationMs: runResult.durationMs,
      beforeStatus,
      afterStatus,
      warnings,
    };
  }

  /**
   * Lists recorded command runs, newest first. Pass a positive `limit` to bound
   * the number of rows (clamped to MAX_RUN_LIST_LIMIT); pass null/undefined for
   * all rows. Always returns the total count so callers can show "N of M" and a
   * load-more affordance.
   */
  listRuns(limit?: number | null): CommandRunListResult {
    const totalCount = (this.db.prepare('SELECT COUNT(*) AS c FROM command_runs').get() as { c: number }).c;

    let effectiveLimit: number | null = null;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      effectiveLimit = Math.min(Math.floor(limit), MAX_RUN_LIST_LIMIT);
    }

    const baseSql = `SELECT id, repo_id, repo_mapping_id, component_variant_id, card_id, kind, command, cwd, exit_code, stdout_path, stderr_path, started_at, finished_at, triggered_by
         FROM command_runs
         ORDER BY started_at DESC, id DESC`;

    const rows = (
      effectiveLimit === null
        ? this.db.prepare(baseSql).all()
        : this.db.prepare(`${baseSql} LIMIT ?`).all(effectiveLimit)
    ) as CommandRunRow[];

    return { runs: rows.map(mapCommandRunRow), totalCount, limit: effectiveLimit };
  }

  private async readOutputStream(filePath: string | null): Promise<CommandRunOutputStream> {
    if (!filePath) {
      return { path: null, text: '', truncated: false, missing: false, sizeBytes: null };
    }
    if (!(await pathExists(filePath))) {
      return { path: filePath, text: '', truncated: false, missing: true, sizeBytes: null };
    }

    let sizeBytes: number | null = null;
    try {
      sizeBytes = (await stat(filePath)).size;
    } catch {
      sizeBytes = null;
    }

    // Read at most OUTPUT_READ_CAP_BYTES so a runaway log can't blow up memory
    // or the IPC payload; flag truncation when the file is larger.
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(OUTPUT_READ_CAP_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, OUTPUT_READ_CAP_BYTES, 0);
      const truncated = sizeBytes !== null ? sizeBytes > bytesRead : bytesRead === OUTPUT_READ_CAP_BYTES;
      return {
        path: filePath,
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated,
        missing: false,
        sizeBytes,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads back the captured stdout/stderr for a recorded run, bounded to
   * OUTPUT_READ_CAP_BYTES per stream. Returns `found: false` if the run id is
   * unknown. A stored path whose file is gone is reported via `missing: true`
   * rather than throwing, so the UI can show a clear state.
   */
  async readRunOutput(runId: number): Promise<CommandRunOutputDto> {
    const row = this.db.prepare('SELECT stdout_path, stderr_path FROM command_runs WHERE id = ?').get(runId) as
      | { stdout_path: string | null; stderr_path: string | null }
      | undefined;

    if (!row) {
      return {
        runId,
        found: false,
        stdout: { path: null, text: '', truncated: false, missing: false, sizeBytes: null },
        stderr: { path: null, text: '', truncated: false, missing: false, sizeBytes: null },
      };
    }

    const [stdout, stderr] = await Promise.all([
      this.readOutputStream(row.stdout_path),
      this.readOutputStream(row.stderr_path),
    ]);
    return { runId, found: true, stdout, stderr };
  }

  /**
   * Resolves the directory containing a run's captured output so a caller (the
   * IPC layer) can open it in the OS file manager. Returns null when the run or
   * its output directory can't be resolved.
   */
  resolveRunOutputDir(runId: number): string | null {
    const row = this.db.prepare('SELECT stdout_path, stderr_path FROM command_runs WHERE id = ?').get(runId) as
      | { stdout_path: string | null; stderr_path: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    const anyPath = row.stdout_path ?? row.stderr_path;
    if (anyPath) {
      return path.dirname(anyPath);
    }
    // No per-run file path recorded; fall back to the shared output root.
    return this.commandOutputRoot;
  }
}
