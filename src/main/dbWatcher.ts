import { type StatWatcher, unwatchFile, watchFile } from 'node:fs';

/**
 * Watches the SQLite database for cross-process writes (e.g. the standalone MCP
 * server) and invokes `onChange` when the data may have changed.
 *
 * Why stat-polling and not `fs.watch`: the database runs in WAL mode, so commits
 * land in the sibling `<db>-wal` file and only fold into the main `.sqlite` file
 * at a checkpoint. On Windows, event-based `fs.watch` (ReadDirectoryChangesW)
 * does NOT reliably report appends to the `-wal` file while SQLite holds it open
 * — verified empirically: zero events for a burst of WAL writes. `fs.watchFile`
 * (stat polling) DOES observe the `-wal` size/mtime change, so it is the
 * reliable cross-platform mechanism here.
 *
 * Both the main db file and its `-wal` sibling are watched: `-wal` changes on
 * every write, the main file changes on checkpoint. `watchFile` handles a file
 * that doesn't exist yet (it fires when it appears). Poll ticks that see a
 * change are debounced so a main+wal double-change collapses into one emit.
 *
 * Returns a stop function that unwatches both files and cancels any pending emit.
 */
export function watchDatabase(
  dbPath: string,
  onChange: () => void,
  debounceMs = 150,
  pollIntervalMs = 250,
): () => void {
  const targets = [dbPath, `${dbPath}-wal`];

  let timer: NodeJS.Timeout | null = null;
  const watchers: StatWatcher[] = [];

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  for (const target of targets) {
    const watcher = watchFile(target, { interval: pollIntervalMs }, (curr, prev) => {
      // A real change moves mtime or size. A nonexistent file reports zeros, so
      // creation (0 -> nonzero) also registers.
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        schedule();
      }
    });
    watchers.push(watcher);
  }

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const target of targets) {
      unwatchFile(target);
    }
    watchers.length = 0;
  };
}
