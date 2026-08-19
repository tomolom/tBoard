import type { SqliteDatabase } from '../db/connection';

const WORKSPACE_ROOT_KEY = 'workspaceRoot';
const ACTIVE_PROFILE_KEY = 'activeProfile';

export class SettingsService {
  constructor(private readonly db: SqliteDatabase) {}

  getWorkspaceRoot(): string | null {
    const row = this.db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get(WORKSPACE_ROOT_KEY) as { value_json: string } | undefined;

    if (!row) {
      return null;
    }

    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  }

  setWorkspaceRoot(workspaceRoot: string): void {
    this.upsert(WORKSPACE_ROOT_KEY, workspaceRoot);
  }

  /**
   * The explicitly-selected workflow profile id ('generic' | 'roe'), or null to
   * let discovery auto-detect. Kept as a free string here; the inventory layer
   * validates it against known profile ids.
   */
  getActiveProfile(): string | null {
    const row = this.db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get(ACTIVE_PROFILE_KEY) as { value_json: string } | undefined;
    if (!row) {
      return null;
    }
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  }

  setActiveProfile(profileId: string): void {
    this.upsert(ACTIVE_PROFILE_KEY, profileId);
  }

  private upsert(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = datetime('now')`,
      )
      .run(key, JSON.stringify(value));
  }
}
