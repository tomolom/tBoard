-- Migration 008: file attachments on cards.
--
-- Files are stored on disk under <dir(TBOARD_DB_PATH)>/attachments/ using a
-- RANDOM stored_name (never the user-supplied name), so the DB row is the only
-- link between a display name and the bytes on disk. Deleting a card cascades
-- its attachment rows; the files are unlinked by application code.

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  -- Display name only. NEVER used to build a filesystem path.
  original_name TEXT NOT NULL,
  -- Actual on-disk filename: 64 hex chars from crypto.randomBytes(32).
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id);
