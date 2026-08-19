import { resolveDatabasePath } from '../../shared/appPaths';

export type { SqliteDatabase } from './sqlite';
export { createDatabase } from './sqlite';

/**
 * The SQLite database path delegates to the shared, Electron-free resolver in
 * `src/shared/appPaths.ts` so the desktop app and the standalone MCP server
 * always resolve to the SAME location by construction.
 */
export function getRuntimeDatabasePath(): string {
  return resolveDatabasePath();
}
