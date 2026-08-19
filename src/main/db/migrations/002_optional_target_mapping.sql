-- Migration 002: make the dev->release (source->target) mapping OPTIONAL.
--
-- Before this, repo_mappings required BOTH source_repo_path and
-- target_repo_path (NOT NULL), so a single-repo project (no release target)
-- could not be represented. This rebuilds repo_mappings to:
--   * add mapping_kind ('single' | 'source_target')
--   * make target_repo_path nullable
-- Existing rows are all real source->target Roe pairs, so they become
-- 'source_target' with both paths preserved.
--
-- SQLite cannot relax a NOT NULL constraint in place, so this uses the standard
-- table-rebuild (new table / copy / drop / rename). The migration runner turns
-- foreign_keys OFF around each migration and runs foreign_key_check before
-- commit, so dropping the old table does not cascade into child rows and the
-- rebuilt table (same name, same ids) keeps every existing reference valid.
--
-- The primary repo of a 'single' mapping is stored under repos.role = 'source'
-- (the source IS the repo you work in; target is the optional release dest), so
-- repos and RepoRole need no change.

-- Drop the dependent view first: SQLite refuses to DROP TABLE repo_mappings
-- while a view still references it. It is recreated (with mapping_kind) below.
DROP VIEW IF EXISTS component_variant_overview;

CREATE TABLE repo_mappings_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  mapping_kind TEXT NOT NULL DEFAULT 'source_target' CHECK (mapping_kind IN ('single', 'source_target')),
  source_repo_path TEXT NOT NULL,
  target_repo_path TEXT,
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('inferred', 'manual')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- A single-repo mapping has no target; a source_target mapping must have one.
  CHECK (
    (mapping_kind = 'single' AND target_repo_path IS NULL) OR
    (mapping_kind = 'source_target' AND target_repo_path IS NOT NULL)
  )
);

-- Copy every existing mapping as a source_target pair, preserving id so all
-- child foreign keys (repos, component_variants, diff_snapshots, cards,
-- command_runs, custom_commands) remain valid after the rename.
INSERT INTO repo_mappings_new (
  id, mapping_key, display_name, mapping_kind, source_repo_path, target_repo_path,
  mapping_source, enabled, last_scanned_at, created_at, updated_at
)
SELECT
  id, mapping_key, display_name, 'source_target', source_repo_path, target_repo_path,
  mapping_source, enabled, last_scanned_at, created_at, updated_at
FROM repo_mappings;

DROP TABLE repo_mappings;
ALTER TABLE repo_mappings_new RENAME TO repo_mappings;

CREATE INDEX IF NOT EXISTS idx_repo_mappings_enabled ON repo_mappings(enabled);

-- Recreate the overview view (dropped above) to surface mapping_kind so
-- consumers can tell a single-repo mapping (target N/A) from a source_target
-- mapping with a genuinely missing target.
CREATE VIEW component_variant_overview AS
SELECT
  cv.id AS component_variant_id,
  c.id AS component_id,
  c.canonical_name,
  c.display_name AS component_display_name,
  rm.mapping_key,
  rm.display_name AS mapping_display_name,
  rm.mapping_kind,
  cv.source_exists,
  cv.target_exists,
  cv.lifecycle_status,
  cv.approval_state,
  cv.tested_state,
  cv.release_state,
  cv.source_component_root_path,
  cv.target_component_root_path,
  cv.last_diff_snapshot_id,
  cv.latest_evidence_id,
  (
    SELECT COUNT(*)
    FROM cards ca
    WHERE ca.component_variant_id = cv.id
      AND ca.type = 'bug'
      AND ca.status NOT IN ('released', 'archived')
  ) AS open_bug_count,
  (
    SELECT COUNT(*)
    FROM evidence e
    WHERE e.component_variant_id = cv.id
  ) AS evidence_count
FROM component_variants cv
JOIN components c ON c.id = cv.component_id
JOIN repo_mappings rm ON rm.id = cv.repo_mapping_id;
