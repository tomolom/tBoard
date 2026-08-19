import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { CommandService } from '../../src/main/services/commandService';
import { runProcess } from '../../src/main/services/processRunner';
import { seedRepoMapping } from './dbFixtures';
import { createTempWorkspace } from './testFixtures';

const NODE = process.execPath;

let gitAvailable = false;

async function initGitRepo(cwd: string): Promise<void> {
  await runProcess({ command: 'git', args: ['init'], cwd });
  await runProcess({ command: 'git', args: ['config', 'user.email', 'test@example.com'], cwd });
  await runProcess({ command: 'git', args: ['config', 'user.name', 'Test'], cwd });
}

beforeAll(async () => {
  const probe = await runProcess({ command: 'git', args: ['--version'], cwd: process.cwd(), timeoutMs: 10_000 });
  gitAvailable = !probe.spawnError && probe.exitCode === 0;
});

describe('CommandService.gitStatus', () => {
  it('returns a not-found error snapshot for an unknown repo mapping', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CommandService(db, '/tmp/tboard-cmd-out');
      const snapshot = await service.gitStatus(999, 'source');
      expect(snapshot.isRepo).toBe(false);
      expect(snapshot.error).toContain('was not found');
    } finally {
      db.close();
    }
  });

  it('reports a real repo status (branch, clean/dirty) read-only', async () => {
    if (!gitAvailable) {
      return;
    }
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const sourceRepo = path.join(workspace.root, 'src-repo');
      const targetRepo = path.join(workspace.root, 'tgt-repo');
      await mkdir(sourceRepo, { recursive: true });
      await mkdir(targetRepo, { recursive: true });
      await initGitRepo(sourceRepo);

      const { repoMappingId } = seedRepoMapping(db, {
        mappingKey: 'main',
        sourceRepoPath: sourceRepo,
        targetRepoPath: targetRepo,
        withRepoRows: true,
      });

      const clean = await service(db).gitStatus(repoMappingId, 'source');
      expect(clean.isRepo).toBe(true);
      expect(clean.dirty).toBe(false);

      await runProcess({ command: NODE, args: ['-e', "require('fs').writeFileSync('untracked.txt','x')"], cwd: sourceRepo });
      const dirty = await service(db).gitStatus(repoMappingId, 'source');
      expect(dirty.isRepo).toBe(true);
      expect(dirty.dirty).toBe(true);
      expect(dirty.entries.some((entry) => entry.path === 'untracked.txt')).toBe(true);
    } finally {
      db.close();
      await workspace.cleanup();
    }

    function service(db2: ReturnType<typeof createDatabase>): CommandService {
      return new CommandService(db2, path.join(workspace.root, 'cmd-out'));
    }
  });
});

