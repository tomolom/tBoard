#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, getRuntimeDatabasePath } from '../main/db/connection';
import { runMigrations } from '../main/db/migrations';
import { watchDatabase } from '../main/dbWatcher';
import { resolveAttachmentsDir } from '../shared/appPaths';
import { buildServer } from './app';
import { hashPassword } from './auth';
import { loadServerConfig } from './config';

/**
 * `node out/server/index.js hash "passphrase"` prints a scrypt hash and exits,
 * so the published Docker image can generate a password hash with no source
 * checkout and no env vars:
 *   docker run --rm ghcr.io/tomolom/tboard hash "a long passphrase"
 */
function runHashCommand(): boolean {
  if (process.argv[2] !== 'hash') {
    return false;
  }
  const password = process.argv.slice(3).join(' ').trim();
  if (password.length < 12) {
    // eslint-disable-next-line no-console
    console.error('Usage: hash "<passphrase>"  (at least 12 characters)');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(hashPassword(password));
  return true;
}

async function main(): Promise<void> {
  if (runHashCommand()) {
    return;
  }
  const config = loadServerConfig();
  const dbPath = getRuntimeDatabasePath();
  const db = createDatabase(dbPath);
  runMigrations(db);

  // Locate the BUILT renderer (out/renderer). Order matters: never serve
  // src/renderer (its index.html references /src/main.tsx, a dev-only path that
  // would render a blank page when served over HTTP). `out/renderer` under cwd
  // is checked first (covers `npm run server:dev` from the repo root); the
  // bundled server (out/server/index.js) falls back to its sibling out/renderer.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'out/renderer'),
    join(here, '../../out/renderer'),
    join(here, '../renderer'),
  ];
  const staticRoot = candidates.find(
    (candidate) => existsSync(join(candidate, 'index.html')) && !candidate.endsWith(join('src', 'renderer')),
  );

  const app = await buildServer({
    db,
    config,
    staticRoot,
    attachmentsDir: resolveAttachmentsDir(),
    onDbChange: (cb) => watchDatabase(dbPath, cb),
  });

  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`tBoard server listening on http://${config.host}:${config.port} (public origin ${config.publicOrigin})`);
  if (!staticRoot) {
    // eslint-disable-next-line no-console
    console.warn('No built renderer found (out/renderer). API is up; run `npm run build` to serve the UI.');
  }

  const shutdown = async (): Promise<void> => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('tBoard server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
