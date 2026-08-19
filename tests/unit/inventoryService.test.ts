import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { InventoryService } from '../../src/main/services/inventoryService';
import { createRepo, createRoePlugin, createTempWorkspace } from './testFixtures';

describe('InventoryService', () => {
  it('scans inventory idempotently and matches tom_ target roots by package canonical name', async () => {
    const workspace = await createTempWorkspace();
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const source = await createRepo(workspace.root, 'Roe-apiv3-reason');
      const target = await createRepo(workspace.root, 'community-plugins-reason');
      await createRoePlugin(source, 'gauntlet', 'gauntlet', '[A] Gauntlet');
      await createRoePlugin(target, 'tom_gauntlet', 'gauntlet', '[A] Gauntlet');

      const service = new InventoryService(db);
      const first = await service.scanWorkspace(workspace.root);
      const second = await service.scanWorkspace(workspace.root);
      const variants = service.listComponentVariants();

      expect(first.componentVariantsFound).toBe(1);
      expect(second.componentVariantsFound).toBe(1);
      expect(variants).toHaveLength(1);
      expect(variants[0]).toMatchObject({
        canonicalName: 'gauntlet',
        mappingKey: 'reason',
        sourceExists: true,
        targetExists: true,
      });
    } finally {
      db.close();
      await workspace.cleanup();
    }
  });
});
