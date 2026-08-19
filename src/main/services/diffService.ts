import type { DiffFileChange, DiffOverviewDto, DiffScanResult, DiffSnapshotSummary, MappingKind, ScanWarning } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';
import { isDirectory } from './filesystem';
import { walkHashedFileTree } from './folderTree';

function classifyFiles(sourceFiles: Map<string, string>, targetFiles: Map<string, string>): DiffFileChange[] {
  const allPaths = new Set([...sourceFiles.keys(), ...targetFiles.keys()]);
  const changes: DiffFileChange[] = [];

  for (const relativePath of allPaths) {
    const sourceHash = sourceFiles.get(relativePath);
    const targetHash = targetFiles.get(relativePath);

    let status: DiffFileChange['status'];
    if (sourceHash !== undefined && targetHash === undefined) {
      status = 'added';
    } else if (sourceHash === undefined && targetHash !== undefined) {
      status = 'deleted';
    } else if (sourceHash !== targetHash) {
      status = 'modified';
    } else {
      status = 'unchanged';
    }

    changes.push({ path: relativePath, status });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function countByStatus(changes: DiffFileChange[], status: DiffFileChange['status']): number {
  return changes.filter((change) => change.status === status).length;
}

function nowIso(): string {
  return new Date().toISOString();
}

type ComponentVariantForDiff = {
  id: number;
  repo_mapping_id: number;
  source_component_root_path: string | null;
  target_component_root_path: string | null;
};

type DiffOverviewRow = {
  component_variant_id: number;
  component_id: number;
  canonical_name: string;
  component_display_name: string;
  mapping_key: string;
  mapping_display_name: string;
  mapping_kind: MappingKind;
  source_component_root_path: string | null;
  target_component_root_path: string | null;
  diff_snapshot_id: number | null;
  created_at: string | null;
  summary_json: string | null;
};

export class DiffService {
  constructor(private readonly db: SqliteDatabase) {}

  async scanDiffs(): Promise<DiffScanResult> {
    const warnings: ScanWarning[] = [];
    // Diff is inherently source-vs-target, so only variants under a
    // source_target mapping are scanned. Single-repo (no target) variants are
    // skipped entirely rather than producing spurious "target missing" warnings.
    const variants = this.db
      .prepare(
        `SELECT cv.id, cv.repo_mapping_id, cv.source_component_root_path, cv.target_component_root_path
         FROM component_variants cv
         JOIN repo_mappings rm ON rm.id = cv.repo_mapping_id
         WHERE rm.mapping_kind = 'source_target'
         ORDER BY cv.id`,
      )
      .all() as ComponentVariantForDiff[];

    let diffSnapshotsCreated = 0;
    let addedFilesTotal = 0;
    let modifiedFilesTotal = 0;
    let deletedFilesTotal = 0;

    for (const variant of variants) {
      const sourcePath = variant.source_component_root_path;
      const targetPath = variant.target_component_root_path;

      let sourceFiles = new Map<string, string>();
      let targetFiles = new Map<string, string>();

      if (!sourcePath) {
        warnings.push({
          code: 'source_root_missing',
          message: `Component variant ${variant.id} has no source component root path.`,
        });
      } else if (!(await isDirectory(sourcePath))) {
        warnings.push({
          code: 'source_root_not_found',
          message: `Source component root path does not exist for component variant ${variant.id}.`,
          path: sourcePath,
        });
      } else {
        sourceFiles = await walkHashedFileTree(sourcePath);
      }

      if (!targetPath) {
        warnings.push({
          code: 'target_root_missing',
          message: `Component variant ${variant.id} has no target component root path.`,
        });
      } else if (!(await isDirectory(targetPath))) {
        warnings.push({
          code: 'target_root_not_found',
          message: `Target component root path does not exist for component variant ${variant.id}.`,
          path: targetPath,
        });
      } else {
        targetFiles = await walkHashedFileTree(targetPath);
      }

      const fileChanges = classifyFiles(sourceFiles, targetFiles);
      const addedCount = countByStatus(fileChanges, 'added');
      const deletedCount = countByStatus(fileChanges, 'deleted');
      const modifiedCount = countByStatus(fileChanges, 'modified');
      const unchangedCount = countByStatus(fileChanges, 'unchanged');

      const summary: DiffSnapshotSummary = {
        addedCount,
        deletedCount,
        modifiedCount,
        unchangedCount,
        sourceFileCount: sourceFiles.size,
        targetFileCount: targetFiles.size,
        scannedAt: nowIso(),
      };

      const insertResult = this.db
        .prepare(
          `INSERT INTO diff_snapshots (
             repo_mapping_id, component_variant_id, source_path, target_path,
             summary_json, file_changes_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(variant.repo_mapping_id, variant.id, sourcePath, targetPath, JSON.stringify(summary), JSON.stringify(fileChanges));

      const diffSnapshotId = Number(insertResult.lastInsertRowid);

      this.db.prepare("UPDATE component_variants SET last_diff_snapshot_id = ?, updated_at = datetime('now') WHERE id = ?").run(diffSnapshotId, variant.id);

      diffSnapshotsCreated += 1;
      addedFilesTotal += addedCount;
      modifiedFilesTotal += modifiedCount;
      deletedFilesTotal += deletedCount;
    }

    return {
      componentVariantsScanned: variants.length,
      diffSnapshotsCreated,
      addedFilesTotal,
      modifiedFilesTotal,
      deletedFilesTotal,
      warnings,
    };
  }

  listDiffOverviews(): DiffOverviewDto[] {
    const rows = this.db
      .prepare(
        `SELECT
           cv.id AS component_variant_id,
           c.id AS component_id,
           c.canonical_name,
           c.display_name AS component_display_name,
           rm.mapping_key,
           rm.display_name AS mapping_display_name,
           rm.mapping_kind,
           cv.source_component_root_path,
           cv.target_component_root_path,
           ds.id AS diff_snapshot_id,
           ds.created_at,
           ds.summary_json
         FROM component_variants cv
         JOIN components c ON c.id = cv.component_id
         JOIN repo_mappings rm ON rm.id = cv.repo_mapping_id
         LEFT JOIN diff_snapshots ds ON ds.id = cv.last_diff_snapshot_id
         WHERE rm.mapping_kind = 'source_target'
         ORDER BY rm.mapping_key, c.display_name`,
      )
      .all() as DiffOverviewRow[];

    return rows.map((row) => {
      const summary = row.summary_json ? (JSON.parse(row.summary_json) as Partial<DiffSnapshotSummary>) : null;
      return {
        componentVariantId: row.component_variant_id,
        componentId: row.component_id,
        canonicalName: row.canonical_name,
        componentDisplayName: row.component_display_name,
        mappingKey: row.mapping_key,
        mappingDisplayName: row.mapping_display_name,
        mappingKind: row.mapping_kind,
        diffSnapshotId: row.diff_snapshot_id,
        createdAt: row.created_at,
        addedCount: summary?.addedCount ?? 0,
        deletedCount: summary?.deletedCount ?? 0,
        modifiedCount: summary?.modifiedCount ?? 0,
        unchangedCount: summary?.unchangedCount ?? 0,
        sourceComponentRootPath: row.source_component_root_path,
        targetComponentRootPath: row.target_component_root_path,
      };
    });
  }
}
