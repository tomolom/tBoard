import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { AttachmentDto } from '../../shared/api';
import type { SqliteDatabase } from '../db/sqlite';
import {
  generateStoredName,
  resolveStoredPath,
  sanitizeDisplayName,
  tempPathFor,
} from './attachmentStore';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB per file
export const MAX_ATTACHMENTS_PER_CARD = 50;

type AttachmentRow = {
  id: number;
  card_id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  created_by: string;
};

function mapRow(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    cardId: row.card_id,
    fileName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export class AttachmentLimitError extends Error {}
export class AttachmentTooLargeError extends Error {}

/**
 * Stores and serves card attachments. Bytes live on disk under `baseDir`
 * (off-database), each under a random `stored_name`; the DB row is the only
 * mapping from a display name to the file. All path building goes through the
 * containment-checked helpers in attachmentStore.ts.
 */
export class AttachmentService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly baseDir: string,
  ) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  list(cardId: number): AttachmentDto[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE card_id = ? ORDER BY id')
      .all(cardId) as AttachmentRow[];
    return rows.map(mapRow);
  }

  getRow(id: number): AttachmentRow | undefined {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
  }

  /** Absolute on-disk path for an attachment id, containment-checked. */
  resolveFilePath(storedName: string): string {
    return resolveStoredPath(this.baseDir, storedName);
  }

  private assertCardExists(cardId: number): void {
    const card = this.db.prepare('SELECT id FROM cards WHERE id = ?').get(cardId);
    if (!card) {
      throw new Error(`Card ${cardId} was not found.`);
    }
  }

  private assertUnderLimit(cardId: number): void {
    const { n } = this.db.prepare('SELECT COUNT(*) n FROM attachments WHERE card_id = ?').get(cardId) as { n: number };
    if (n >= MAX_ATTACHMENTS_PER_CARD) {
      throw new AttachmentLimitError(`This card already has the maximum of ${MAX_ATTACHMENTS_PER_CARD} attachments.`);
    }
  }

  /**
   * Streams an upload to disk atomically: write to a temp file in the same dir
   * (enforcing the byte cap mid-stream), rename to the random final name, then
   * insert the row. Any failure unlinks the temp file and throws. Returns the
   * created attachment metadata.
   */
  async createFromStream(
    cardId: number,
    originalName: string,
    mimeType: string,
    source: Readable,
    createdBy = 'user',
  ): Promise<AttachmentDto> {
    this.assertCardExists(cardId);
    this.assertUnderLimit(cardId);
    await this.ensureDir();

    const storedName = generateStoredName();
    const tempPath = tempPathFor(this.baseDir, storedName);
    const finalPath = resolveStoredPath(this.baseDir, storedName);

    let bytes = 0;
    let tooLarge = false;
    // Enforce the size cap while streaming, aborting early on overflow.
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_ATTACHMENT_BYTES) {
        tooLarge = true;
        source.destroy(new AttachmentTooLargeError('Attachment exceeds the size limit.'));
      }
    });

    try {
      await pipeline(source, createWriteStream(tempPath));
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      if (tooLarge || error instanceof AttachmentTooLargeError) {
        throw new AttachmentTooLargeError(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
      }
      throw error;
    }

    try {
      await rename(tempPath, finalPath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }

    try {
      const result = this.db
        .prepare(
          `INSERT INTO attachments (card_id, original_name, stored_name, mime_type, size_bytes, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(cardId, sanitizeDisplayName(originalName), storedName, mimeType || 'application/octet-stream', bytes, createdBy);
      return mapRow(this.getRow(Number(result.lastInsertRowid))!);
    } catch (error) {
      // Row insert failed → don't leave an orphan file.
      await unlink(finalPath).catch(() => undefined);
      throw error;
    }
  }

  /** Convenience for the Electron path: store from an in-memory buffer. */
  async createFromBuffer(cardId: number, originalName: string, mimeType: string, data: Buffer, createdBy = 'user'): Promise<AttachmentDto> {
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
    }
    this.assertCardExists(cardId);
    this.assertUnderLimit(cardId);
    await this.ensureDir();
    const storedName = generateStoredName();
    const finalPath = resolveStoredPath(this.baseDir, storedName);
    const tempPath = tempPathFor(this.baseDir, storedName);
    await writeFile(tempPath, data);
    try {
      await rename(tempPath, finalPath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    try {
      const result = this.db
        .prepare(
          `INSERT INTO attachments (card_id, original_name, stored_name, mime_type, size_bytes, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(cardId, sanitizeDisplayName(originalName), storedName, mimeType || 'application/octet-stream', data.length, createdBy);
      return mapRow(this.getRow(Number(result.lastInsertRowid))!);
    } catch (error) {
      await unlink(finalPath).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes the row first, then unlinks the file (best-effort). */
  async remove(id: number): Promise<void> {
    const row = this.getRow(id);
    if (!row) {
      return;
    }
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    try {
      await unlink(resolveStoredPath(this.baseDir, row.stored_name));
    } catch {
      // File already gone or unreadable — the row is what matters.
    }
  }

  /**
   * Removes stale temp files (from crashed uploads). Called at startup. Only
   * touches `.tmp-*` entries in the attachments dir.
   */
  async cleanupTempFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return; // dir doesn't exist yet
    }
    await Promise.all(
      entries
        .filter((name) => name.startsWith('.tmp-'))
        .map((name) => rm(path.join(this.baseDir, name), { force: true }).catch(() => undefined)),
    );
  }

  /** Deletes every file for a card's attachments (used before card delete if needed). */
  async removeAllForCard(cardId: number): Promise<void> {
    const rows = this.db.prepare('SELECT stored_name FROM attachments WHERE card_id = ?').all(cardId) as Array<{ stored_name: string }>;
    for (const row of rows) {
      await unlink(resolveStoredPath(this.baseDir, row.stored_name)).catch(() => undefined);
    }
  }

  async fileExists(storedName: string): Promise<boolean> {
    try {
      await stat(resolveStoredPath(this.baseDir, storedName));
      return true;
    } catch {
      return false;
    }
  }
}
