import { mkdirSync } from 'node:fs';
import path from 'node:path';

import DatabaseConstructor from 'better-sqlite3';

export type SqliteDatabase = DatabaseConstructor.Database;

export function createDatabase(dbPath: string): SqliteDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseConstructor(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    // The desktop app and the standalone MCP server can now open the SAME
    // database file concurrently (agent + UI). WAL lets a writer and readers
    // proceed without blocking each other, and a busy timeout makes a second
    // writer wait for the lock instead of instantly throwing SQLITE_BUSY.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}
