-- Migration 007: server-side session store for the optional web mode.
--
-- Only the hosted web server (src/server/) uses this; the desktop app simply
-- ignores it. Sessions are server-side (not stateless tokens) so they can be
-- revoked and expired. The cookie carries a raw random id; only its SHA-256
-- hash is stored here, so a DB leak does not hand out live session cookies.

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
