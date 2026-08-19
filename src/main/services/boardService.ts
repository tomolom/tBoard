import path from 'node:path';

import type { AddBoardInput, AddBoardResult, BoardDto } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';
import { isGitRepo } from './gitBranches';

type BoardRow = {
  id: number;
  name: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
};

function mapBoard(row: BoardRow): BoardDto {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BoardService {
  constructor(private readonly db: SqliteDatabase) {}

  listBoards(): BoardDto[] {
    const rows = this.db
      .prepare('SELECT id, name, repo_path, created_at, updated_at FROM boards ORDER BY name')
      .all() as BoardRow[];
    return rows.map(mapBoard);
  }

  getBoard(id: number): BoardDto | null {
    const row = this.db
      .prepare('SELECT id, name, repo_path, created_at, updated_at FROM boards WHERE id = ?')
      .get(id) as BoardRow | undefined;
    return row ? mapBoard(row) : null;
  }

  /**
   * Adds a board for a git repo. Validates the path is a git repository and is
   * not already added. Never throws — validation failures return an `error`.
   */
  async addBoard(input: AddBoardInput): Promise<AddBoardResult> {
    const repoPath = input.repoPath?.trim();
    if (!repoPath) {
      return { board: null, error: 'A repository path is required.' };
    }
    if (!(await isGitRepo(repoPath))) {
      return { board: null, error: `Not a git repository: ${repoPath}` };
    }

    const existing = this.db.prepare('SELECT id FROM boards WHERE repo_path = ?').get(repoPath) as
      | { id: number }
      | undefined;
    if (existing) {
      return { board: null, error: 'A board already exists for this repository.' };
    }

    const name = input.name?.trim() || path.basename(repoPath.replace(/[\\/]+$/u, '')) || repoPath;
    const info = this.db
      .prepare("INSERT INTO boards (name, repo_path, updated_at) VALUES (?, ?, datetime('now'))")
      .run(name, repoPath);

    const board = this.getBoard(Number(info.lastInsertRowid));
    return { board, error: null };
  }

  removeBoard(id: number): void {
    // Cards cascade-delete via the board_id foreign key.
    this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  }
}
