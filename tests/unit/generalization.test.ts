import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/main/db/migrations';
import { createDatabase } from '../../src/main/db/sqlite';
import { detectProfile, genericProfile, roeProfile } from '../../src/main/profiles';
import { DiffService } from '../../src/main/services/diffService';
import { InventoryService } from '../../src/main/services/inventoryService';
import { ReleaseCopyService } from '../../src/main/services/releaseCopyService';
import { SettingsService } from '../../src/main/services/settingsService';
import { createGitRepo, createRoePlugin, createTempWorkspace } from './testFixtures';

function freshDb() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('generic profile discovery', () => {
  it('treats each git-repo subdirectory as a single-repo project (no target)', async () => {
    const ws = await createTempWorkspace();
    try {
      await createGitRepo(ws.root, 'my-app');
      await createGitRepo(ws.root, 'some-lib');
      // A non-git directory is ignored.
      await createGitRepo(ws.root, 'ignored-plain').then(() => undefined);

      const scan = await genericProfile.scanRepoMappings(ws.root);
      const keys = scan.mappings.map((m) => m.mappingKey).sort();
      expect(keys).toContain('my-app');
      expect(keys).toContain('some-lib');
      for (const mapping of scan.mappings) {
        expect(mapping.mappingKind).toBe('single');
        expect(mapping.targetRepoPath).toBeNull();
        expect(mapping.targetExists).toBe(false);
        expect(mapping.sourceExists).toBe(true);
      }
      expect(scan.warnings).toHaveLength(0);
    } finally {
      await ws.cleanup();
    }
  });

  it('discovers the repo itself as its one component', async () => {
    const ws = await createTempWorkspace();
    try {
      const repoPath = await createGitRepo(ws.root, 'my-app');
      const components = await genericProfile.scanComponents(repoPath, { role: 'source', mappingKey: 'my-app' });
      expect(components.components).toHaveLength(1);
      expect(components.components[0].rootPath).toBe(repoPath);
      // A single mapping has no target repo to scan.
      const targetScan = await genericProfile.scanComponents(repoPath, { role: 'target', mappingKey: 'my-app' });
      expect(targetScan.components).toHaveLength(0);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('profile auto-detection', () => {
  it('picks Roe when a known Roe repo exists, else generic', async () => {
    const roeWs = await createTempWorkspace();
    const genWs = await createTempWorkspace();
    try {
      await createGitRepo(roeWs.root, 'Roe-apiv3');
      expect((await detectProfile(roeWs.root)).id).toBe(roeProfile.id);

      await createGitRepo(genWs.root, 'random-project');
      expect((await detectProfile(genWs.root)).id).toBe(genericProfile.id);
    } finally {
      await roeWs.cleanup();
      await genWs.cleanup();
    }
  });
});

describe('generic project end-to-end inventory', () => {
  it('scans a non-Roe workspace into single-repo mappings and variants', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      await createGitRepo(ws.root, 'alpha');
      await createGitRepo(ws.root, 'beta');

      const inventory = new InventoryService(db);
      const result = await inventory.scanWorkspace(ws.root);

      expect(result.repoMappingsFound).toBe(2);
      expect(result.componentVariantsFound).toBe(2);

      const mappings = inventory.listRepoMappings();
      expect(mappings).toHaveLength(2);
      for (const mapping of mappings) {
        expect(mapping.mappingKind).toBe('single');
        expect(mapping.targetRepoPath).toBeNull();
      }

      const variants = inventory.listComponentVariants();
      expect(variants).toHaveLength(2);
      for (const variant of variants) {
        expect(variant.mappingKind).toBe('single');
        expect(variant.sourceExists).toBe(true);
        expect(variant.targetExists).toBe(false);
      }
    } finally {
      db.close();
      await ws.cleanup();
    }
  });
});

describe('diff and release are not applicable for single-repo projects', () => {
  it('diff scan skips single mappings (no snapshots, no target warnings)', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      await createGitRepo(ws.root, 'solo');
      const inventory = new InventoryService(db);
      await inventory.scanWorkspace(ws.root);

      const diff = new DiffService(db);
      const result = await diff.scanDiffs();
      expect(result.componentVariantsScanned).toBe(0);
      expect(result.diffSnapshotsCreated).toBe(0);
      expect(result.warnings).toHaveLength(0);
      // And the single variant is not surfaced in the diff overview.
      expect(diff.listDiffOverviews()).toHaveLength(0);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  it('release preview returns release_not_applicable for a single mapping', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      await createGitRepo(ws.root, 'solo');
      const inventory = new InventoryService(db);
      await inventory.scanWorkspace(ws.root);
      const variant = inventory.listComponentVariants()[0];

      const release = new ReleaseCopyService(db);
      const preview = await release.previewCopy(variant.componentVariantId);
      expect(preview.pendingOperationId).toBeNull();
      expect(preview.summary).toBeNull();
      expect(preview.warnings.map((w) => w.code)).toContain('release_not_applicable');
    } finally {
      db.close();
      await ws.cleanup();
    }
  });
});

describe('Roe profile still works after generalization', () => {
  it('scans a Roe workspace into source_target mappings with plugin components', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      // Force Roe profile via setting so the test does not depend on folder heuristics.
      new SettingsService(db).setActiveProfile('roe');
      await createGitRepo(ws.root, 'Roe-apiv3-reason');
      await createGitRepo(ws.root, 'community-plugins-reason');
      await createRoePlugin(`${ws.root}/Roe-apiv3-reason`, 'tom_gauntlet', 'gauntlet', 'Gauntlet');
      await createRoePlugin(`${ws.root}/community-plugins-reason`, 'tom_gauntlet', 'gauntlet', 'Gauntlet');

      const inventory = new InventoryService(db);
      const result = await inventory.scanWorkspace(ws.root);
      expect(result.repoMappingsFound).toBeGreaterThanOrEqual(1);

      const reason = inventory.listRepoMappings().find((m) => m.mappingKey === 'reason');
      expect(reason).toBeDefined();
      expect(reason?.mappingKind).toBe('source_target');
      expect(reason?.targetRepoPath).not.toBeNull();
    } finally {
      db.close();
      await ws.cleanup();
    }
  });
});
