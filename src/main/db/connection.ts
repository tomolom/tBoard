import { app } from 'electron';

import {
  resolveCommandOutputRoot,
  resolveDatabasePath,
  resolveEvidenceRoot,
} from '../../shared/appPaths';

export type { SqliteDatabase } from './sqlite';
export { createDatabase } from './sqlite';

/**
 * Data paths delegate to the shared, Electron-free resolver in
 * `src/shared/appPaths.ts` so the desktop app and the standalone MCP server
 * always resolve to the SAME location by construction, independent of
 * Electron's name-based userData resolution (which diverges between the dev
 * `name` "tboard" and the packaged `productName` "tBoard").
 */
export function getRuntimeDatabasePath(): string {
  return resolveDatabasePath();
}

export function getRuntimeEvidenceRoot(): string {
  return resolveEvidenceRoot();
}

export function getRuntimeCommandOutputRoot(): string {
  return resolveCommandOutputRoot();
}

/**
 * A sensible OS-specific default workspace root shown before the user picks one.
 * Uses the user's documents folder; falls back to home if that is unavailable.
 * Never a hard-coded machine-specific path.
 */
export function getRuntimeDefaultWorkspaceRoot(): string {
  try {
    return app.getPath('documents');
  } catch {
    return app.getPath('home');
  }
}
