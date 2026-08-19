import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { ReleaseCopyService } from '../../src/main/services/releaseCopyService';
import { seedComponentVariant } from './dbFixtures';
import { createTempWorkspace } from './testFixtures';

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

describe('ReleaseCopyService', () => {
  it('previewCopy identifies added/modified/target-only-preserved files and creates a pending operation', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const sourceRoot = path.join(workspace.root, 'source-comp');
      const targetRoot = path.join(workspace.root, 'target-comp');

      await writeTextFile(path.join(sourceRoot, 'shared.txt'), 'same content');
      await writeTextFile(path.join(targetRoot, 'shared.txt'), 'same content');

      await writeTextFile(path.join(sourceRoot, 'changed.txt'), 'source version');
      await writeTextFile(path.join(targetRoot, 'changed.txt'), 'target version');

      await writeTextFile(path.join(sourceRoot, 'only-in-source.txt'), 'new file');
      await writeTextFile(path.join(targetRoot, 'only-in-target.txt'), 'target only file');

      const { componentVariantId: variantId } = seedComponentVariant(db, { canonicalName: 'widget', sourceRootPath: sourceRoot, targetRootPath: targetRoot });

      const service = new ReleaseCopyService(db);
      const preview = await service.previewCopy(variantId);

      expect(preview.warnings).toHaveLength(0);
      expect(preview.pendingOperationId).not.toBeNull();
      expect(preview.summary).toMatchObject({
        filesToCopyCount: 2,
        addedCount: 1,
        modifiedCount: 1,
        targetOnlyPreservedCount: 1,
        unchangedCount: 1,
      });

      const operationRow = db
        .prepare('SELECT kind, status, requires_confirmation, payload_json, preview_json FROM pending_operations WHERE id = ?')
        .get(preview.pendingOperationId) as {
        kind: string;
        status: string;
        requires_confirmation: number;
        payload_json: string;
        preview_json: string;
      };

      expect(operationRow.kind).toBe('copy_folder');
      expect(operationRow.status).toBe('pending');
      expect(operationRow.requires_confirmation).toBe(1);

      const payload = JSON.parse(operationRow.payload_json) as {
        componentVariantId: number;
        sourceRoot: string;
        targetRoot: string;
        filesToCopy: Array<{ path: string; status: string }>;
        targetOnlyPreserved: string[];
      };
      expect(payload.componentVariantId).toBe(variantId);
      expect(payload.sourceRoot).toBe(sourceRoot);
      expect(payload.targetRoot).toBe(targetRoot);
      expect(payload.filesToCopy.find((f) => f.path === 'only-in-source.txt')).toMatchObject({ status: 'added' });
      expect(payload.filesToCopy.find((f) => f.path === 'changed.txt')).toMatchObject({ status: 'modified' });
      expect(payload.targetOnlyPreserved).toEqual(['only-in-target.txt']);

      const previewJson = JSON.parse(operationRow.preview_json) as { summary: { filesToCopyCount: number } };
      expect(previewJson.summary.filesToCopyCount).toBe(2);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('applyCopy copies added/modified files, overwrites changed target files, and preserves target-only files', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const sourceRoot = path.join(workspace.root, 'source-comp');
      const targetRoot = path.join(workspace.root, 'target-comp');

      await writeTextFile(path.join(sourceRoot, 'shared.txt'), 'same content');
      await writeTextFile(path.join(targetRoot, 'shared.txt'), 'same content');

      await writeTextFile(path.join(sourceRoot, 'changed.txt'), 'source version');
      await writeTextFile(path.join(targetRoot, 'changed.txt'), 'target version');

      await writeTextFile(path.join(sourceRoot, 'new', 'nested', 'only-in-source.txt'), 'new nested file');
      await writeTextFile(path.join(targetRoot, 'only-in-target.txt'), 'target only file');

      const { componentVariantId: variantId } = seedComponentVariant(db, { canonicalName: 'widget', sourceRootPath: sourceRoot, targetRootPath: targetRoot });

      const service = new ReleaseCopyService(db);
      const preview = await service.previewCopy(variantId);
      expect(preview.pendingOperationId).not.toBeNull();

      const applyResult = await service.applyCopy(preview.pendingOperationId!);

      expect(applyResult.applied).toBe(true);
      expect(applyResult.warnings).toHaveLength(0);
      expect(applyResult.copiedCount).toBe(2);

      const changedContents = await readFile(path.join(targetRoot, 'changed.txt'), 'utf8');
      expect(changedContents).toBe('source version');

      const newFileContents = await readFile(path.join(targetRoot, 'new', 'nested', 'only-in-source.txt'), 'utf8');
      expect(newFileContents).toBe('new nested file');

      const preservedContents = await readFile(path.join(targetRoot, 'only-in-target.txt'), 'utf8');
      expect(preservedContents).toBe('target only file');

      const unchangedContents = await readFile(path.join(targetRoot, 'shared.txt'), 'utf8');
      expect(unchangedContents).toBe('same content');

      const operationRow = db.prepare('SELECT status, applied_at FROM pending_operations WHERE id = ?').get(preview.pendingOperationId) as {
        status: string;
        applied_at: string | null;
      };
      expect(operationRow.status).toBe('applied');
      expect(operationRow.applied_at).not.toBeNull();
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('previewCopy warns and creates no pending operation when source or target roots are missing', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const missingSourceRoot = path.join(workspace.root, 'does-not-exist-source');
      const missingTargetRoot = path.join(workspace.root, 'does-not-exist-target');

      const { componentVariantId: variantId } = seedComponentVariant(db, {
        canonicalName: 'ghost',
        sourceRootPath: missingSourceRoot,
        targetRootPath: missingTargetRoot,
      });

      const service = new ReleaseCopyService(db);
      const preview = await service.previewCopy(variantId);

      expect(preview.pendingOperationId).toBeNull();
      expect(preview.summary).toBeNull();
      expect(preview.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'source_root_not_found', path: missingSourceRoot }),
          expect.objectContaining({ code: 'target_root_not_found', path: missingTargetRoot }),
        ]),
      );

      const countRow = db.prepare('SELECT COUNT(*) AS count FROM pending_operations').get() as { count: number };
      expect(countRow.count).toBe(0);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('previewCopy warns without crashing for an unknown component variant', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new ReleaseCopyService(db);
      const preview = await service.previewCopy(9999);

      expect(preview.pendingOperationId).toBeNull();
      expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'component_variant_not_found' })]));
    } finally {
      db.close();
    }
  });

  it('applyCopy warns and does not copy for an unknown pending operation id', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new ReleaseCopyService(db);
      const applyResult = await service.applyCopy(9999);

      expect(applyResult.applied).toBe(false);
      expect(applyResult.copiedCount).toBe(0);
      expect(applyResult.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pending_operation_not_found' })]));
    } finally {
      db.close();
    }
  });

  it('applyCopy warns and does not copy for a pending operation with the wrong kind', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const insertResult = db
        .prepare(
          `INSERT INTO pending_operations (kind, status, requested_by, summary, payload_json, preview_json, requires_confirmation)
           VALUES ('delete_file', 'pending', 'user', 'unrelated operation', '{}', '{}', 1)`,
        )
        .run();
      const pendingOperationId = Number(insertResult.lastInsertRowid);

      const service = new ReleaseCopyService(db);
      const applyResult = await service.applyCopy(pendingOperationId);

      expect(applyResult.applied).toBe(false);
      expect(applyResult.copiedCount).toBe(0);
      expect(applyResult.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pending_operation_wrong_kind' })]));
    } finally {
      db.close();
    }
  });

  it('applyCopy warns and does not copy for a pending operation with an invalid status', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const sourceRoot = path.join(workspace.root, 'source-comp');
      const targetRoot = path.join(workspace.root, 'target-comp');
      await writeTextFile(path.join(sourceRoot, 'file.txt'), 'content');
      await mkdir(targetRoot, { recursive: true });

      const { componentVariantId: variantId } = seedComponentVariant(db, { canonicalName: 'widget', sourceRootPath: sourceRoot, targetRootPath: targetRoot });

      const service = new ReleaseCopyService(db);
      const preview = await service.previewCopy(variantId);
      expect(preview.pendingOperationId).not.toBeNull();

      db.prepare("UPDATE pending_operations SET status = 'rejected' WHERE id = ?").run(preview.pendingOperationId);

      const applyResult = await service.applyCopy(preview.pendingOperationId!);

      expect(applyResult.applied).toBe(false);
      expect(applyResult.copiedCount).toBe(0);
      expect(applyResult.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pending_operation_invalid_status' })]));

      const targetFileExists = await readFile(path.join(targetRoot, 'file.txt'), 'utf8').catch(() => null);
      expect(targetFileExists).toBeNull();
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('marks the pending operation failed when a previewed source file disappears before apply', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const sourceRoot = path.join(workspace.root, 'source-comp');
      const targetRoot = path.join(workspace.root, 'target-comp');
      const sourceFile = path.join(sourceRoot, 'file.txt');
      await writeTextFile(sourceFile, 'content');
      await mkdir(targetRoot, { recursive: true });

      const { componentVariantId: variantId } = seedComponentVariant(db, { canonicalName: 'vanishing', sourceRootPath: sourceRoot, targetRootPath: targetRoot });
      const service = new ReleaseCopyService(db);
      const preview = await service.previewCopy(variantId);
      expect(preview.pendingOperationId).not.toBeNull();

      await rm(sourceFile);
      const applyResult = await service.applyCopy(preview.pendingOperationId!);

      expect(applyResult.applied).toBe(false);
      expect(applyResult.copiedCount).toBe(0);
      expect(applyResult.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'copy_failed' })]));

      const operationRow = db.prepare('SELECT status FROM pending_operations WHERE id = ?').get(preview.pendingOperationId) as {
        status: string;
      };
      expect(operationRow.status).toBe('failed');
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });
});
