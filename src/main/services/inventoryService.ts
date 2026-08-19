import path from 'node:path';

import type { ComponentVariantOverviewDto, MappingKind, RepoMappingDto, ScanResult, ScanWarning } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';
import { detectProfile, getProfile, isProfileId, type WorkflowProfile } from '../profiles';
import type { ComponentCandidate, RepoMappingCandidate } from '../profiles/types';
import { SettingsService } from './settingsService';

type RowId = { id: number };

function nowIso(): string {
  return new Date().toISOString();
}

function upsertRepoMapping(db: SqliteDatabase, mapping: RepoMappingCandidate, scannedAt: string): number {
  db.prepare(
    `INSERT INTO repo_mappings (
       mapping_key, display_name, mapping_kind, source_repo_path, target_repo_path,
       mapping_source, enabled, last_scanned_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'inferred', ?, ?, datetime('now'))
     ON CONFLICT(mapping_key) DO UPDATE SET
       display_name = excluded.display_name,
       mapping_kind = excluded.mapping_kind,
       source_repo_path = excluded.source_repo_path,
       target_repo_path = excluded.target_repo_path,
       enabled = excluded.enabled,
       last_scanned_at = excluded.last_scanned_at,
       updated_at = datetime('now')`,
  ).run(
    mapping.mappingKey,
    mapping.displayName,
    mapping.mappingKind,
    mapping.sourceRepoPath,
    mapping.targetRepoPath,
    mapping.enabled ? 1 : 0,
    scannedAt,
  );

  return (db.prepare('SELECT id FROM repo_mappings WHERE mapping_key = ?').get(mapping.mappingKey) as RowId).id;
}

function upsertRepo(db: SqliteDatabase, repoMappingId: number, role: 'source' | 'target', repoPath: string, scannedAt: string): number {
  db.prepare(
    `INSERT INTO repos (repo_mapping_id, role, name, path, last_scanned_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo_mapping_id, role) DO UPDATE SET
       name = excluded.name,
       path = excluded.path,
       last_scanned_at = excluded.last_scanned_at,
       updated_at = datetime('now')`,
  ).run(repoMappingId, role, path.basename(repoPath), repoPath, scannedAt);

  return (db.prepare('SELECT id FROM repos WHERE repo_mapping_id = ? AND role = ?').get(repoMappingId, role) as RowId).id;
}

function upsertComponent(db: SqliteDatabase, candidate: ComponentCandidate, profileTag: string): number {
  db.prepare(
    `INSERT INTO components (canonical_name, display_name, descriptor_name, package_hint, metadata_json, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(canonical_name) DO UPDATE SET
       display_name = excluded.display_name,
       descriptor_name = excluded.descriptor_name,
       package_hint = excluded.package_hint,
       metadata_json = excluded.metadata_json,
       updated_at = datetime('now')`,
  ).run(
    candidate.canonicalName,
    candidate.displayName,
    candidate.descriptorName,
    candidate.packageHint,
    JSON.stringify({ profile: profileTag, rootName: candidate.rootName, descriptorPath: candidate.descriptorPath }),
  );

  return (db.prepare('SELECT id FROM components WHERE canonical_name = ?').get(candidate.canonicalName) as RowId).id;
}

function upsertComponentVariant(
  db: SqliteDatabase,
  componentId: number,
  repoMappingId: number,
  source: ComponentCandidate | undefined,
  target: ComponentCandidate | undefined,
): number {
  db.prepare(
    `INSERT INTO component_variants (
       component_id, repo_mapping_id, source_component_root_path, target_component_root_path,
       source_exists, target_exists, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(component_id, repo_mapping_id) DO UPDATE SET
       source_component_root_path = excluded.source_component_root_path,
       target_component_root_path = excluded.target_component_root_path,
       source_exists = excluded.source_exists,
       target_exists = excluded.target_exists,
       updated_at = datetime('now')`,
  ).run(componentId, repoMappingId, source?.rootPath ?? null, target?.rootPath ?? null, source ? 1 : 0, target ? 1 : 0);

  return (
    db.prepare('SELECT id FROM component_variants WHERE component_id = ? AND repo_mapping_id = ?').get(componentId, repoMappingId) as RowId
  ).id;
}

function mapComponentByCanonical(components: ComponentCandidate[]): Map<string, ComponentCandidate> {
  const map = new Map<string, ComponentCandidate>();
  for (const component of components) {
    map.set(component.canonicalName, component);
  }
  return map;
}

export class InventoryService {
  private readonly settings: SettingsService;

  constructor(private readonly db: SqliteDatabase) {
    this.settings = new SettingsService(db);
  }

  /**
   * Resolves the workflow profile: an explicit `activeProfile` app setting wins,
   * otherwise auto-detect (Roe if its repos are present, else generic).
   */
  private async resolveProfile(workspaceRoot: string): Promise<WorkflowProfile> {
    const configured = this.settings.getActiveProfile();
    if (configured && isProfileId(configured)) {
      return getProfile(configured);
    }
    return detectProfile(workspaceRoot);
  }

