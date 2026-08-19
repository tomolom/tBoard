import type { SqliteDatabase } from '../db/connection';

const LAST_BOARD_ID_KEY = 'lastBoardId';

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
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
      )
      .run(LAST_BOARD_ID_KEY, JSON.stringify(boardId));
  }
}
