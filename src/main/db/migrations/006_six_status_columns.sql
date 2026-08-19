-- Migration 006: restore the six originally-specced Kanban columns.
--
-- The board pivoted to a generic 4-status flow (backlog, in_progress, in_review,
-- done); this restores the PRD §7 column set:
--   Backlog -> Developing -> Untested -> Needs Fix -> Approved -> Released
-- as status values: backlog, developing, untested, needs_fix, approved, released.
--
-- Changing a CHECK constraint requires a table rebuild. Existing cards map:
--   backlog     -> backlog
--   in_progress -> developing
--   in_review   -> untested
--   done        -> released
-- (needs_fix and approved are new columns with no prior cards.)
--
-- The migration runner turns foreign_keys OFF around each migration and runs
-- foreign_key_check before commit, so the board_id FK is preserved without
-- cascade during the rebuild. All columns (through migrations 004/005) and
-- indexes are recreated.

CREATE TABLE cards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'developing', 'untested', 'needs_fix', 'approved', 'released')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  branch TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'mcp')),
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  module TEXT,
  position REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'bug', 'feature'))
);

INSERT INTO cards_new (
  id, board_id, title, description, status, priority, branch, source,
  created_by, created_at, updated_at, completed_at, module, position, type
)
SELECT
  id, board_id, title, description,
  CASE status
    WHEN 'in_progress' THEN 'developing'
    WHEN 'in_review' THEN 'untested'
    WHEN 'done' THEN 'released'
    ELSE 'backlog'
  END,
  priority, branch, source,
  created_by, created_at, updated_at, completed_at, module, position, type
FROM cards;

DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_branch ON cards(branch);
CREATE INDEX IF NOT EXISTS idx_cards_board_status_position ON cards(board_id, status, position);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
