PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A repo_mapping pairs one source repo with one target repo under a
-- workflow profile's naming convention. For Profile 1 (Roe), this is the
-- dev-repo-to-community-plugins-repo pairing keyed by server/variant name.
CREATE TABLE IF NOT EXISTS repo_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_repo_path TEXT NOT NULL,
  target_repo_path TEXT NOT NULL,
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('inferred', 'manual')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_mapping_id INTEGER NOT NULL REFERENCES repo_mappings(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  remote_url TEXT,
  current_branch TEXT,
  head_sha TEXT,
  dirty_state TEXT CHECK (dirty_state IN ('unknown', 'clean', 'dirty')) DEFAULT 'unknown',
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_mapping_id, role),
  UNIQUE(path)
);

-- A component is the app's unit for scanning, diffing, testing, and
-- release copying. What counts as a component is profile-defined; for
-- Profile 1 (Roe) a component is a plugin root.
CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  descriptor_name TEXT,
  package_hint TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A component_variant is one component within one repo_mapping (i.e. on
-- one source/target pair). For Profile 1 (Roe) this is a plugin variant.
CREATE TABLE IF NOT EXISTS component_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  repo_mapping_id INTEGER NOT NULL REFERENCES repo_mappings(id) ON DELETE CASCADE,
  source_component_root_path TEXT,
  target_component_root_path TEXT,
  source_exists INTEGER NOT NULL DEFAULT 0 CHECK (source_exists IN (0, 1)),
  target_exists INTEGER NOT NULL DEFAULT 0 CHECK (target_exists IN (0, 1)),
  lifecycle_status TEXT NOT NULL DEFAULT 'backlog' CHECK (lifecycle_status IN ('backlog', 'developing', 'untested', 'needs_fix', 'approved', 'released', 'archived')),
  approval_state TEXT NOT NULL DEFAULT 'unknown' CHECK (approval_state IN ('unknown', 'not_approved', 'approved', 'rejected')),
  tested_state TEXT NOT NULL DEFAULT 'unknown' CHECK (tested_state IN ('unknown', 'untested', 'testing', 'passed', 'failed', 'not_applicable')),
  release_state TEXT NOT NULL DEFAULT 'unknown' CHECK (release_state IN ('unknown', 'not_released', 'ready', 'released', 'stale')),
  last_diff_snapshot_id INTEGER,
  latest_evidence_id INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(component_id, repo_mapping_id)
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('component', 'bug', 'task', 'release', 'evidence')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'developing', 'untested', 'needs_fix', 'approved', 'released', 'archived')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  severity TEXT CHECK (severity IN ('none', 'low', 'medium', 'high', 'critical')) DEFAULT 'none',
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  component_variant_id INTEGER REFERENCES component_variants(id) ON DELETE SET NULL,
  repo_mapping_id INTEGER REFERENCES repo_mappings(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'chat', 'recording', 'mcp', 'scan', 'import')),
  created_by TEXT NOT NULL DEFAULT 'user',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  released_at TEXT
);

