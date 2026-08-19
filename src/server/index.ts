#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, getRuntimeDatabasePath } from '../main/db/connection';
import { runMigrations } from '../main/db/migrations';
import { watchDatabase } from '../main/dbWatcher';
import { buildServer } from './app';
import { loadServerConfig } from './config';

async function main(): Promise<void> {
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
