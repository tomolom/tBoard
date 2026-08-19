import type { CardDto, CardPriority, CardSource, CardStatus, CardType, CreateCardInput, UpdateCardInput } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';

const CARD_STATUSES: CardStatus[] = ['backlog', 'in_progress', 'in_review', 'done'];
const CARD_TYPES: CardType[] = ['task', 'bug', 'feature'];
const CARD_PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];
const CARD_SOURCES: CardSource[] = ['manual', 'mcp'];

/** Gap between appended cards; fractional midpoints slot cards between neighbours. */
const POSITION_STEP = 1024;

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

function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as string[]).includes(value);
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
  type: string;
  status: string;
  priority: string;
  branch: string | null;
  module: string | null;
  position: number;
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
    type: row.type as CardType,
    status: row.status as CardStatus,
    priority: row.priority as CardPriority,
    branch: row.branch,
    module: row.module,
    position: row.position,
    source: row.source as CardSource,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const CARD_SELECT = `
  SELECT id, board_id, title, description, type, status, priority, branch, module, position,
         source, created_by, created_at, updated_at, completed_at
  FROM cards
`;

function normalizeOptional(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

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

  /** Next position for appending to the end of a (board, status) column. */
  private nextPosition(boardId: number, status: CardStatus): number {
    const row = this.db
      .prepare('SELECT MAX(position) AS maxPos FROM cards WHERE board_id = ? AND status = ?')
      .get(boardId, status) as { maxPos: number | null };
    return (row.maxPos ?? 0) + POSITION_STEP;
  }

  /**
   * Computes a position that places a card immediately after `afterCardId`
   * within (board, status). null afterCardId = top of the column. Uses
   * fractional midpoints so no other rows need renumbering.
   */
  private positionAfter(boardId: number, status: CardStatus, afterCardId: number | null, movingId: number): number {
    const siblings = this.db
      .prepare(
        `SELECT id, position FROM cards
         WHERE board_id = ? AND status = ? AND id != ?
         ORDER BY position ASC, id ASC`,
      )
      .all(boardId, status, movingId) as Array<{ id: number; position: number }>;

    if (afterCardId == null) {
      // Top of the column: before the first sibling (or a default if empty).
      const first = siblings[0];
      return first ? first.position - POSITION_STEP : POSITION_STEP;
    }

    const index = siblings.findIndex((s) => s.id === afterCardId);
    if (index === -1) {
      // Anchor not in this column (stale) — append to the end.
      const last = siblings[siblings.length - 1];
      return last ? last.position + POSITION_STEP : POSITION_STEP;
    }

    const anchor = siblings[index];
    const next = siblings[index + 1];
    return next ? (anchor.position + next.position) / 2 : anchor.position + POSITION_STEP;
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

    const type = input.type ?? 'task';
    if (!isCardType(type)) {
      throw new Error(`Invalid card type: ${String(type)}`);
    }

    const priority = input.priority ?? 'normal';
    if (!isCardPriority(priority)) {
      throw new Error(`Invalid card priority: ${String(priority)}`);
    }

    const source = input.source ?? 'manual';
    if (!isCardSource(source)) {
      throw new Error(`Invalid card source: ${String(source)}`);
    }

    const branch = normalizeOptional(input.branch);
    const module = normalizeOptional(input.module);
    const position = this.nextPosition(input.boardId, status);
    const completedAt = status === 'done' ? "datetime('now')" : 'NULL';

    const insertResult = this.db
      .prepare(
        `INSERT INTO cards (board_id, title, description, type, status, priority, branch, module, position, source, created_by, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${completedAt})`,
      )
      .run(input.boardId, input.title, input.description ?? null, type, status, priority, branch, module, position, source, input.createdBy ?? 'user');

    return mapCardRow(this.getCardRowOrThrow(Number(insertResult.lastInsertRowid)));
  }

  listCards(boardId: number): CardDto[] {
    const rows = this.db
      .prepare(`${CARD_SELECT} WHERE board_id = ? ORDER BY ${STATUS_ORDER_CASE}, position ASC, id ASC`)
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

    if (input.type !== undefined) {
      if (!isCardType(input.type)) {
        throw new Error(`Invalid card type: ${String(input.type)}`);
      }
      setClauses.push('type = ?');
      params.push(input.type);
    }

    if (input.priority !== undefined) {
      if (!isCardPriority(input.priority)) {
        throw new Error(`Invalid card priority: ${String(input.priority)}`);
      }
      setClauses.push('priority = ?');
      params.push(input.priority);
    }

    if (input.branch !== undefined) {
      setClauses.push('branch = ?');
      params.push(normalizeOptional(input.branch));
    }

    if (input.module !== undefined) {
      setClauses.push('module = ?');
      params.push(normalizeOptional(input.module));
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

  /**
   * Moves a card to `status`, positioned immediately after `afterCardId` in that
   * column (null = top). Handles both cross-column drops and within-column
   * reordering.
   */
  moveCard(id: number, status: CardStatus, afterCardId: number | null = null): CardDto {
    if (!isCardStatus(status)) {
      throw new Error(`Invalid card status: ${String(status)}`);
    }
    const row = this.getCardRowOrThrow(id);
    const position = this.positionAfter(row.board_id, status, afterCardId, id);

    const clauses = ['status = ?', 'position = ?', "updated_at = datetime('now')"];
    const params: unknown[] = [status, position];
    if (status === 'done') {
      clauses.push("completed_at = COALESCE(completed_at, datetime('now'))");
    } else {
      clauses.push('completed_at = NULL');
    }
    params.push(id);

    this.db.prepare(`UPDATE cards SET ${clauses.join(', ')} WHERE id = ?`).run(...params);
    return mapCardRow(this.getCardRowOrThrow(id));
  }

  removeCard(id: number): void {
    this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  }
}
