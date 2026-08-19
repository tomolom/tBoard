import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { CardService } from '../../src/main/services/cardService';
import { seedBoard } from './dbFixtures';

function freshDb() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('CardService', () => {
  it('creates a card on a board with defaults and an optional branch', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { name: 'app', repoPath: '/repos/app' });
      const service = new CardService(db);
      const card = service.createCard({ boardId, title: 'Add login', branch: 'feature/login' });

      expect(card.boardId).toBe(boardId);
      expect(card.title).toBe('Add login');
      expect(card.branch).toBe('feature/login');
      expect(card.status).toBe('backlog');
      expect(card.priority).toBe('normal');
      expect(card.source).toBe('manual');
      expect(card.createdBy).toBe('user');
      expect(card.completedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('normalizes an empty branch to null', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const card = service.createCard({ boardId, title: 'No branch', branch: '   ' });
      expect(card.branch).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects a card for a non-existent board', () => {
    const db = freshDb();
    try {
      const service = new CardService(db);
      expect(() => service.createCard({ boardId: 999, title: 'orphan' })).toThrow(/Board 999/);
    } finally {
      db.close();
    }
  });

  it('requires a non-empty title', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      expect(() => service.createCard({ boardId, title: '   ' })).toThrow(/title/i);
    } finally {
      db.close();
    }
  });

  it('lists only the cards for a given board, ordered by status', () => {
    const db = freshDb();
    try {
      const boardA = seedBoard(db, { name: 'a', repoPath: '/repos/a' }).boardId;
      const boardB = seedBoard(db, { name: 'b', repoPath: '/repos/b' }).boardId;
      const service = new CardService(db);

      service.createCard({ boardId: boardA, title: 'A done', status: 'done' });
      service.createCard({ boardId: boardA, title: 'A backlog', status: 'backlog' });
      service.createCard({ boardId: boardB, title: 'B card' });

      const aCards = service.listCards(boardA);
      expect(aCards.map((c) => c.title)).toEqual(['A backlog', 'A done']);
      expect(service.listCards(boardB).map((c) => c.title)).toEqual(['B card']);
    } finally {
      db.close();
    }
  });

  it('updates title, priority, branch, and status; sets completed_at on done', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const card = service.createCard({ boardId, title: 'Original' });

      const updated = service.updateCard(card.id, {
        title: 'Renamed',
        priority: 'high',
        branch: 'main',
        status: 'done',
      });
      expect(updated.title).toBe('Renamed');
      expect(updated.priority).toBe('high');
      expect(updated.branch).toBe('main');
      expect(updated.status).toBe('done');
      expect(updated.completedAt).not.toBeNull();

      // Moving back off 'done' clears completed_at.
      const reopened = service.moveCard(card.id, 'in_progress');
      expect(reopened.status).toBe('in_progress');
      expect(reopened.completedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects invalid status and priority', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      expect(() => service.createCard({ boardId, title: 'x', status: 'archived' as never })).toThrow(/status/i);
      expect(() => service.createCard({ boardId, title: 'x', priority: 'critical' as never })).toThrow(/priority/i);
    } finally {
      db.close();
    }
  });

  it('removes a card', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const card = service.createCard({ boardId, title: 'temp' });
      service.removeCard(card.id);
      expect(service.listCards(boardId)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('cascade-deletes cards when their board is removed', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      service.createCard({ boardId, title: 'c1' });
      service.createCard({ boardId, title: 'c2' });
      db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
      expect(service.listCards(boardId)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
