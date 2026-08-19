import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { EMBEDDED_MIGRATIONS } from '../../src/main/db/embeddedMigrations';
import { runMigrations } from '../../src/main/db/migrations';

describe('database migrations', () => {
  it('ends at the lean boards + cards schema', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
        .map((row) => row.name)
        .filter((name) => name !== 'sqlite_sequence');

      // The stripped feature tables are gone.
      expect(tables).not.toContain('repo_mappings');
      expect(tables).not.toContain('component_variants');
      expect(tables).not.toContain('evidence');
      expect(tables).not.toContain('diff_snapshots');
      expect(tables).not.toContain('command_runs');
      expect(tables).not.toContain('pending_operations');

      // The lean set remains.
      expect(tables).toEqual(
        expect.arrayContaining(['app_settings', 'boards', 'cards', 'mcp_events', 'schema_migrations']),
      );

      // No leftover views.
      const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as Array<{ name: string }>;
      expect(views).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('cards belong to a board and cascade-delete with it; mcp_events survives', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const boardId = db
        .prepare("INSERT INTO boards (name, repo_path) VALUES ('app', '/repos/app')")
        .run().lastInsertRowid;
      db.prepare("INSERT INTO cards (board_id, title, branch) VALUES (?, 'card', 'main')").run(boardId);
      expect((db.prepare('SELECT COUNT(*) n FROM cards').get() as { n: number }).n).toBe(1);

      db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
      expect((db.prepare('SELECT COUNT(*) n FROM cards').get() as { n: number }).n).toBe(0);

      // mcp_events is retained (and has no dangling FK after migration 003).
      const violations = db.pragma('foreign_key_check') as unknown[];
      expect(violations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('migration 003 preserves mcp_events rows through the strip', () => {
    const upTo2 = EMBEDDED_MIGRATIONS.filter((m) => m.version <= 2);
    const db = createDatabase(':memory:');
    try {
      runMigrations(db, upTo2);
      db.prepare("INSERT INTO mcp_events (operation, actor, status) VALUES ('x', 'mcp', 'applied')").run();

      runMigrations(db, EMBEDDED_MIGRATIONS);
      const events = db.prepare('SELECT COUNT(*) n FROM mcp_events').get() as { n: number };
      expect(events.n).toBe(1);
      const violations = db.pragma('foreign_key_check') as unknown[];
      expect(violations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('enforces the card status CHECK', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const boardId = db.prepare("INSERT INTO boards (name, repo_path) VALUES ('a', '/r')").run().lastInsertRowid;
      expect(() => db.prepare("INSERT INTO cards (board_id, title, status) VALUES (?, 't', 'archived')").run(boardId)).toThrow();
    } finally {
      db.close();
    }
  });

  it('migration 006 maps the old 4 statuses to the six-column set', () => {
    const upTo5 = EMBEDDED_MIGRATIONS.filter((m) => m.version <= 5);
    const db = createDatabase(':memory:');
    try {
      runMigrations(db, upTo5);
      const boardId = db.prepare("INSERT INTO boards (name, repo_path) VALUES ('a', '/r')").run().lastInsertRowid;
      const insert = db.prepare('INSERT INTO cards (board_id, title, status) VALUES (?, ?, ?)');
      for (const status of ['backlog', 'in_progress', 'in_review', 'done']) {
        insert.run(boardId, `c-${status}`, status);
      }

      runMigrations(db, EMBEDDED_MIGRATIONS);

      const statusOf = (title: string) =>
        (db.prepare('SELECT status FROM cards WHERE title = ?').get(title) as { status: string }).status;
      expect(statusOf('c-backlog')).toBe('backlog');
      expect(statusOf('c-in_progress')).toBe('developing');
      expect(statusOf('c-in_review')).toBe('untested');
      expect(statusOf('c-done')).toBe('released');

      // New statuses accepted, an old one now rejected, FK intact.
      expect(() => insert.run(boardId, 'nf', 'needs_fix')).not.toThrow();
      expect(() => insert.run(boardId, 'ap', 'approved')).not.toThrow();
      expect(() => insert.run(boardId, 'x', 'in_progress')).toThrow();
      expect(db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('is idempotent when run repeatedly', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const version = () => (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
      const first = version();
      runMigrations(db);
      expect(version()).toBe(first);
    } finally {
      db.close();
    }
  });
});
