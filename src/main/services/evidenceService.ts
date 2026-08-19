import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { EvidenceDto, EvidenceType, ScanWarning } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';
import { pathExists } from './filesystem';

const SAFE_FILENAME_PATTERN = /[^A-Za-z0-9._-]+/gu;

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename);
  const sanitized = base.replace(SAFE_FILENAME_PATTERN, '_').trim();
  return sanitized.length > 0 ? sanitized : 'evidence-file';
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function findUniqueDestination(destinationDir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);

  let candidate = filename;
  let attempt = 0;

  while (await pathExists(path.join(destinationDir, candidate))) {
    attempt += 1;
    candidate = `${stem}-${attempt}${ext}`;
  }

  return candidate;
}

type ComponentVariantForEvidence = {
  id: number;
  component_id: number;
  mapping_key: string;
  canonical_name: string;
};

type EvidenceRow = {
  id: number;
  component_id: number | null;
  component_variant_id: number | null;
  card_id: number | null;
  type: string;
  title: string;
  original_path: string | null;
  stored_path: string;
  hash_sha256: string | null;
  size_bytes: number | null;
  imported_at: string;
  created_by: string;
};

function mapEvidenceRow(row: EvidenceRow): EvidenceDto {
  return {
    id: row.id,
    componentId: row.component_id,
    componentVariantId: row.component_variant_id,
    cardId: row.card_id,
    type: row.type as EvidenceType,
    title: row.title,
    originalPath: row.original_path,
    storedPath: row.stored_path,
    hashSha256: row.hash_sha256,
    sizeBytes: row.size_bytes,
    importedAt: row.imported_at,
    createdBy: row.created_by,
  };
}

export class EvidenceService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly evidenceRoot: string,
  ) {}

  private getComponentVariant(componentVariantId: number): ComponentVariantForEvidence | undefined {
    return this.db
      .prepare(
        `SELECT cv.id AS id, cv.component_id AS component_id, rm.mapping_key AS mapping_key, c.canonical_name AS canonical_name
         FROM component_variants cv
         JOIN components c ON c.id = cv.component_id
         JOIN repo_mappings rm ON rm.id = cv.repo_mapping_id
         WHERE cv.id = ?`,
      )
      .get(componentVariantId) as ComponentVariantForEvidence | undefined;
  }

  async importFiles(
    componentVariantId: number,
    type: EvidenceType,
    sourceFilePaths: string[],
    createdBy = 'user',
  ): Promise<{ imported: EvidenceDto[]; warnings: ScanWarning[] }> {
    const warnings: ScanWarning[] = [];
    const imported: EvidenceDto[] = [];

    const variant = this.getComponentVariant(componentVariantId);
    if (!variant) {
      return {
        imported,
        warnings: [
          {
            code: 'component_variant_not_found',
            message: `Component variant ${componentVariantId} was not found.`,
          },
        ],
      };
    }

    const destinationDir = path.join(this.evidenceRoot, variant.mapping_key, variant.canonical_name, `variant-${variant.id}`, type);

    for (const sourceFilePath of sourceFilePaths) {
      if (!(await pathExists(sourceFilePath))) {
        warnings.push({
          code: 'evidence_source_missing',
          message: `Evidence source file does not exist: ${sourceFilePath}`,
          path: sourceFilePath,
        });
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(sourceFilePath);
      } catch {
        warnings.push({
          code: 'evidence_source_unreadable',
          message: `Evidence source file could not be read: ${sourceFilePath}`,
          path: sourceFilePath,
        });
        continue;
      }

      if (!fileStat.isFile()) {
        warnings.push({
          code: 'evidence_source_not_a_file',
          message: `Evidence source path is not a file: ${sourceFilePath}`,
          path: sourceFilePath,
        });
        continue;
      }

      try {
        await mkdir(destinationDir, { recursive: true });
        const safeFilename = sanitizeFilename(path.basename(sourceFilePath));
        const uniqueFilename = await findUniqueDestination(destinationDir, safeFilename);
        const destinationPath = path.join(destinationDir, uniqueFilename);

        await copyFile(sourceFilePath, destinationPath);
        const hashSha256 = await hashFile(destinationPath);

        const insertResult = this.db
          .prepare(
            `INSERT INTO evidence (
               component_id, component_variant_id, type, title, original_path, stored_path,
               hash_sha256, size_bytes, created_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            variant.component_id,
            variant.id,
            type,
            uniqueFilename,
            sourceFilePath,
            destinationPath,
            hashSha256,
            fileStat.size,
            createdBy,
          );

        const evidenceId = Number(insertResult.lastInsertRowid);

        this.db
          .prepare("UPDATE component_variants SET latest_evidence_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(evidenceId, variant.id);

        const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId) as EvidenceRow;
        imported.push(mapEvidenceRow(row));
      } catch (error) {
        warnings.push({
          code: 'evidence_import_failed',
          message: `Failed to import evidence file: ${sourceFilePath} (${error instanceof Error ? error.message : String(error)})`,
          path: sourceFilePath,
        });
      }
    }

    return { imported, warnings };
  }

  listEvidence(): EvidenceDto[] {
    const rows = this.db.prepare('SELECT * FROM evidence ORDER BY imported_at DESC, id DESC').all() as EvidenceRow[];
    return rows.map(mapEvidenceRow);
  }

  listEvidenceForVariant(componentVariantId: number): EvidenceDto[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE component_variant_id = ? ORDER BY imported_at DESC, id DESC')
      .all(componentVariantId) as EvidenceRow[];
    return rows.map(mapEvidenceRow);
  }
}