CREATE TABLE IF NOT EXISTS card_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  target_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('blocks', 'blocked_by', 'duplicates', 'relates_to', 'fixes', 'tests', 'releases')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_card_id, target_card_id, link_type)
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  component_variant_id INTEGER REFERENCES component_variants(id) ON DELETE SET NULL,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('snapshot', 'recording', 'log', 'screenshot', 'note', 'agent_summary', 'other')),
  title TEXT NOT NULL,
  original_path TEXT,
  stored_path TEXT NOT NULL,
  hash_sha256 TEXT,
  size_bytes INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS diff_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_mapping_id INTEGER NOT NULL REFERENCES repo_mappings(id) ON DELETE CASCADE,
  component_variant_id INTEGER REFERENCES component_variants(id) ON DELETE CASCADE,
  source_ref TEXT,
  target_ref TEXT,
  source_path TEXT,
  target_path TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  file_changes_json TEXT NOT NULL DEFAULT '[]',
  descriptor_changes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS command_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  repo_mapping_id INTEGER REFERENCES repo_mappings(id) ON DELETE SET NULL,
  component_variant_id INTEGER REFERENCES component_variants(id) ON DELETE SET NULL,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'build', 'test', 'lint', 'release', 'custom')),
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  exit_code INTEGER,
  stdout_path TEXT,
  stderr_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS git_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  command_run_id INTEGER REFERENCES command_runs(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('status', 'diff', 'fetch', 'pull', 'checkout', 'copy_folder', 'commit', 'push', 'custom')),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0, 1)),
  confirmed_by_user INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_by_user IN (0, 1)),
  before_status_json TEXT NOT NULL DEFAULT '{}',
  after_status_json TEXT NOT NULL DEFAULT '{}',
  preview_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('db_update', 'copy_folder', 'git', 'command', 'delete_file', 'write_file', 'mcp_request')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'applied', 'rejected', 'failed', 'cancelled')),
  requested_by TEXT NOT NULL DEFAULT 'user',
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  preview_json TEXT NOT NULL DEFAULT '{}',
  requires_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (requires_confirmation IN (0, 1)),
  command_run_id INTEGER REFERENCES command_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS custom_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'repo_mapping', 'component_variant')),
  repo_mapping_id INTEGER REFERENCES repo_mappings(id) ON DELETE CASCADE,
  component_variant_id INTEGER REFERENCES component_variants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'build', 'test', 'lint', 'release', 'custom')),
  command TEXT NOT NULL,
  cwd_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'applied', 'pending_confirmation', 'rejected', 'failed')),
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  pending_operation_id INTEGER REFERENCES pending_operations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_repo_mappings_enabled ON repo_mappings(enabled);
CREATE INDEX IF NOT EXISTS idx_repos_mapping_role ON repos(repo_mapping_id, role);

CREATE INDEX IF NOT EXISTS idx_components_display_name ON components(display_name);
CREATE INDEX IF NOT EXISTS idx_component_variants_component ON component_variants(component_id);
CREATE INDEX IF NOT EXISTS idx_component_variants_repo_mapping ON component_variants(repo_mapping_id);
CREATE INDEX IF NOT EXISTS idx_component_variants_status ON component_variants(lifecycle_status, approval_state, tested_state, release_state);

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
CREATE INDEX IF NOT EXISTS idx_cards_component ON cards(component_id);
CREATE INDEX IF NOT EXISTS idx_cards_component_variant ON cards(component_variant_id);
CREATE INDEX IF NOT EXISTS idx_cards_repo_mapping ON cards(repo_mapping_id);
CREATE INDEX IF NOT EXISTS idx_cards_priority ON cards(priority);

CREATE INDEX IF NOT EXISTS idx_evidence_component ON evidence(component_id);
CREATE INDEX IF NOT EXISTS idx_evidence_component_variant ON evidence(component_variant_id);
CREATE INDEX IF NOT EXISTS idx_evidence_card ON evidence(card_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence(type);

CREATE INDEX IF NOT EXISTS idx_diff_snapshots_repo_mapping ON diff_snapshots(repo_mapping_id);
CREATE INDEX IF NOT EXISTS idx_diff_snapshots_variant ON diff_snapshots(component_variant_id);
CREATE INDEX IF NOT EXISTS idx_diff_snapshots_created ON diff_snapshots(created_at);

CREATE INDEX IF NOT EXISTS idx_command_runs_repo ON command_runs(repo_id);
CREATE INDEX IF NOT EXISTS idx_command_runs_card ON command_runs(card_id);
CREATE INDEX IF NOT EXISTS idx_command_runs_kind ON command_runs(kind);

CREATE INDEX IF NOT EXISTS idx_pending_operations_status ON pending_operations(status);
CREATE INDEX IF NOT EXISTS idx_mcp_events_status ON mcp_events(status);
CREATE INDEX IF NOT EXISTS idx_mcp_events_operation ON mcp_events(operation);

CREATE VIEW IF NOT EXISTS component_variant_overview AS
SELECT
  cv.id AS component_variant_id,
  c.id AS component_id,
  c.canonical_name,
  c.display_name AS component_display_name,
  rm.mapping_key,
  rm.display_name AS mapping_display_name,
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
