import type { SqliteDatabase } from '../../src/main/db/connection';

export function seedRepoMapping(
  db: SqliteDatabase,
  options: { mappingKey: string; sourceRepoPath: string; targetRepoPath: string; withRepoRows?: boolean },
): { repoMappingId: number; sourceRepoId: number | null; targetRepoId: number | null } {
  db.prepare(
    `INSERT INTO repo_mappings (mapping_key, display_name, source_repo_path, target_repo_path, mapping_source, enabled)
     VALUES (?, ?, ?, ?, 'manual', 1)`,
  ).run(options.mappingKey, options.mappingKey, options.sourceRepoPath, options.targetRepoPath);
  const repoMappingId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  let sourceRepoId: number | null = null;
  let targetRepoId: number | null = null;
  if (options.withRepoRows) {
    db.prepare(`INSERT INTO repos (repo_mapping_id, role, name, path) VALUES (?, 'source', ?, ?)`).run(
      repoMappingId,
      options.mappingKey,
      options.sourceRepoPath,
    );
    sourceRepoId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    db.prepare(`INSERT INTO repos (repo_mapping_id, role, name, path) VALUES (?, 'target', ?, ?)`).run(
      repoMappingId,
      options.mappingKey,
      options.targetRepoPath,
    );
    targetRepoId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  }

  return { repoMappingId, sourceRepoId, targetRepoId };
}

export function seedComponentVariant(
  db: SqliteDatabase,
  options: {
    canonicalName: string;
    mappingKey?: string;
    sourceRootPath?: string | null;
    targetRootPath?: string | null;
  },
): { componentId: number; componentVariantId: number } {
  const mappingKey = options.mappingKey ?? options.canonicalName;
  const sourceRootPath = options.sourceRootPath ?? null;
  const targetRootPath = options.targetRootPath ?? null;

  db.prepare(
    `INSERT INTO repo_mappings (mapping_key, display_name, source_repo_path, target_repo_path, mapping_source, enabled)
     VALUES (?, ?, ?, ?, 'manual', 1)`,
  ).run(mappingKey, mappingKey, '/tmp/source-repo', '/tmp/target-repo');
  const repoMappingId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  db.prepare(`INSERT INTO components (canonical_name, display_name) VALUES (?, ?)`).run(options.canonicalName, options.canonicalName);
  const componentId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  db.prepare(
    `INSERT INTO component_variants (
       component_id, repo_mapping_id, source_component_root_path, target_component_root_path,
       source_exists, target_exists
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(componentId, repoMappingId, sourceRootPath, targetRootPath, sourceRootPath ? 1 : 0, targetRootPath ? 1 : 0);

  const componentVariantId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return { componentId, componentVariantId };
}
