import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type SqliteDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import {
  AttachmentLimitError,
  AttachmentService,
  AttachmentTooLargeError,
  MAX_ATTACHMENTS_PER_CARD,
} from '../../src/main/services/attachmentService';
import { seedBoard } from './dbFixtures';
import { createTempWorkspace } from './testFixtures';

describe('AttachmentService', () => {
  let db: SqliteDatabase;
  let root: string;
  let cleanup: () => Promise<void>;
  let dir: string;
  let cardId: number;
  let service: AttachmentService;

  beforeEach(async () => {
    ({ root, cleanup } = await createTempWorkspace());
    dir = path.join(root, 'attachments');
    db = createDatabase(':memory:');
    runMigrations(db);
    const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
    cardId = db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'c')").run(boardId).lastInsertRowid as number;
    service = new AttachmentService(db, dir);
  });

  afterEach(async () => {
    db.close();
    await cleanup();
  });

  it('stores a file (temp -> rename -> row) and lists it', async () => {
    const att = await service.createFromBuffer(cardId, 'notes.txt', 'text/plain', Buffer.from('hello world'));
    expect(att.fileName).toBe('notes.txt');
    expect(att.sizeBytes).toBe(11);
    expect(att.cardId).toBe(cardId);

    const list = service.list(cardId);
    expect(list).toHaveLength(1);

    // The on-disk file exists under a random name, and no temp file remains.
    const row = service.getRow(att.id)!;
    expect(row.stored_name).toMatch(/^[a-f0-9]{64}$/u);
    await expect(stat(service.resolveFilePath(row.stored_name))).resolves.toBeTruthy();
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
  });

  it('stores the sanitized display name, never a path', async () => {
    const att = await service.createFromBuffer(cardId, '../../etc/passwd', 'text/plain', Buffer.from('x'));
    expect(att.fileName).not.toContain('/');
    expect(att.fileName).toBe('.._.._etc_passwd');
  });

  it('rejects a file over the size limit (streaming) and leaves no temp file', async () => {
    const huge = Readable.from([Buffer.alloc(26 * 1024 * 1024)]); // 26 MiB > 25 MiB cap
    await expect(service.createFromStream(cardId, 'big.bin', 'application/octet-stream', huge)).rejects.toBeInstanceOf(
      AttachmentTooLargeError,
    );
    expect(service.list(cardId)).toHaveLength(0);
    const entries = await readdir(dir).catch(() => []);
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('enforces the per-card attachment limit', async () => {
    // Insert rows directly up to the cap (fast), then the next add is rejected.
    const insert = db.prepare("INSERT INTO attachments (card_id, original_name, stored_name, mime_type, size_bytes) VALUES (?, 'f', ?, 't', 1)");
    for (let i = 0; i < MAX_ATTACHMENTS_PER_CARD; i += 1) {
      insert.run(cardId, 'a'.repeat(64).replace(/a/g, () => 'abcdef0123456789'[i % 16]).slice(0, 64) + i.toString(16).padStart(0, '0'));
    }
    // Ensure exactly the cap exists.
    const count = (db.prepare('SELECT COUNT(*) n FROM attachments WHERE card_id = ?').get(cardId) as { n: number }).n;
    expect(count).toBeGreaterThanOrEqual(MAX_ATTACHMENTS_PER_CARD);
    await expect(service.createFromBuffer(cardId, 'x.txt', 'text/plain', Buffer.from('x'))).rejects.toBeInstanceOf(
      AttachmentLimitError,
    );
  });

  it('delete removes the row and unlinks the file', async () => {
    const att = await service.createFromBuffer(cardId, 'a.txt', 'text/plain', Buffer.from('data'));
    const stored = service.getRow(att.id)!.stored_name;
    await service.remove(att.id);
    expect(service.list(cardId)).toHaveLength(0);
    await expect(stat(service.resolveFilePath(stored))).rejects.toBeTruthy();
  });

  it('cascades attachment rows when the card is deleted', async () => {
    await service.createFromBuffer(cardId, 'a.txt', 'text/plain', Buffer.from('data'));
    db.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
    expect(service.list(cardId)).toHaveLength(0);
  });

  it('cleanupTempFiles removes only .tmp- entries', async () => {
    await service.createFromBuffer(cardId, 'keep.txt', 'text/plain', Buffer.from('keep'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, '.tmp-orphan'), 'junk');
    await service.cleanupTempFiles();
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
    expect(entries).toHaveLength(1); // the real stored file remains
  });
});
