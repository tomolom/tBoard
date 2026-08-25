-- Migration 010: split the single "Approved" column into two.
--
-- The board now distinguishes agent sign-off from human sign-off:
--   ... -> Needs Fix -> Agent Approved -> Human Approved -> Released
-- as status values: ... needs_fix, agent_approved, human_approved, released.
--
-- Changing a CHECK constraint requires a table rebuild. Existing cards map:
--   approved -> human_approved   (all current Approved cards become Human Approved)
-- every other status is unchanged and still valid under the new CHECK.
--
-- The migration runner turns foreign_keys OFF around each migration and runs
-- foreign_key_check before commit, so the board_id FK is preserved without
-- cascade during the rebuild. All columns (through migration 009's `fix`) and
-- indexes are recreated.

CREATE TABLE cards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'developing', 'untested', 'needs_fix', 'agent_approved', 'human_approved', 'released')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  branch TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'mcp')),
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  module TEXT,
  position REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'bug', 'feature')),
  fix TEXT
);

INSERT INTO cards_new (
  id, board_id, title, description, status, priority, branch, source,
  created_by, created_at, updated_at, completed_at, module, position, type, fix
)
SELECT
  id, board_id, title, description,
  CASE status WHEN 'approved' THEN 'human_approved' ELSE status END,
  priority, branch, source,
  created_by, created_at, updated_at, completed_at, module, position, type, fix
FROM cards;

DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_branch ON cards(branch);
CREATE INDEX IF NOT EXISTS idx_cards_board_status_position ON cards(board_id, status, position);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
