import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanRoeComponents } from '../../src/main/profiles/roe/componentScanner';
import { scanRoeRepoMappings } from '../../src/main/profiles/roe/repoMappingScanner';
import { createRepo, createRoePlugin, createTempWorkspace } from './testFixtures';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('Roe repo mapping scanner', () => {
  it('detects fixture mappings and reports missing targets', async () => {
    const workspace = await createTempWorkspace();
    cleanup = workspace.cleanup;

    await createRepo(workspace.root, 'Roe-apiv3');
    await createRepo(workspace.root, 'community-plugins');
    await createRepo(workspace.root, 'Roe-apiv3-reason');

    const scan = await scanRoeRepoMappings(workspace.root);

    expect(scan.mappings.map((mapping) => mapping.mappingKey)).toEqual(expect.arrayContaining(['main', 'reason']));
    expect(scan.mappings.find((mapping) => mapping.mappingKey === 'main')?.enabled).toBe(true);
    expect(scan.mappings.find((mapping) => mapping.mappingKey === 'reason')?.enabled).toBe(false);
    expect(scan.warnings.some((warning) => warning.code === 'target_repo_missing')).toBe(true);
  });
});

describe('Roe component scanner', () => {
  it('detects descriptor roots and uses package segment as canonical name', async () => {
    const workspace = await createTempWorkspace();
    cleanup = workspace.cleanup;
    const repo = await createRepo(workspace.root, 'community-plugins-reason');

    await createRoePlugin(repo, 'tom_gauntlet', 'gauntlet', '<html><font color=3366fe>[A]</font> Gauntlet');

    const scan = await scanRoeComponents(repo);

    expect(scan.components).toHaveLength(1);
    expect(scan.components[0]).toMatchObject({
      rootName: 'tom_gauntlet',
      canonicalName: 'gauntlet',
      displayName: '[A] Gauntlet',
      packageHint: 'gauntlet',
    });
    expect(scan.components[0].rootPath).toBe(path.join(repo, 'tom_gauntlet'));
  });
});
