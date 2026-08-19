import type { SqliteDatabase } from '../main/db/sqlite';

export type PendingOperationDto = {
  id: number;
  kind: string;
  status: string;
  requestedBy: string;
  summary: string;
  payload: unknown;
  preview: unknown;
  requiresConfirmation: boolean;
  createdAt: string;
  confirmedAt: string | null;
  appliedAt: string | null;
};

type PendingOperationRow = {
  id: number;
  kind: string;
  status: string;
  requested_by: string;
  summary: string;
  payload_json: string;
  preview_json: string;
  requires_confirmation: number;
  created_at: string;
  confirmed_at: string | null;
  applied_at: string | null;
};

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapPendingOperationRow(row: PendingOperationRow): PendingOperationDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    requestedBy: row.requested_by,
    summary: row.summary,
    payload: parseJsonSafely(row.payload_json),
    preview: parseJsonSafely(row.preview_json),
    requiresConfirmation: row.requires_confirmation === 1,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    appliedAt: row.applied_at,
  };
}

/**
 * Direct read-only DB query of pending_operations, newest first. Used by the
 * MCP `tboard_pending_operations_list` tool and the `tboard://pending-operations`
 * resource. Deliberately not a write path — MCP never creates or applies
 * pending operations other than via ReleaseCopyService.previewCopy (which
 * itself never writes to the filesystem).
 */
export function listPendingOperations(db: SqliteDatabase): PendingOperationDto[] {
  const rows = db
    .prepare(
      `SELECT id, kind, status, requested_by, summary, payload_json, preview_json, requires_confirmation, created_at, confirmed_at, applied_at
       FROM pending_operations
       ORDER BY created_at DESC, id DESC`,
    )
    .all() as PendingOperationRow[];

  return rows.map(mapPendingOperationRow);
}
