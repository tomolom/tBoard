import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { DiffService } from '../../src/main/services/diffService';
import { seedComponentVariant } from './dbFixtures';
import { createTempWorkspace } from './testFixtures';

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

describe('DiffService', () => {
  it('classifies added, deleted, modified, and unchanged files across source/target roots', async () => {
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
      await writeTextFile(path.join(targetRoot, 'only-in-target.txt'), 'old file');

      // Excluded directories should not contribute file changes.
      await writeTextFile(path.join(sourceRoot, '.git', 'HEAD'), 'ref: refs/heads/main');
      await writeTextFile(path.join(sourceRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
      await writeTextFile(path.join(sourceRoot, 'build', 'output.txt'), 'built artifact');
      await writeTextFile(path.join(sourceRoot, '_hidden', 'file.txt'), 'ignored');

      const { componentVariantId: variantId } = seedComponentVariant(db, {
        canonicalName: 'widget',
        sourceRootPath: sourceRoot,
        targetRootPath: targetRoot,
      });

      const diffService = new DiffService(db);
      const scanResult = await diffService.scanDiffs();

      expect(scanResult.componentVariantsScanned).toBe(1);
      expect(scanResult.diffSnapshotsCreated).toBe(1);
      expect(scanResult.addedFilesTotal).toBe(1);
      expect(scanResult.deletedFilesTotal).toBe(1);
      expect(scanResult.modifiedFilesTotal).toBe(1);
      expect(scanResult.warnings).toHaveLength(0);

      const overviews = diffService.listDiffOverviews();
      expect(overviews).toHaveLength(1);
      expect(overviews[0]).toMatchObject({
        componentVariantId: variantId,
        canonicalName: 'widget',
        addedCount: 1,
        deletedCount: 1,
        modifiedCount: 1,
        unchangedCount: 1,
      });

      const snapshotRow = db.prepare('SELECT file_changes_json FROM diff_snapshots WHERE component_variant_id = ?').get(variantId) as {
        file_changes_json: string;
      };
      const fileChanges = JSON.parse(snapshotRow.file_changes_json) as Array<{ path: string; status: string }>;
      const paths = fileChanges.map((change) => change.path);

      expect(paths).not.toContain('.git/HEAD');
      expect(paths).not.toContain('node_modules/pkg/index.js');
      expect(paths).not.toContain('build/output.txt');
      expect(paths).not.toContain('_hidden/file.txt');

      expect(fileChanges.find((change) => change.path === 'shared.txt')).toMatchObject({ status: 'unchanged' });
      expect(fileChanges.find((change) => change.path === 'changed.txt')).toMatchObject({ status: 'modified' });
      expect(fileChanges.find((change) => change.path === 'only-in-source.txt')).toMatchObject({ status: 'added' });
      expect(fileChanges.find((change) => change.path === 'only-in-target.txt')).toMatchObject({ status: 'deleted' });

      const variantRow = db.prepare('SELECT last_diff_snapshot_id FROM component_variants WHERE id = ?').get(variantId) as {
        last_diff_snapshot_id: number | null;
      };
      expect(variantRow.last_diff_snapshot_id).not.toBeNull();
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('produces warnings instead of crashing when source/target roots are missing', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const missingSourceRoot = path.join(workspace.root, 'does-not-exist-source');
      const missingTargetRoot = path.join(workspace.root, 'does-not-exist-target');

      seedComponentVariant(db, {
        canonicalName: 'ghost',
        sourceRootPath: missingSourceRoot,
        targetRootPath: missingTargetRoot,
      });

      const diffService = new DiffService(db);
      const scanResult = await diffService.scanDiffs();

      expect(scanResult.componentVariantsScanned).toBe(1);
      expect(scanResult.diffSnapshotsCreated).toBe(1);
      expect(scanResult.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'source_root_not_found', path: missingSourceRoot }),
          expect.objectContaining({ code: 'target_root_not_found', path: missingTargetRoot }),
        ]),
      );

      const overviews = diffService.listDiffOverviews();
      expect(overviews[0]).toMatchObject({ addedCount: 0, deletedCount: 0, modifiedCount: 0, unchangedCount: 0 });
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('reports a warning when the root path is null rather than throwing', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      seedComponentVariant(db, {
        canonicalName: 'no-target',
        sourceRootPath: null,
        targetRootPath: null,
      });

      const diffService = new DiffService(db);
      const scanResult = await diffService.scanDiffs();

      expect(scanResult.diffSnapshotsCreated).toBe(1);
      expect(scanResult.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'source_root_missing' }),
          expect.objectContaining({ code: 'target_root_missing' }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});
