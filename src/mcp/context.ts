import os from 'node:os';
import path from 'node:path';

import type { SqliteDatabase } from '../main/db/sqlite';
import { createDatabase } from '../main/db/sqlite';
import { runMigrations } from '../main/db/migrations';
import { CardService } from '../main/services/cardService';
import { CommandService } from '../main/services/commandService';
import { DiffService } from '../main/services/diffService';
import { EvidenceService } from '../main/services/evidenceService';
import { InventoryService } from '../main/services/inventoryService';
import { ReleaseCopyService } from '../main/services/releaseCopyService';
import { SettingsService } from '../main/services/settingsService';
import { resolveDatabasePath } from '../shared/appPaths';

export type TBoardMcpContext = {
  db: SqliteDatabase;
  dbPath: string;
  evidenceRoot: string;
  commandOutputRoot: string;
  cards: CardService;
  commands: CommandService;
  diff: DiffService;
  evidence: EvidenceService;
  inventory: InventoryService;
  releaseCopy: ReleaseCopyService;
  settings: SettingsService;
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

export function resolveEvidenceRoot(dbPath: string): string {
  const override = process.env.TBOARD_EVIDENCE_ROOT;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(path.dirname(dbPath), 'evidence');
}

/**
 * A sensible default workspace root for the MCP process (which has no Electron
 * `app`): the user's Documents folder, falling back to the home directory.
 * Mirrors the app's getRuntimeDefaultWorkspaceRoot intent without Electron.
 */
export function resolveDefaultWorkspaceRoot(): string {
  const home = os.homedir();
  return home ? path.join(home, 'Documents') : process.cwd();
}

export function resolveCommandOutputRoot(dbPath: string): string {
  const override = process.env.TBOARD_COMMAND_OUTPUT_ROOT;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(path.dirname(dbPath), 'command-output');
}

/**
 * Opens (creating parent directories as needed) the SQLite database used by the
 * MCP server, runs migrations, and constructs the read-mostly service layer.
 *
 * DB path resolution:
 * - TBOARD_DB_PATH env var, if set.
 * - Otherwise `.tboard/tboard.sqlite` under process.cwd().
 *
 * Evidence root resolution:
 * - TBOARD_EVIDENCE_ROOT env var, if set.
 * - Otherwise a sibling `evidence` folder next to the resolved DB path.
 */
export function createTBoardMcpContext(overrides?: {
  dbPath?: string;
  evidenceRoot?: string;
  commandOutputRoot?: string;
}): TBoardMcpContext {
  const dbPath = overrides?.dbPath ?? resolveDbPath();
  const evidenceRoot = overrides?.evidenceRoot ?? resolveEvidenceRoot(dbPath);
  const commandOutputRoot = overrides?.commandOutputRoot ?? resolveCommandOutputRoot(dbPath);

  const db = createDatabase(dbPath);
  runMigrations(db);

  return {
    db,
    dbPath,
    evidenceRoot,
    commandOutputRoot,
    cards: new CardService(db),
    commands: new CommandService(db, commandOutputRoot),
    diff: new DiffService(db),
    evidence: new EvidenceService(db, evidenceRoot),
    inventory: new InventoryService(db),
    releaseCopy: new ReleaseCopyService(db),
    settings: new SettingsService(db),
    close: () => db.close(),
  };
}
