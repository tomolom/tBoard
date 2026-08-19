import type { CardDto, CardPriority, CardSource, CardStatus, CreateCardInput, UpdateCardInput } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';

const CARD_STATUSES: CardStatus[] = ['backlog', 'in_progress', 'in_review', 'done'];
const CARD_PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];
const CARD_SOURCES: CardSource[] = ['manual', 'mcp'];

const STATUS_ORDER_CASE = `CASE status
  WHEN 'backlog' THEN 0
  WHEN 'in_progress' THEN 1
  WHEN 'in_review' THEN 2
  WHEN 'done' THEN 3
  ELSE 4
END`;

function isCardStatus(value: unknown): value is CardStatus {
  return typeof value === 'string' && (CARD_STATUSES as string[]).includes(value);
}

function isCardPriority(value: unknown): value is CardPriority {
  return typeof value === 'string' && (CARD_PRIORITIES as string[]).includes(value);
}

function isCardSource(value: unknown): value is CardSource {
  return typeof value === 'string' && (CARD_SOURCES as string[]).includes(value);
}

type CardRow = {
  id: number;
  board_id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  branch: string | null;
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function mapCardRow(row: CardRow): CardDto {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status as CardStatus,
    priority: row.priority as CardPriority,
    branch: row.branch,
    source: row.source as CardSource,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const CARD_SELECT = `
  SELECT id, board_id, title, description, status, priority, branch,
         source, created_by, created_at, updated_at, completed_at
  FROM cards
`;

export class CardService {
  constructor(private readonly db: SqliteDatabase) {}

  private getCardRowOrThrow(id: number): CardRow {
    const row = this.db.prepare(`${CARD_SELECT} WHERE id = ?`).get(id) as CardRow | undefined;
    if (!row) {
      throw new Error(`Card ${id} was not found.`);
    }
    return row;
  }

  private assertBoardExists(boardId: number): void {
    const board = this.db.prepare('SELECT id FROM boards WHERE id = ?').get(boardId);
    if (!board) {
      throw new Error(`Board ${boardId} was not found.`);
    }
  }

  createCard(input: CreateCardInput): CardDto {
    if (!input.title || input.title.trim().length === 0) {
      throw new Error('Card title is required.');
    }
    if (typeof input.boardId !== 'number') {
      throw new Error('A boardId is required.');
    }
    this.assertBoardExists(input.boardId);

    const status = input.status ?? 'backlog';
    if (!isCardStatus(status)) {
      throw new Error(`Invalid card status: ${String(status)}`);
    }

    const priority = input.priority ?? 'normal';
    if (!isCardPriority(priority)) {
      throw new Error(`Invalid card priority: ${String(priority)}`);
    }

    const source = input.source ?? 'manual';
    if (!isCardSource(source)) {
      throw new Error(`Invalid card source: ${String(source)}`);
    }

    const branch = input.branch?.trim() ? input.branch.trim() : null;
    const completedAt = status === 'done' ? "datetime('now')" : 'NULL';

    const insertResult = this.db
      .prepare(
        `INSERT INTO cards (board_id, title, description, status, priority, branch, source, created_by, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${completedAt})`,
      )
      .run(input.boardId, input.title, input.description ?? null, status, priority, branch, source, input.createdBy ?? 'user');

    return mapCardRow(this.getCardRowOrThrow(Number(insertResult.lastInsertRowid)));
  }

  listCards(boardId: number): CardDto[] {
    const rows = this.db
      .prepare(`${CARD_SELECT} WHERE board_id = ? ORDER BY ${STATUS_ORDER_CASE}, updated_at DESC, id DESC`)
      .all(boardId) as CardRow[];
    return rows.map(mapCardRow);
  }

  updateCard(id: number, input: UpdateCardInput): CardDto {
    this.getCardRowOrThrow(id);

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (input.title !== undefined) {
      if (!input.title || input.title.trim().length === 0) {
        throw new Error('Card title is required.');
      }
      setClauses.push('title = ?');
      params.push(input.title);
    }

    if (input.description !== undefined) {
      setClauses.push('description = ?');
      params.push(input.description);
    }

    if (input.priority !== undefined) {
      if (!isCardPriority(input.priority)) {
        throw new Error(`Invalid card priority: ${String(input.priority)}`);
      }
      setClauses.push('priority = ?');
      params.push(input.priority);
    }

    if (input.branch !== undefined) {
      const branch = input.branch?.trim() ? input.branch.trim() : null;
      setClauses.push('branch = ?');
      params.push(branch);
    }

    if (input.status !== undefined) {
      if (!isCardStatus(input.status)) {
        throw new Error(`Invalid card status: ${String(input.status)}`);
      }
      setClauses.push('status = ?');
      params.push(input.status);

      if (input.status === 'done') {
        setClauses.push("completed_at = COALESCE(completed_at, datetime('now'))");
      } else {
        setClauses.push('completed_at = NULL');
      }
    }

    if (setClauses.length === 0) {
      return mapCardRow(this.getCardRowOrThrow(id));
    }

    setClauses.push("updated_at = datetime('now')");
    params.push(id);

    this.db.prepare(`UPDATE cards SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    return mapCardRow(this.getCardRowOrThrow(id));
  }

  moveCard(id: number, status: CardStatus): CardDto {
    return this.updateCard(id, { status });
  }

  removeCard(id: number): void {
    this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  }
}