  async scanWorkspace(workspaceRootOverride?: string): Promise<ScanResult> {
    const workspaceRoot = workspaceRootOverride ?? this.settings.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        repoMappingsFound: 0,
        reposFound: 0,
        componentsFound: 0,
        componentVariantsFound: 0,
        warnings: [{ code: 'workspace_root_not_configured', message: 'Workspace root is not configured.' }],
      };
    }

    this.settings.setWorkspaceRoot(workspaceRoot);
    const scannedAt = nowIso();
    const warnings: ScanWarning[] = [];
    const profile = await this.resolveProfile(workspaceRoot);
    const repoScan = await profile.scanRepoMappings(workspaceRoot);
    warnings.push(...repoScan.warnings);

    let reposFound = 0;
    const seenComponents = new Set<string>();
    let componentVariantsFound = 0;

    for (const mapping of repoScan.mappings) {
      const repoMappingId = upsertRepoMapping(this.db, mapping, scannedAt);
      if (mapping.sourceExists) {
        upsertRepo(this.db, repoMappingId, 'source', mapping.sourceRepoPath, scannedAt);
        reposFound += 1;
      }
      if (mapping.targetExists && mapping.targetRepoPath) {
        upsertRepo(this.db, repoMappingId, 'target', mapping.targetRepoPath, scannedAt);
        reposFound += 1;
      }

      const sourceScan = mapping.sourceExists
        ? await profile.scanComponents(mapping.sourceRepoPath, { role: 'source', mappingKey: mapping.mappingKey })
        : { components: [], warnings: [] };
      const targetScan =
        mapping.targetExists && mapping.targetRepoPath
          ? await profile.scanComponents(mapping.targetRepoPath, { role: 'target', mappingKey: mapping.mappingKey })
          : { components: [], warnings: [] };
      warnings.push(...sourceScan.warnings, ...targetScan.warnings);

      const sourceByCanonical = mapComponentByCanonical(sourceScan.components);
      const targetByCanonical = mapComponentByCanonical(targetScan.components);
      const canonicalNames = new Set([...sourceByCanonical.keys(), ...targetByCanonical.keys()]);

      for (const canonicalName of canonicalNames) {
        const source = sourceByCanonical.get(canonicalName);
        const target = targetByCanonical.get(canonicalName);
        const candidate = source ?? target;
        if (!candidate) {
          continue;
        }

        const componentId = upsertComponent(this.db, candidate, profile.profileTag);
        seenComponents.add(canonicalName);
        upsertComponentVariant(this.db, componentId, repoMappingId, source, target);
        componentVariantsFound += 1;
      }
    }

    return {
      repoMappingsFound: repoScan.mappings.length,
      reposFound,
      componentsFound: seenComponents.size,
      componentVariantsFound,
      warnings,
    };
  }

  listRepoMappings(): RepoMappingDto[] {
    const rows = this.db
      .prepare(
        `SELECT id, mapping_key, display_name, mapping_kind, source_repo_path, target_repo_path, enabled, last_scanned_at
         FROM repo_mappings
         ORDER BY mapping_key`,
      )
      .all() as Array<{
      id: number;
      mapping_key: string;
      display_name: string;
      mapping_kind: MappingKind;
      source_repo_path: string;
      target_repo_path: string | null;
      enabled: number;
      last_scanned_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      mappingKey: row.mapping_key,
      displayName: row.display_name,
      mappingKind: row.mapping_kind,
      sourceRepoPath: row.source_repo_path,
      targetRepoPath: row.target_repo_path,
      enabled: row.enabled === 1,
      lastScannedAt: row.last_scanned_at,
    }));
  }

  listComponentVariants(): ComponentVariantOverviewDto[] {
    const rows = this.db.prepare('SELECT * FROM component_variant_overview ORDER BY mapping_key, component_display_name').all() as Array<{
      component_variant_id: number;
      component_id: number;
      canonical_name: string;
      component_display_name: string;
      mapping_key: string;
      mapping_display_name: string;
      mapping_kind: MappingKind;
      source_exists: number;
      target_exists: number;
      lifecycle_status: string;
      approval_state: string;
      tested_state: string;
      release_state: string;
      source_component_root_path: string | null;
      target_component_root_path: string | null;
      open_bug_count: number;
      evidence_count: number;
    }>;

    return rows.map((row) => ({
      componentVariantId: row.component_variant_id,
      componentId: row.component_id,
      canonicalName: row.canonical_name,
      componentDisplayName: row.component_display_name,
      mappingKey: row.mapping_key,
      mappingDisplayName: row.mapping_display_name,
      mappingKind: row.mapping_kind,
      sourceExists: row.source_exists === 1,
      targetExists: row.target_exists === 1,
      lifecycleStatus: row.lifecycle_status,
      approvalState: row.approval_state,
      testedState: row.tested_state,
      releaseState: row.release_state,
      sourceComponentRootPath: row.source_component_root_path,
      targetComponentRootPath: row.target_component_root_path,
      openBugCount: row.open_bug_count,
      evidenceCount: row.evidence_count,
    }));
  }
}
