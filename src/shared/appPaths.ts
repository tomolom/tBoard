import os from 'node:os';
import path from 'node:path';

/**
 * Canonical per-user application directory name. This is the SINGLE source of
 * truth for where tBoard stores its data, shared by the Electron app and the
 * standalone MCP server so they always resolve to the same location.
 *
 * It intentionally does NOT rely on Electron's `app.getName()` / userData
 * resolution, which the non-Electron MCP process cannot call at all. The value
 * is pinned to match what Electron actually uses at runtime: `app.getName()`
 * resolves to the package.json `name` ("tboard") on both dev and packaged
 * builds, because electron-builder's `productName` ("tBoard") lives only in
 * build config and is never injected into the app's package.json. Matching the
 * real, existing on-disk folder means the app and MCP share one database on
 * every platform with zero data migration.
 */
export const APP_DIR_NAME = 'tboard';

/**
 * Resolves the per-user data directory for tBoard, mirroring Electron's
 * `app.getPath('userData')` algorithm in pure Node (no Electron dependency):
 * - Windows: %APPDATA%\tBoard
 * - macOS:   ~/Library/Application Support/tBoard
 * - Linux:   $XDG_CONFIG_HOME/tBoard (or ~/.config/tBoard)
 */
export function resolveUserDataDir(): string {
  const home = os.homedir();

  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR_NAME);
  }

  const base = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, APP_DIR_NAME);
}

/** The canonical SQLite database path shared by the app and the MCP server. */
export function resolveDatabasePath(): string {
  return path.join(resolveUserDataDir(), 'tboard.sqlite');
}
