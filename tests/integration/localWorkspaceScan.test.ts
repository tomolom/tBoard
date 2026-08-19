import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { DiffService } from '../../src/main/services/diffService';
import { InventoryService } from '../../src/main/services/inventoryService';

const workspaceRoot = process.env.TBOARD_WORKSPACE_ROOT;
const shouldScanDiffs = process.env.TBOARD_SCAN_DIFFS === '1';

describe.skipIf(!workspaceRoot)('local workspace scan', () => {
  it('scans the configured local workspace read-only', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new InventoryService(db);
      const result = await service.scanWorkspace(workspaceRoot!);
      const mappings = service.listRepoMappings();
      const variants = service.listComponentVariants();

      expect(result.repoMappingsFound).toBeGreaterThan(0);
      expect(mappings.some((mapping) => mapping.mappingKey === 'main')).toBe(true);
      expect(variants.length).toBeGreaterThan(0);

      if (shouldScanDiffs) {
        const diffService = new DiffService(db);
        const diffResult = await diffService.scanDiffs();
        const diffOverviews = diffService.listDiffOverviews();

        expect(diffResult.componentVariantsScanned).toBe(variants.length);
        expect(diffOverviews.length).toBe(variants.length);
      }
    } finally {
      db.close();
    }
  });
});