describe('CommandService preview/apply', () => {
  it('preview records a pending command operation and runs nothing', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', 'process.exit(0)'],
      });

      expect(preview.warnings).toHaveLength(0);
      expect(preview.pendingOperationId).not.toBeNull();
      expect(preview.summary?.cwd).toBe(repoDir);

      const op = db
        .prepare('SELECT kind, status, requires_confirmation FROM pending_operations WHERE id = ?')
        .get(preview.pendingOperationId) as { kind: string; status: string; requires_confirmation: number };
      expect(op.kind).toBe('command');
      expect(op.status).toBe('pending');
      expect(op.requires_confirmation).toBe(1);

      // Nothing executed: no command_runs row yet.
      const runCount = (db.prepare('SELECT COUNT(*) AS c FROM command_runs').get() as { c: number }).c;
      expect(runCount).toBe(0);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('apply executes a successful command, captures output, logs the run, and marks the operation applied', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const outRoot = path.join(workspace.root, 'cmd-out');
      const service = new CommandService(db, outRoot);
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', "process.stdout.write('done-ok')"],
      });

      const result = await service.apply(preview.pendingOperationId as number);

      expect(result.applied).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.commandRunId).not.toBeNull();
      expect(result.warnings).toHaveLength(0);
      expect(result.stdoutPath).not.toBeNull();

      const stdout = await readFile(result.stdoutPath as string, 'utf8');
      expect(stdout).toBe('done-ok');

      const op = db.prepare('SELECT status, command_run_id FROM pending_operations WHERE id = ?').get(preview.pendingOperationId) as {
        status: string;
        command_run_id: number | null;
      };
      expect(op.status).toBe('applied');
      expect(op.command_run_id).toBe(result.commandRunId);

      const run = db.prepare('SELECT exit_code, finished_at, stdout_path FROM command_runs WHERE id = ?').get(result.commandRunId) as {
        exit_code: number;
        finished_at: string | null;
        stdout_path: string | null;
      };
      expect(run.exit_code).toBe(0);
      expect(run.finished_at).not.toBeNull();
      expect(run.stdout_path).not.toBeNull();
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('apply marks the operation failed (not applied) on a non-zero exit', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', "process.stderr.write('nope'); process.exit(2);"],
      });

      const result = await service.apply(preview.pendingOperationId as number);

      expect(result.applied).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.warnings.some((w) => w.code === 'command_nonzero_exit')).toBe(true);

      const op = db.prepare('SELECT status FROM pending_operations WHERE id = ?').get(preview.pendingOperationId) as { status: string };
      expect(op.status).toBe('failed');
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('apply rejects a non-existent pending operation without executing', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CommandService(db, '/tmp/tboard-cmd-out');
      const result = await service.apply(4242);
      expect(result.applied).toBe(false);
      expect(result.warnings.some((w) => w.code === 'pending_operation_not_found')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('apply refuses to re-run an already-applied operation', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', 'process.exit(0)'],
      });

      const first = await service.apply(preview.pendingOperationId as number);
      expect(first.applied).toBe(true);

      const second = await service.apply(preview.pendingOperationId as number);
      expect(second.applied).toBe(false);
      expect(second.warnings.some((w) => w.code === 'pending_operation_invalid_status')).toBe(true);

      // Only one run recorded.
      const runCount = (db.prepare('SELECT COUNT(*) AS c FROM command_runs').get() as { c: number }).c;
      expect(runCount).toBe(1);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('records a git_operations row with before/after status for a git command', async () => {
    if (!gitAvailable) {
      return;
    }
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      const targetDir = path.join(workspace.root, 'repo-target');
      await mkdir(repoDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await initGitRepo(repoDir);
      const { repoMappingId } = seedRepoMapping(db, {
        mappingKey: 'main',
        sourceRepoPath: repoDir,
        targetRepoPath: targetDir,
        withRepoRows: true,
      });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'git',
        command: 'git',
        args: ['status'],
      });

      const result = await service.apply(preview.pendingOperationId as number);
      expect(result.applied).toBe(true);
      expect(result.beforeStatus?.isRepo).toBe(true);
      expect(result.afterStatus?.isRepo).toBe(true);

      const gitOp = db
        .prepare('SELECT operation_type, dry_run, confirmed_by_user, command_run_id FROM git_operations WHERE command_run_id = ?')
        .get(result.commandRunId) as { operation_type: string; dry_run: number; confirmed_by_user: number; command_run_id: number };
      expect(gitOp.operation_type).toBe('status');
      expect(gitOp.dry_run).toBe(0);
      expect(gitOp.confirmed_by_user).toBe(1);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('readRunOutput reads back captured stdout/stderr for a recorded run', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', "process.stdout.write('hello out'); process.stderr.write('hello err');"],
      });
      const applied = await service.apply(preview.pendingOperationId as number);

      const output = await service.readRunOutput(applied.commandRunId as number);
      expect(output.found).toBe(true);
      expect(output.stdout.text).toBe('hello out');
      expect(output.stderr.text).toBe('hello err');
      expect(output.stdout.missing).toBe(false);
      expect(output.stdout.truncated).toBe(false);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('readRunOutput reports found=false for an unknown run id', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CommandService(db, '/tmp/tboard-cmd-out');
      const output = await service.readRunOutput(9999);
      expect(output.found).toBe(false);
      expect(output.stdout.text).toBe('');
    } finally {
      db.close();
    }
  });

  it('readRunOutput flags missing when the stored output file is gone', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', "process.stdout.write('gone soon')"],
      });
      const applied = await service.apply(preview.pendingOperationId as number);

      // Remove the whole output directory to simulate a lost file.
      await rm(path.join(workspace.root, 'cmd-out'), { recursive: true, force: true });

      const output = await service.readRunOutput(applied.commandRunId as number);
      expect(output.found).toBe(true);
      expect(output.stdout.missing).toBe(true);
      expect(output.stdout.text).toBe('');
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('resolveRunOutputDir returns the directory containing a run\'s output', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const outRoot = path.join(workspace.root, 'cmd-out');
      const service = new CommandService(db, outRoot);
      const preview = await service.preview({
        repoMappingId,
        role: 'source',
        kind: 'custom',
        command: NODE,
        args: ['-e', 'process.exit(0)'],
      });
      const applied = await service.apply(preview.pendingOperationId as number);

      expect(service.resolveRunOutputDir(applied.commandRunId as number)).toBe(outRoot);
      expect(service.resolveRunOutputDir(9999)).toBeNull();
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('listRuns returns recorded runs newest first with total count', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      for (let i = 0; i < 2; i += 1) {
        const preview = await service.preview({
          repoMappingId,
          role: 'source',
          kind: 'custom',
          command: NODE,
          args: ['-e', `process.stdout.write('run-${i}')`],
        });
        await service.apply(preview.pendingOperationId as number);
      }

      const result = service.listRuns();
      expect(result.runs.length).toBe(2);
      expect(result.totalCount).toBe(2);
      expect(result.limit).toBeNull();
      expect(result.runs[0].startedAt >= result.runs[1].startedAt).toBe(true);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('listRuns bounds rows to a positive limit while reporting the true total', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const repoDir = path.join(workspace.root, 'repo');
      await mkdir(repoDir, { recursive: true });
      const { repoMappingId } = seedRepoMapping(db, { mappingKey: 'main', sourceRepoPath: repoDir, targetRepoPath: repoDir });

      const service = new CommandService(db, path.join(workspace.root, 'cmd-out'));
      for (let i = 0; i < 3; i += 1) {
        const preview = await service.preview({
          repoMappingId,
          role: 'source',
          kind: 'custom',
          command: NODE,
          args: ['-e', `process.stdout.write('run-${i}')`],
        });
        await service.apply(preview.pendingOperationId as number);
      }

      const limited = service.listRuns(2);
      expect(limited.runs.length).toBe(2);
      expect(limited.totalCount).toBe(3);
      expect(limited.limit).toBe(2);

      // A non-positive limit is treated as "no limit".
      const unlimited = service.listRuns(0);
      expect(unlimited.runs.length).toBe(3);
      expect(unlimited.limit).toBeNull();
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });
});
