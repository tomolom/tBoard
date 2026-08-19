import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  MappingKind,
  ReleaseCopyApplyResult,
  ReleaseCopyFileEntry,
  ReleaseCopyPreviewResult,
  ReleaseCopyPreviewSummary,
  ScanWarning,
} from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';
import { isDirectory } from './filesystem';
import { fromRelativePosix, walkHashedFileTree } from './folderTree';

function nowIso(): string {
  return new Date().toISOString();
}

type ComponentVariantForCopy = {
  id: number;
  repo_mapping_id: number;
  source_component_root_path: string | null;
  target_component_root_path: string | null;
  mapping_kind: MappingKind;
};

type PendingOperationRow = {
  id: number;
  kind: string;
  status: string;
  payload_json: string;
};

type CopyPayload = {
  componentVariantId: number;
  sourceRoot: string;
  targetRoot: string;
  filesToCopy: ReleaseCopyFileEntry[];
  targetOnlyPreserved: string[];
};

export class ReleaseCopyService {
  constructor(private readonly db: SqliteDatabase) {}

  private getComponentVariant(componentVariantId: number): ComponentVariantForCopy | undefined {
    return this.db
      .prepare(
        `SELECT cv.id, cv.repo_mapping_id, cv.source_component_root_path, cv.target_component_root_path,
                rm.mapping_kind
         FROM component_variants cv
         JOIN repo_mappings rm ON rm.id = cv.repo_mapping_id
         WHERE cv.id = ?`,
      )
      .get(componentVariantId) as ComponentVariantForCopy | undefined;
  }

  async previewCopy(componentVariantId: number): Promise<ReleaseCopyPreviewResult> {
    const warnings: ScanWarning[] = [];

    const variant = this.getComponentVariant(componentVariantId);
    if (!variant) {
      return {
        pendingOperationId: null,
        componentVariantId,
        summary: null,
        warnings: [
          {
            code: 'component_variant_not_found',
            message: `Component variant ${componentVariantId} was not found.`,
          },
        ],
      };
    }

    // Release copy is inherently source->target. A single-repo mapping has no
    // target, so this is not an error — it simply does not apply.
    if (variant.mapping_kind === 'single') {
      return {
        pendingOperationId: null,
        componentVariantId,
        summary: null,
        warnings: [
          {
            code: 'release_not_applicable',
            message: `Component variant ${componentVariantId} is in a single-repo project with no release target; release copy does not apply.`,
          },
        ],
      };
    }

    const sourceRoot = variant.source_component_root_path;
    const targetRoot = variant.target_component_root_path;

    if (!sourceRoot) {
      warnings.push({
        code: 'source_root_missing',
        message: `Component variant ${componentVariantId} has no source component root path.`,
      });
    } else if (!(await isDirectory(sourceRoot))) {
      warnings.push({
        code: 'source_root_not_found',
        message: `Source component root path does not exist for component variant ${componentVariantId}.`,
        path: sourceRoot,
      });
    }

    if (!targetRoot) {
      warnings.push({
        code: 'target_root_missing',
        message: `Component variant ${componentVariantId} has no target component root path.`,
      });
    } else if (!(await isDirectory(targetRoot))) {
      warnings.push({
        code: 'target_root_not_found',
        message: `Target component root path does not exist for component variant ${componentVariantId}.`,
        path: targetRoot,
      });
    }

    if (!sourceRoot || !targetRoot || warnings.length > 0) {
      return {
        pendingOperationId: null,
        componentVariantId,
        summary: null,
        warnings,
      };
    }

    const sourceFiles = await walkHashedFileTree(sourceRoot);
    const targetFiles = await walkHashedFileTree(targetRoot);

    const filesToCopy: ReleaseCopyFileEntry[] = [];
    const targetOnlyPreserved: string[] = [];
    let unchangedCount = 0;

    for (const [relativePath, sourceHash] of sourceFiles) {
      const targetHash = targetFiles.get(relativePath);
      if (targetHash === undefined) {
        filesToCopy.push({ path: relativePath, status: 'added' });
      } else if (targetHash !== sourceHash) {
        filesToCopy.push({ path: relativePath, status: 'modified' });
      } else {
        unchangedCount += 1;
      }
    }

    for (const relativePath of targetFiles.keys()) {
      if (!sourceFiles.has(relativePath)) {
        targetOnlyPreserved.push(relativePath);
      }
    }

    filesToCopy.sort((a, b) => a.path.localeCompare(b.path));
    targetOnlyPreserved.sort((a, b) => a.localeCompare(b));

    const addedCount = filesToCopy.filter((entry) => entry.status === 'added').length;
    const modifiedCount = filesToCopy.filter((entry) => entry.status === 'modified').length;

    const summary: ReleaseCopyPreviewSummary = {
      filesToCopyCount: filesToCopy.length,
      addedCount,
      modifiedCount,
      targetOnlyPreservedCount: targetOnlyPreserved.length,
      unchangedCount,
      scannedAt: nowIso(),
    };

    const payload: CopyPayload = {
      componentVariantId,
      sourceRoot,
      targetRoot,
      filesToCopy,
      targetOnlyPreserved,
    };

    const previewJson = {
      componentVariantId,
      sourceRoot,
      targetRoot,
      filesToCopy,
      targetOnlyPreserved,
      summary,
    };

    const insertResult = this.db
      .prepare(
        `INSERT INTO pending_operations (
           kind, status, requested_by, summary, payload_json, preview_json, requires_confirmation
         ) VALUES ('copy_folder', 'pending', 'user', ?, ?, ?, 1)`,
      )
      .run(
        `Copy ${filesToCopy.length} file(s) from source to target for component variant ${componentVariantId} (${addedCount} added, ${modifiedCount} modified); ${targetOnlyPreserved.length} target-only file(s) preserved.`,
        JSON.stringify(payload),
        JSON.stringify(previewJson),
      );

    const pendingOperationId = Number(insertResult.lastInsertRowid);

    return {
      pendingOperationId,
      componentVariantId,
      summary,
      warnings,
    };
  }

