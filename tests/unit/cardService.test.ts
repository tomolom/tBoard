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

  it('appends new cards to the end of their column by position', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const a = service.createCard({ boardId, title: 'A' });
      const b = service.createCard({ boardId, title: 'B' });
      const c = service.createCard({ boardId, title: 'C' });
      expect(a.position).toBeLessThan(b.position);
      expect(b.position).toBeLessThan(c.position);
      expect(service.listCards(boardId).map((card) => card.title)).toEqual(['A', 'B', 'C']);
    } finally {
      db.close();
    }
  });

  it('reorders a card within a column via move + afterCardId', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const a = service.createCard({ boardId, title: 'A' });
      const b = service.createCard({ boardId, title: 'B' });
      const c = service.createCard({ boardId, title: 'C' });

      // Move C to just after A (between A and B).
      service.moveCard(c.id, 'backlog', a.id);
      expect(service.listCards(boardId).map((card) => card.title)).toEqual(['A', 'C', 'B']);

      // Move A to the top (afterCardId = null).
      service.moveCard(b.id, 'backlog', null);
      expect(service.listCards(boardId).map((card) => card.title)).toEqual(['B', 'A', 'C']);
    } finally {
      db.close();
    }
  });

  it('moves a card across columns, positioned after an anchor', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const inProg1 = service.createCard({ boardId, title: 'P1', status: 'in_progress' });
      service.createCard({ boardId, title: 'P2', status: 'in_progress' });
      const backlog = service.createCard({ boardId, title: 'B1' });

      const moved = service.moveCard(backlog.id, 'in_progress', inProg1.id);
      expect(moved.status).toBe('in_progress');
      const inProgress = service.listCards(boardId).filter((card) => card.status === 'in_progress');
      expect(inProgress.map((card) => card.title)).toEqual(['P1', 'B1', 'P2']);
    } finally {
      db.close();
    }
  });

  it('stores an optional module on create and update', () => {
    const db = freshDb();
    try {
      const { boardId } = seedBoard(db, { repoPath: '/repos/app' });
      const service = new CardService(db);
      const card = service.createCard({ boardId, title: 'x', module: 'packages/core' });
      expect(card.module).toBe('packages/core');
      const updated = service.updateCard(card.id, { module: 'apps/web' });
      expect(updated.module).toBe('apps/web');
      const cleared = service.updateCard(card.id, { module: '  ' });
      expect(cleared.module).toBeNull();
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
