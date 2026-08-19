import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { BoardService } from '../../src/main/services/boardService';
import { listBranches } from '../../src/main/services/gitBranches';
import { createGitRepo, createTempWorkspace } from './testFixtures';

function freshDb() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('BoardService', () => {
  it('adds a board for a git repo, defaulting the name to the folder', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      const repoPath = await createGitRepo(ws.root, 'my-app');
      const service = new BoardService(db);
      const result = await service.addBoard({ repoPath });
      expect(result.error).toBeNull();
      expect(result.board?.name).toBe('my-app');
      expect(result.board?.repoPath).toBe(repoPath);

      expect(service.listBoards()).toHaveLength(1);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  it('rejects a non-git path', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      const service = new BoardService(db);
      const result = await service.addBoard({ repoPath: ws.root });
      expect(result.board).toBeNull();
      expect(result.error).toMatch(/not a git repository/i);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  it('rejects a duplicate repo path', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      const repoPath = await createGitRepo(ws.root, 'app');
      const service = new BoardService(db);
      await service.addBoard({ repoPath });
      const again = await service.addBoard({ repoPath });
      expect(again.board).toBeNull();
      expect(again.error).toMatch(/already exists/i);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  it('renames a board (name only, repo path unchanged)', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      const repoPath = await createGitRepo(ws.root, 'app');
      const service = new BoardService(db);
      const { board } = await service.addBoard({ repoPath });
      const renamed = service.renameBoard(board!.id, 'My Project');
      expect(renamed.name).toBe('My Project');
      expect(renamed.repoPath).toBe(repoPath);
      expect(() => service.renameBoard(board!.id, '  ')).toThrow(/name/i);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });

  it('removes a board', async () => {
    const ws = await createTempWorkspace();
    const db = freshDb();
    try {
      const repoPath = await createGitRepo(ws.root, 'app');
      const service = new BoardService(db);
      const { board } = await service.addBoard({ repoPath });
      service.removeBoard(board!.id);
      expect(service.listBoards()).toHaveLength(0);
    } finally {
      db.close();
      await ws.cleanup();
    }
  });
});

describe('listBranches', () => {
  it('returns an error for a non-existent path (never throws)', async () => {
    const result = await listBranches('/definitely/not/a/real/path/xyz');
    expect(result.branches).toHaveLength(0);
    expect(result.error).toBeTruthy();
  });
});