  async applyCopy(pendingOperationId: number): Promise<ReleaseCopyApplyResult> {
    const warnings: ScanWarning[] = [];

    const operation = this.db.prepare('SELECT id, kind, status, payload_json FROM pending_operations WHERE id = ?').get(pendingOperationId) as
      | PendingOperationRow
      | undefined;

    if (!operation) {
      return {
        pendingOperationId,
        applied: false,
        copiedCount: 0,
        warnings: [
          {
            code: 'pending_operation_not_found',
            message: `Pending operation ${pendingOperationId} was not found.`,
          },
        ],
      };
    }

    if (operation.kind !== 'copy_folder') {
      return {
        pendingOperationId,
        applied: false,
        copiedCount: 0,
        warnings: [
          {
            code: 'pending_operation_wrong_kind',
            message: `Pending operation ${pendingOperationId} has kind '${operation.kind}', expected 'copy_folder'.`,
          },
        ],
      };
    }

    if (operation.status !== 'pending' && operation.status !== 'confirmed') {
      return {
        pendingOperationId,
        applied: false,
        copiedCount: 0,
        warnings: [
          {
            code: 'pending_operation_invalid_status',
            message: `Pending operation ${pendingOperationId} has status '${operation.status}', which cannot be applied.`,
          },
        ],
      };
    }

    let payload: CopyPayload;
    try {
      payload = JSON.parse(operation.payload_json) as CopyPayload;
    } catch {
      return {
        pendingOperationId,
        applied: false,
        copiedCount: 0,
        warnings: [
          {
            code: 'pending_operation_payload_invalid',
            message: `Pending operation ${pendingOperationId} has an unparseable payload.`,
          },
        ],
      };
    }

    if (!(await isDirectory(payload.sourceRoot))) {
      warnings.push({
        code: 'source_root_not_found',
        message: `Source component root path does not exist for pending operation ${pendingOperationId}.`,
        path: payload.sourceRoot,
      });
    }

    if (!(await isDirectory(payload.targetRoot))) {
      warnings.push({
        code: 'target_root_not_found',
        message: `Target component root path does not exist for pending operation ${pendingOperationId}.`,
        path: payload.targetRoot,
      });
    }

    if (warnings.length > 0) {
      return {
        pendingOperationId,
        applied: false,
        copiedCount: 0,
        warnings,
      };
    }

    let copiedCount = 0;

    for (const entry of payload.filesToCopy) {
      const sourceFilePath = fromRelativePosix(payload.sourceRoot, entry.path);
      const targetFilePath = fromRelativePosix(payload.targetRoot, entry.path);

      try {
        await mkdir(path.dirname(targetFilePath), { recursive: true });
        await copyFile(sourceFilePath, targetFilePath);
        copiedCount += 1;
      } catch (error) {
        warnings.push({
          code: 'copy_failed',
          message: `Failed to copy file '${entry.path}': ${error instanceof Error ? error.message : String(error)}`,
          path: entry.path,
        });
      }
    }

    const finalStatus = warnings.length > 0 ? 'failed' : 'applied';
    this.db.prepare('UPDATE pending_operations SET status = ?, applied_at = datetime(\'now\') WHERE id = ?').run(finalStatus, pendingOperationId);

    return {
      pendingOperationId,
      applied: warnings.length === 0,
      copiedCount,
      warnings,
    };
  }
}
