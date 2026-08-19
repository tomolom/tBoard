import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type SqliteDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { watchDatabase } from '../../src/main/dbWatcher';
import { createTempWorkspace } from './testFixtures';

describe('watchDatabase', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let dbPath: string;
  let db: SqliteDatabase;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    ({ root, cleanup } = await createTempWorkspace());
    dbPath = path.join(root, 'tboard.sqlite');
    db = createDatabase(dbPath); // WAL mode + busy_timeout, per createDatabase
    runMigrations(db);
  });

  afterEach(async () => {
    stop?.();
    stop = null;
    db.close();
    await cleanup();
  });

  function nextChange(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watcher did not fire')), 4000);
      stop = watchDatabase(
        dbPath,
        () => {
          clearTimeout(timeout);
          resolve();
        },
        40,
        60,
      );
    });
  }

  it('fires when the database is written (WAL sibling changes)', async () => {
    const fired = nextChange();
    // A committed write in WAL mode lands in tboard.sqlite-wal, not the main
    // file — the watcher must notice that sibling, which is the whole point.
    // (Verified: fs.watch misses this on Windows; stat-polling catches it.)
    await new Promise((resolve) => setTimeout(resolve, 120));
    db.prepare("INSERT INTO boards (name, repo_path) VALUES ('W', ?)").run(path.join(root, 'repo'));
    await expect(fired).resolves.toBeUndefined();
  });

  it('debounces a burst of writes into limited callbacks', async () => {
    let count = 0;
    stop = watchDatabase(
      dbPath,
      () => {
        count += 1;
      },
      120,
      60,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const insert = db.prepare("INSERT INTO boards (name, repo_path) VALUES (?, ?)");
    for (let i = 0; i < 8; i += 1) {
      insert.run(`B${i}`, path.join(root, `repo-${i}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    // 8 rapid writes must not produce 8 callbacks; debounce collapses the burst.
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
  });

  it('stop() cancels further notifications', async () => {
    let count = 0;
    const localStop = watchDatabase(dbPath, () => {
      count += 1;
    }, 40, 60);
    localStop();
    db.prepare("INSERT INTO boards (name, repo_path) VALUES ('X', ?)").run(path.join(root, 'gone'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(count).toBe(0);
  });
});
