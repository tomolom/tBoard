import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { APP_DIR_NAME, resolveDatabasePath, resolveUserDataDir } from '../../src/shared/appPaths';
import { resolveDbPath } from '../../src/mcp/context';

describe('shared app paths', () => {
  const originalDbPath = process.env.TBOARD_DB_PATH;

  afterEach(() => {
    if (originalDbPath === undefined) {
      delete process.env.TBOARD_DB_PATH;
    } else {
      process.env.TBOARD_DB_PATH = originalDbPath;
    }
  });

  it('pins the app directory name to the Electron runtime name ("tboard")', () => {
    // Electron app.getName() resolves to package.json `name` on dev + packaged;
    // the folder name must match so app and MCP share the existing on-disk DB.
    expect(APP_DIR_NAME).toBe('tboard');
  });

  it('places the database under the user-data dir when unset', () => {
    delete process.env.TBOARD_DB_PATH;
    const dir = resolveUserDataDir();
    expect(resolveDatabasePath()).toBe(path.join(dir, 'tboard.sqlite'));
  });

  it('honors TBOARD_DB_PATH for the shared/server database path (Docker volume)', () => {
    // The web server uses resolveDatabasePath(); in Docker the DB must land on
    // the mounted volume, not inside the container (else it is wiped on redeploy).
    process.env.TBOARD_DB_PATH = path.join('/data', 'tboard.sqlite');
    expect(resolveDatabasePath()).toBe(path.join('/data', 'tboard.sqlite'));
  });

  it('unifies the MCP default database with the app database path', () => {
    delete process.env.TBOARD_DB_PATH;
    // The whole point of the unification: with no override, the standalone MCP
    // server opens exactly the same file the desktop app does.
    expect(resolveDbPath()).toBe(resolveDatabasePath());
  });

  it('lets TBOARD_DB_PATH override, and app/server/MCP all agree on it', () => {
    process.env.TBOARD_DB_PATH = path.join('/tmp', 'isolated', 'board.sqlite');
    expect(resolveDbPath()).toBe(path.join('/tmp', 'isolated', 'board.sqlite'));
    // The override now applies to the shared/server path too, so every
    // entrypoint opens the same file (the Docker-volume fix).
    expect(resolveDbPath()).toBe(resolveDatabasePath());
  });
});
