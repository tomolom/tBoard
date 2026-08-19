import type { SqliteDatabase } from './connection';
import { EMBEDDED_MIGRATIONS } from './embeddedMigrations';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

function ensureMigrationTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function runMigrations(db: SqliteDatabase, migrations: readonly Migration[] = EMBEDDED_MIGRATIONS): void {
  ensureMigrationTable(db);
  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordMigration = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (hasMigration.get(migration.version)) {
      continue;
    }

    // Foreign-key enforcement must be OFF while a migration runs so that a
    // table rebuild (CREATE new / copy / DROP old / RENAME) does not cascade a
    // DROP TABLE into child rows. PK ids are preserved on copy, so references
    // stay valid once the rebuilt table takes the old name. PRAGMA foreign_keys
    // is a silent no-op inside a transaction, so it is toggled here, around it.
    const fkPreviouslyOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (fkPreviouslyOn) {
      db.pragma('foreign_keys = OFF');
    }
    try {
      const apply = db.transaction(() => {
        db.exec(migration.sql);
        // Guard: a correct migration must leave no dangling foreign keys. If it
        // does, roll back rather than commit a corrupt schema.
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (Array.isArray(violations) && violations.length > 0) {
          throw new Error(
            `Migration ${migration.name} left ${violations.length} foreign-key violation(s); rolled back.`,
          );
        }
        recordMigration.run(migration.version, migration.name);
      });
      apply();
    } finally {
      if (fkPreviouslyOn) {
        db.pragma('foreign_keys = ON');
      }
    }
  }
}
