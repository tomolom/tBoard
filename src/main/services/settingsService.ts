import type { SqliteDatabase } from '../db/connection';

const LAST_BOARD_ID_KEY = 'lastBoardId';
const REMOTE_URL_KEY = 'remoteUrl';

export class SettingsService {
  constructor(private readonly db: SqliteDatabase) {}

  /** The last-selected board id, for restoring the view on launch. */
  getLastBoardId(): number | null {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(LAST_BOARD_ID_KEY) as
      | { value_json: string }
      | undefined;
    if (!row) {
      return null;
    }
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === 'number' ? parsed : null;
  }

  setLastBoardId(boardId: number | null): void {
    this.upsert(LAST_BOARD_ID_KEY, boardId);
  }

  /**
   * The remote tBoard server URL the desktop app connects to in remote mode,
   * or null for local-first mode (the default). Persisted so the app reconnects
   * on next launch.
   */
  getRemoteUrl(): string | null {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(REMOTE_URL_KEY) as
      | { value_json: string }
      | undefined;
    if (!row) {
      return null;
    }
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
  }

  /**
   * Sets (or clears, with null) the remote URL. Only http(s) origins are
   * accepted; anything else throws so a bad value can't be persisted.
   */
  setRemoteUrl(url: string | null): void {
    let normalized: string | null = null;
    if (url !== null) {
      const trimmed = url.trim();
      const parsed = new URL(trimmed); // throws on invalid
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Remote URL must be http(s).');
      }
      normalized = parsed.origin;
    }
    this.upsert(REMOTE_URL_KEY, normalized);
  }

  private upsert(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
      )
      .run(key, JSON.stringify(value));
  }
}
