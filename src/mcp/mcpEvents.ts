import type { SqliteDatabase } from '../main/db/sqlite';

export type McpEventStatus = 'received' | 'applied' | 'pending_confirmation' | 'rejected' | 'failed';

const MCP_ACTOR = 'mcp';

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

/**
 * Inserts a `received` mcp_events row for an incoming MCP action and returns its
 * id so the outcome can be recorded against the same row. Logging must never
 * break the MCP action itself, so any failure here is swallowed and returns null.
 */
export function recordMcpReceived(db: SqliteDatabase, operation: string, request: unknown): number | null {
  try {
    const result = db
      .prepare(
        `INSERT INTO mcp_events (operation, actor, status, request_json)
         VALUES (?, ?, 'received', ?)`,
      )
      .run(operation, MCP_ACTOR, serialize(request));
    return Number(result.lastInsertRowid);
  } catch {
    return null;
  }
}

/**
 * Updates a previously recorded mcp_events row with its terminal status and
 * response payload. `applied_at` is set for terminal outcomes. Swallows errors
 * so logging can never fail an otherwise-successful MCP action.
 */
export function recordMcpOutcome(db: SqliteDatabase, eventId: number | null, status: McpEventStatus, response: unknown): void {
  if (eventId === null) {
    return;
  }
  try {
    db.prepare(
      `UPDATE mcp_events
       SET status = ?, response_json = ?, applied_at = datetime('now')
       WHERE id = ?`,
    ).run(status, serialize(response), eventId);
  } catch {
    // Intentionally ignored: event logging is best-effort.
  }
}
