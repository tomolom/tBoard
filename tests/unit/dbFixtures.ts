import type { SqliteDatabase } from '../../src/main/db/connection';

/** Inserts a board row and returns its id. */
export function seedBoard(db: SqliteDatabase, options: { name?: string; repoPath: string }): { boardId: number } {
  db.prepare("INSERT INTO boards (name, repo_path, updated_at) VALUES (?, ?, datetime('now'))").run(
    options.name ?? options.repoPath,
    options.repoPath,
  );
  const boardId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return { boardId };
}
