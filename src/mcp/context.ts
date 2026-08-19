import type { SqliteDatabase } from '../main/db/sqlite';
import { createDatabase } from '../main/db/sqlite';
import { runMigrations } from '../main/db/migrations';
import { BoardService } from '../main/services/boardService';
import { CardService } from '../main/services/cardService';
import { listBranches } from '../main/services/gitBranches';
import { resolveDatabasePath } from '../shared/appPaths';

export type TBoardMcpContext = {
  db: SqliteDatabase;
  dbPath: string;
  boards: BoardService;
  cards: CardService;
  listBranches: typeof listBranches;
  close(): void;
};

/**
 * Resolves the SQLite database the MCP server opens.
 *
 * Defaults to the SAME per-user location the desktop app uses (via the shared,
 * Electron-free resolver), so an agent driving the MCP server and the app share
 * one board out of the box. `TBOARD_DB_PATH` still overrides for tests or an
 * isolated database.
 */
export function resolveDbPath(): string {
  const override = process.env.TBOARD_DB_PATH;
  if (override && override.trim().length > 0) {
    return override;
  }
  return resolveDatabasePath();
}

/**
 * Opens (creating parent directories as needed) the SQLite database used by the
 * MCP server, runs migrations, and constructs the board/card service layer.
 */
export function createTBoardMcpContext(overrides?: { dbPath?: string }): TBoardMcpContext {
  const dbPath = overrides?.dbPath ?? resolveDbPath();

  const db = createDatabase(dbPath);
  runMigrations(db);

  return {
    db,
    dbPath,
    boards: new BoardService(db),
    cards: new CardService(db),
    listBranches,
    close: () => db.close(),
  };
}
