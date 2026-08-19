-- Migration 003: strip tBoard down to boards + cards + branches.
--
-- The app pivots from a source->target repo-mapping / component / evidence /
-- diff / release / command tool to a simple Kanban board PER GIT REPO:
--   * a "board" is a git repo the user adds (by path);
--   * cards belong to one board and carry a git branch name;
--   * everything else (mappings, components, variants, evidence, diffs,
--     release copy, command runner, pending ops) is removed.
--
-- The migration runner turns foreign_keys OFF around each migration and runs
-- foreign_key_check before commit, so dropping tables and rebuilding cards /
-- mcp_events does not cascade or leave dangling references.
--
-- Old cards belonged to a repo_mapping that no longer exists and cannot be
-- attached to a board, so they are dropped. This is a pre-1.0 pivot; there is
-- no production card data to preserve.

-- 1. Drop the whole stripped feature set (dependents first is unnecessary with
--    foreign_keys OFF, but the order is kept readable).
DROP VIEW IF EXISTS component_variant_overview;
DROP TABLE IF EXISTS evidence;
DROP TABLE IF EXISTS diff_snapshots;
DROP TABLE IF EXISTS git_operations;
DROP TABLE IF EXISTS command_runs;
DROP TABLE IF EXISTS custom_commands;
DROP TABLE IF EXISTS pending_operations;
DROP TABLE IF EXISTS card_links;
DROP TABLE IF EXISTS component_variants;
DROP TABLE IF EXISTS components;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS repo_mappings;

-- 2. Rebuild mcp_events without its pending_operation_id foreign key (the
--    referenced table is now gone). MCP action logging is retained.
CREATE TABLE mcp_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'applied', 'pending_confirmation', 'rejected', 'failed')),
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);
INSERT INTO mcp_events_new (id, operation, actor, status, request_json, response_json, created_at, applied_at)
SELECT id, operation, actor, status, request_json, response_json, created_at, applied_at FROM mcp_events;
DROP TABLE mcp_events;
ALTER TABLE mcp_events_new RENAME TO mcp_events;
CREATE INDEX IF NOT EXISTS idx_mcp_events_status ON mcp_events(status);
CREATE INDEX IF NOT EXISTS idx_mcp_events_operation ON mcp_events(operation);

-- 3. A board is a git repo the user added.
CREATE TABLE boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. Re-model cards: scoped to a board, carrying a branch. Old cards are dropped
--    (they referenced the removed repo_mapping model).
DROP TABLE IF EXISTS cards;
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'in_progress', 'in_review', 'done')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  branch TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'mcp')),
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_branch ON cards(branch);
