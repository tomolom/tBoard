import type { CardDto, CardPriority, CardSeverity, CardStatus, CardType, CreateCardInput, UpdateCardInput } from '../../shared/api';
import type { SqliteDatabase } from '../db/connection';

const CARD_TYPES: CardType[] = ['component', 'bug', 'task', 'release', 'evidence'];
const CARD_STATUSES: CardStatus[] = ['backlog', 'developing', 'untested', 'needs_fix', 'approved', 'released', 'archived'];
const CARD_PRIORITIES: CardPriority[] = ['low', 'normal', 'high', 'urgent'];
const CARD_SEVERITIES: CardSeverity[] = ['none', 'low', 'medium', 'high', 'critical'];

const STATUS_ORDER_CASE = `CASE status
  WHEN 'backlog' THEN 0
  WHEN 'developing' THEN 1
  WHEN 'untested' THEN 2
  WHEN 'needs_fix' THEN 3
  WHEN 'approved' THEN 4
  WHEN 'released' THEN 5
  WHEN 'archived' THEN 6
  ELSE 7
END`;

function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as string[]).includes(value);
}

function isCardStatus(value: unknown): value is CardStatus {
  return typeof value === 'string' && (CARD_STATUSES as string[]).includes(value);
}

function isCardPriority(value: unknown): value is CardPriority {
  return typeof value === 'string' && (CARD_PRIORITIES as string[]).includes(value);
}

function isCardSeverity(value: unknown): value is CardSeverity {
  return typeof value === 'string' && (CARD_SEVERITIES as string[]).includes(value);
}

type CardRow = {
  id: number;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  severity: string | null;
  component_id: number | null;
  component_variant_id: number | null;
  repo_mapping_id: number | null;
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  released_at: string | null;
  component_display_name: string | null;
  mapping_display_name: string | null;
};

function mapCardRow(row: CardRow): CardDto {
  return {
    id: row.id,
    type: row.type as CardType,
    title: row.title,
    description: row.description,
    status: row.status as CardStatus,
    priority: row.priority as CardPriority,
    severity: (row.severity ?? 'none') as CardSeverity,
    componentId: row.component_id,
    componentVariantId: row.component_variant_id,
    repoMappingId: row.repo_mapping_id,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    releasedAt: row.released_at,
    componentDisplayName: row.component_display_name,
    mappingDisplayName: row.mapping_display_name,
  };
}

const CARD_SELECT = `
  SELECT
    cards.id AS id,
    cards.type AS type,
    cards.title AS title,
    cards.description AS description,
    cards.status AS status,
    cards.priority AS priority,
    cards.severity AS severity,
    cards.component_id AS component_id,
    cards.component_variant_id AS component_variant_id,
    cards.repo_mapping_id AS repo_mapping_id,
    cards.source AS source,
    cards.created_by AS created_by,
    cards.created_at AS created_at,
    cards.updated_at AS updated_at,
    cards.completed_at AS completed_at,
    cards.released_at AS released_at,
    components.display_name AS component_display_name,
    repo_mappings.display_name AS mapping_display_name
  FROM cards
  LEFT JOIN components ON components.id = cards.component_id
  LEFT JOIN repo_mappings ON repo_mappings.id = cards.repo_mapping_id
`;

type ComponentVariantLookup = {
  component_id: number;
  repo_mapping_id: number;
};

export class CardService {
  constructor(private readonly db: SqliteDatabase) {}

  private getCardRowOrThrow(id: number): CardRow {
    const row = this.db.prepare(`${CARD_SELECT} WHERE cards.id = ?`).get(id) as CardRow | undefined;
    if (!row) {
      throw new Error(`Card ${id} was not found.`);
    }
    return row;
  }

  private lookupComponentVariant(componentVariantId: number): ComponentVariantLookup {
    const row = this.db
      .prepare('SELECT component_id, repo_mapping_id FROM component_variants WHERE id = ?')
      .get(componentVariantId) as ComponentVariantLookup | undefined;

    if (!row) {
      throw new Error(`Component variant ${componentVariantId} was not found.`);
    }

    return row;
  }

  createCard(input: CreateCardInput): CardDto {
    if (!input.title || input.title.trim().length === 0) {
      throw new Error('Card title is required.');
    }
    if (!isCardType(input.type)) {
      throw new Error(`Invalid card type: ${String(input.type)}`);
    }

    const status = input.status ?? 'backlog';
    if (!isCardStatus(status)) {
      throw new Error(`Invalid card status: ${String(status)}`);
    }

    const priority = input.priority ?? 'normal';
    if (!isCardPriority(priority)) {
      throw new Error(`Invalid card priority: ${String(priority)}`);
    }

    const severity = input.severity ?? 'none';
    if (!isCardSeverity(severity)) {
      throw new Error(`Invalid card severity: ${String(severity)}`);
    }

    let componentId = input.componentId ?? null;
    let repoMappingId = input.repoMappingId ?? null;

    if (input.componentVariantId != null) {
      const variant = this.lookupComponentVariant(input.componentVariantId);
      if (componentId == null) {
        componentId = variant.component_id;
      }
      if (repoMappingId == null) {
        repoMappingId = variant.repo_mapping_id;
      }
    }

    const source = input.source ?? 'manual';
    const createdBy = input.createdBy ?? 'user';

    const insertResult = this.db
      .prepare(
        `INSERT INTO cards (
           type, title, description, status, priority, severity,
           component_id, component_variant_id, repo_mapping_id, source, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        input.title,
        input.description ?? null,
        status,
        priority,
        severity,
        componentId,
        input.componentVariantId ?? null,
        repoMappingId,
        source,
        createdBy,
      );

    const cardId = Number(insertResult.lastInsertRowid);
    return mapCardRow(this.getCardRowOrThrow(cardId));
  }

  listCards(): CardDto[] {
    const rows = this.db.prepare(`${CARD_SELECT} ORDER BY ${STATUS_ORDER_CASE}, cards.updated_at DESC, cards.id DESC`).all() as CardRow[];
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

    if (input.severity !== undefined) {
      if (!isCardSeverity(input.severity)) {
        throw new Error(`Invalid card severity: ${String(input.severity)}`);
      }
      setClauses.push('severity = ?');
      params.push(input.severity);
    }

    if (input.componentVariantId !== undefined) {
      if (input.componentVariantId === null) {
        setClauses.push('component_variant_id = ?');
        params.push(null);
      } else {
        const variant = this.lookupComponentVariant(input.componentVariantId);
        setClauses.push('component_variant_id = ?', 'component_id = ?', 'repo_mapping_id = ?');
        params.push(input.componentVariantId, variant.component_id, variant.repo_mapping_id);
      }
    }

    if (input.status !== undefined) {
      if (!isCardStatus(input.status)) {
        throw new Error(`Invalid card status: ${String(input.status)}`);
      }
      setClauses.push('status = ?');
      params.push(input.status);

      if (input.status === 'released') {
        setClauses.push("released_at = COALESCE(released_at, datetime('now'))");
      }

      if (input.status === 'released' || input.status === 'archived') {
        setClauses.push("completed_at = COALESCE(completed_at, datetime('now'))");
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
}
