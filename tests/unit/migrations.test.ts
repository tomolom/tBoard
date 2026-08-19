import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { EMBEDDED_MIGRATIONS } from '../../src/main/db/embeddedMigrations';
import { runMigrations } from '../../src/main/db/migrations';

describe('database migrations', () => {
  it('creates the core tables and overview view', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const views = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
        .all() as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).toEqual(
        expect.arrayContaining(['repo_mappings', 'repos', 'components', 'component_variants', 'cards', 'evidence']),
      );
      expect(views.map((row) => row.name)).toContain('component_variant_overview');
    } finally {
      db.close();
    }
  });

  it('migration 002 rebuilds repo_mappings preserving data and foreign-key integrity', () => {
    const v1Only = EMBEDDED_MIGRATIONS.filter((m) => m.version === 1);
    const db = createDatabase(':memory:');
    try {
      // Build a v1 database and seed a source_target mapping with child rows
      // across every FK-referencing table.
      runMigrations(db, v1Only);
      const mid = db
        .prepare(
          `INSERT INTO repo_mappings (mapping_key, display_name, source_repo_path, target_repo_path, mapping_source)
           VALUES ('reason','Reason','/ws/src','/ws/tgt','inferred')`,
        )
        .run().lastInsertRowid;
      db.prepare(`INSERT INTO repos (repo_mapping_id, role, name, path) VALUES (?, 'source','src','/ws/src')`).run(mid);
      const cid = db.prepare(`INSERT INTO components (canonical_name, display_name) VALUES ('g','G')`).run().lastInsertRowid;
      const vid = db
        .prepare(`INSERT INTO component_variants (component_id, repo_mapping_id, source_exists, target_exists) VALUES (?, ?, 1, 1)`)
        .run(cid, mid).lastInsertRowid;
      db.prepare(`INSERT INTO cards (type, title, repo_mapping_id, component_variant_id) VALUES ('bug','b', ?, ?)`).run(mid, vid);

      // Apply all migrations (002 rebuilds repo_mappings).
      runMigrations(db, EMBEDDED_MIGRATIONS);

      // Data preserved; existing row became a source_target pair.
      const row = db.prepare('SELECT mapping_kind, target_repo_path FROM repo_mappings WHERE mapping_key = ?').get('reason') as {
        mapping_kind: string;
        target_repo_path: string | null;
      };
      expect(row.mapping_kind).toBe('source_target');
      expect(row.target_repo_path).toBe('/ws/tgt');

      // Child rows survived the table rebuild with valid references.
      const violations = db.pragma('foreign_key_check') as unknown[];
      expect(violations).toHaveLength(0);
      expect((db.prepare('SELECT COUNT(*) n FROM cards').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) n FROM component_variants').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('migration 002 allows single-repo mappings and enforces the kind/target CHECK', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      // A single-repo mapping (no target) is now valid.
      expect(() =>
        db
          .prepare(
            `INSERT INTO repo_mappings (mapping_key, display_name, mapping_kind, source_repo_path, target_repo_path, mapping_source)
             VALUES ('solo','Solo','single','/ws/solo', NULL, 'manual')`,
          )
          .run(),
      ).not.toThrow();

      // A single mapping WITH a target violates the CHECK.
      expect(() =>
        db
          .prepare(
            `INSERT INTO repo_mappings (mapping_key, display_name, mapping_kind, source_repo_path, target_repo_path, mapping_source)
             VALUES ('bad','Bad','single','/ws/bad','/ws/bad-t','manual')`,
          )
          .run(),
      ).toThrow();

      // A source_target mapping WITHOUT a target violates the CHECK.
      expect(() =>
        db
          .prepare(
            `INSERT INTO repo_mappings (mapping_key, display_name, mapping_kind, source_repo_path, target_repo_path, mapping_source)
             VALUES ('bad2','Bad2','source_target','/ws/bad2', NULL, 'manual')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('is idempotent when run repeatedly', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const version = () =>
        (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
      const first = version();
      runMigrations(db);
      expect(version()).toBe(first);
    } finally {
      db.close();
    }
  });
});
