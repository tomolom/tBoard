import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import type { SqliteDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { EvidenceService } from '../../src/main/services/evidenceService';
import { createTempWorkspace } from './testFixtures';

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

function seedComponentVariant(
  db: SqliteDatabase,
  options: { mappingKey: string; canonicalName: string },
): { componentId: number; componentVariantId: number } {
  db.prepare(
    `INSERT INTO repo_mappings (mapping_key, display_name, source_repo_path, target_repo_path, mapping_source, enabled)
     VALUES (?, ?, ?, ?, 'manual', 1)`,
  ).run(options.mappingKey, options.mappingKey, '/tmp/source-repo', '/tmp/target-repo');
  const repoMappingId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  db.prepare(`INSERT INTO components (canonical_name, display_name) VALUES (?, ?)`).run(options.canonicalName, options.canonicalName);
  const componentId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  db.prepare(
    `INSERT INTO component_variants (component_id, repo_mapping_id, source_exists, target_exists)
     VALUES (?, ?, 1, 1)`,
  ).run(componentId, repoMappingId);
  const componentVariantId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  return { componentId, componentVariantId };
}

describe('EvidenceService', () => {
  it('copies files into the evidence root, hashes them, and records DB rows', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentId, componentVariantId } = seedComponentVariant(db, { mappingKey: 'main', canonicalName: 'gauntlet' });

      const evidenceRoot = path.join(workspace.root, 'evidence-root');
      const sourceFile = path.join(workspace.root, 'sources', 'screenshot.png');
      await writeTextFile(sourceFile, 'fake png bytes');

      const service = new EvidenceService(db, evidenceRoot);
      const result = await service.importFiles(componentVariantId, 'screenshot', [sourceFile]);

      expect(result.warnings).toHaveLength(0);
      expect(result.imported).toHaveLength(1);

      const imported = result.imported[0];
      expect(imported.componentId).toBe(componentId);
      expect(imported.componentVariantId).toBe(componentVariantId);
      expect(imported.type).toBe('screenshot');
      expect(imported.originalPath).toBe(sourceFile);
      expect(imported.sizeBytes).toBe(Buffer.byteLength('fake png bytes'));
      expect(imported.hashSha256).toHaveLength(64);
      expect(imported.createdBy).toBe('user');

      const expectedDir = path.join(evidenceRoot, 'main', 'gauntlet', `variant-${componentVariantId}`, 'screenshot');
      expect(imported.storedPath.startsWith(expectedDir)).toBe(true);
      expect(imported.storedPath.endsWith('screenshot.png')).toBe(true);

      const storedContents = await readFile(imported.storedPath, 'utf8');
      expect(storedContents).toBe('fake png bytes');

      const variantRow = db.prepare('SELECT latest_evidence_id FROM component_variants WHERE id = ?').get(componentVariantId) as {
        latest_evidence_id: number | null;
      };
      expect(variantRow.latest_evidence_id).toBe(imported.id);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('produces unique stored filenames on collision without overwriting existing evidence', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentVariantId } = seedComponentVariant(db, { mappingKey: 'ferox', canonicalName: 'widget' });

      const evidenceRoot = path.join(workspace.root, 'evidence-root');
      const firstSource = path.join(workspace.root, 'sources', 'note.log');
      const secondSource = path.join(workspace.root, 'sources-2', 'note.log');
      await writeTextFile(firstSource, 'first content');
      await writeTextFile(secondSource, 'second content');

      const service = new EvidenceService(db, evidenceRoot);
      const firstResult = await service.importFiles(componentVariantId, 'log', [firstSource]);
      const secondResult = await service.importFiles(componentVariantId, 'log', [secondSource]);

      expect(firstResult.imported).toHaveLength(1);
      expect(secondResult.imported).toHaveLength(1);

      const firstStoredPath = firstResult.imported[0].storedPath;
      const secondStoredPath = secondResult.imported[0].storedPath;

      expect(firstStoredPath).not.toBe(secondStoredPath);
      expect(path.basename(firstStoredPath)).toBe('note.log');
      expect(path.basename(secondStoredPath)).toBe('note-1.log');

      const firstContents = await readFile(firstStoredPath, 'utf8');
      const secondContents = await readFile(secondStoredPath, 'utf8');
      expect(firstContents).toBe('first content');
      expect(secondContents).toBe('second content');
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('sanitizes unsafe filenames while preserving extensions', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentVariantId } = seedComponentVariant(db, { mappingKey: 'orion', canonicalName: 'thing' });

      const evidenceRoot = path.join(workspace.root, 'evidence-root');
      const unsafeSource = path.join(workspace.root, 'sources', 'weird name (final)!!.txt');
      await writeTextFile(unsafeSource, 'contents');

      const service = new EvidenceService(db, evidenceRoot);
      const result = await service.importFiles(componentVariantId, 'other', [unsafeSource]);

      expect(result.imported).toHaveLength(1);
      const storedFilename = path.basename(result.imported[0].storedPath);
      expect(storedFilename).toMatch(/^[A-Za-z0-9._-]+$/u);
      expect(storedFilename.endsWith('.txt')).toBe(true);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('lists evidence overall and scoped to a specific component variant', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const first = seedComponentVariant(db, { mappingKey: 'main', canonicalName: 'alpha' });
      const second = seedComponentVariant(db, { mappingKey: 'ferox', canonicalName: 'beta' });

      const evidenceRoot = path.join(workspace.root, 'evidence-root');
      const sourceA = path.join(workspace.root, 'sources', 'a.log');
      const sourceB = path.join(workspace.root, 'sources', 'b.log');
      await writeTextFile(sourceA, 'a contents');
      await writeTextFile(sourceB, 'b contents');

      const service = new EvidenceService(db, evidenceRoot);
      await service.importFiles(first.componentVariantId, 'log', [sourceA]);
      await service.importFiles(second.componentVariantId, 'log', [sourceB]);

      const allEvidence = service.listEvidence();
      expect(allEvidence).toHaveLength(2);

      const firstOnly = service.listEvidenceForVariant(first.componentVariantId);
      expect(firstOnly).toHaveLength(1);
      expect(firstOnly[0].componentVariantId).toBe(first.componentVariantId);
      expect(firstOnly[0].originalPath).toBe(sourceA);
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });

  it('warns instead of crashing when the component variant or source file is missing', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentVariantId } = seedComponentVariant(db, { mappingKey: 'main', canonicalName: 'gamma' });
      const evidenceRoot = path.join(workspace.root, 'evidence-root');
      const service = new EvidenceService(db, evidenceRoot);

      const missingVariantResult = await service.importFiles(9999, 'log', [path.join(workspace.root, 'nope.log')]);
      expect(missingVariantResult.imported).toHaveLength(0);
      expect(missingVariantResult.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'component_variant_not_found' })]),
      );

      const missingSourceResult = await service.importFiles(componentVariantId, 'log', [path.join(workspace.root, 'does-not-exist.log')]);
      expect(missingSourceResult.imported).toHaveLength(0);
      expect(missingSourceResult.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'evidence_source_missing' })]),
      );
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });
});
