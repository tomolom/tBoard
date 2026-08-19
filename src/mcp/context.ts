import type {
  AddBoardInput,
  AddBoardResult,
  BoardDto,
  BranchListResult,
  CardDto,
  CardStatus,
  CreateCardInput,
  UpdateCardInput,
} from '../shared/api';
import type { SqliteDatabase } from '../main/db/sqlite';
import { createDatabase } from '../main/db/sqlite';
import { runMigrations } from '../main/db/migrations';
import { BoardService } from '../main/services/boardService';
import { CardService } from '../main/services/cardService';
import { listBranches } from '../main/services/gitBranches';
import { listModules } from '../main/services/repoModules';
import { resolveDatabasePath } from '../shared/appPaths';
import { recordMcpOutcome, recordMcpReceived, type McpEventStatus } from './mcpEvents';
import { RemoteTBoardClient } from './remoteClient';

/**
 * The operations the MCP tools need, abstracted over where the board lives.
 * Two implementations back it: LocalBackend (SQLite + git on disk) and
 * RemoteBackend (a hosted tBoard server over HTTP). The tool definitions in
 * server.ts are identical for both — only the backend differs — so there is one
 * tool surface, never a duplicated/drifting one.
 */
export interface TBoardBackend {
  listBoards(): BoardDto[] | Promise<BoardDto[]>;
  addBoard(input: AddBoardInput): AddBoardResult | Promise<AddBoardResult>;
  boardBranches(boardId: number): BranchListResult | Promise<BranchListResult>;
  boardModules(boardId: number): string[] | Promise<string[]>;
  listCards(boardId: number): CardDto[] | Promise<CardDto[]>;
  createCard(input: CreateCardInput): CardDto | Promise<CardDto>;
  updateCard(id: number, input: UpdateCardInput): CardDto | Promise<CardDto>;
  moveCard(id: number, status: CardStatus): CardDto | Promise<CardDto>;
}

/** Best-effort action logging; local mode writes mcp_events, remote is a no-op. */
export type McpLogger = {
  received(operation: string, request: unknown): number | null;
  outcome(id: number | null, status: McpEventStatus, response: unknown): void;
};

export type TBoardMcpContext = {
  backend: TBoardBackend;
  /** Human-readable target, e.g. "local database" or "remote https://…". */
  label: string;
  logger: McpLogger;
  close(): void;
};

/** Local backend: the SQLite services + on-disk git discovery. */
class LocalBackend implements TBoardBackend {
  constructor(
    private readonly boards: BoardService,
    private readonly cards: CardService,
  ) {}

  listBoards(): BoardDto[] {
    return this.boards.listBoards();
  }

  addBoard(input: AddBoardInput): Promise<AddBoardResult> {
    return this.boards.addBoard(input);
  }

  boardBranches(boardId: number): BranchListResult | Promise<BranchListResult> {
    const board = this.boards.getBoard(boardId);
    if (!board) {
      return { branches: [], current: null, error: `Board ${boardId} was not found.` };
    }
    return listBranches(board.repoPath);
  }

  boardModules(boardId: number): string[] | Promise<string[]> {
    const board = this.boards.getBoard(boardId);
    if (!board) {
      return [];
    }
    return listModules(board.repoPath);
  }

  listCards(boardId: number): CardDto[] {
    return this.cards.listCards(boardId);
  }

  createCard(input: CreateCardInput): CardDto {
    return this.cards.createCard({ ...input, source: 'mcp', createdBy: 'mcp' });
  }

  updateCard(id: number, input: UpdateCardInput): CardDto {
    return this.cards.updateCard(id, input);
  }

  moveCard(id: number, status: CardStatus): CardDto {
    return this.cards.moveCard(id, status);
  }
}

/** Remote backend: a hosted tBoard server over its authenticated HTTP API. */
class RemoteBackend implements TBoardBackend {
  constructor(private readonly client: RemoteTBoardClient) {}

  listBoards(): Promise<BoardDto[]> {
    return this.client.listBoards();
  }

  addBoard(input: AddBoardInput): Promise<AddBoardResult> {
    return this.client.addBoard(input);
  }

  boardBranches(boardId: number): Promise<BranchListResult> {
    return this.client.branches(boardId);
  }

  boardModules(boardId: number): Promise<string[]> {
    return this.client.modules(boardId);
  }

  listCards(boardId: number): Promise<CardDto[]> {
    return this.client.listCards(boardId);
  }

  createCard(input: CreateCardInput): Promise<CardDto> {
    return this.client.createCard(input);
  }

  updateCard(id: number, input: UpdateCardInput): Promise<CardDto> {
    return this.client.updateCard(id, input);
  }

  moveCard(id: number, status: CardStatus): Promise<CardDto> {
    return this.client.moveCard(id, status);
  }
}

function dbLogger(db: SqliteDatabase): McpLogger {
  return {
    received: (operation, request) => recordMcpReceived(db, operation, request),
    outcome: (id, status, response) => recordMcpOutcome(db, id, status, response),
  };
}

const noopLogger: McpLogger = {
  received: () => null,
  outcome: () => undefined,
};

/**
 * Resolves the SQLite database the local MCP server opens. Delegates to the
 * shared resolver, which honors `TBOARD_DB_PATH` and otherwise uses the same
 * per-user location the desktop app uses, so an agent and the app share one
 * board by default.
 */
export function resolveDbPath(): string {
  return resolveDatabasePath();
}

/** Builds a local (SQLite-backed) context. Shared by the entrypoint and tests. */
export function createLocalMcpContext(db: SqliteDatabase): TBoardMcpContext {
  return {
    backend: new LocalBackend(new BoardService(db), new CardService(db)),
    label: 'local database',
    logger: dbLogger(db),
    close: () => db.close(),
  };
}

/**
 * Opens the local SQLite database, runs migrations, and builds a local context.
 */
export function createTBoardMcpContext(overrides?: { dbPath?: string }): TBoardMcpContext {
  const dbPath = overrides?.dbPath ?? resolveDbPath();
  const db = createDatabase(dbPath);
  runMigrations(db);
  return createLocalMcpContext(db);
}

/**
 * Builds a remote context pointed at a hosted tBoard server, authenticating up
 * front so a bad URL/password fails fast at startup. Remote actions are logged
 * on the server side, so the local logger is a no-op.
 */
export async function createRemoteTBoardMcpContext(config: { url: string; password: string }): Promise<TBoardMcpContext> {
  const client = new RemoteTBoardClient(config.url, config.password);
  await client.login();
  return {
    backend: new RemoteBackend(client),
    label: client.label,
    logger: noopLogger,
    close: () => undefined,
  };
}

/**
 * Chooses the context from the environment: if TBOARD_REMOTE_URL is set, connect
 * to that hosted server (TBOARD_REMOTE_PASSWORD required); otherwise open the
 * local database.
 */
export async function createMcpContextFromEnv(): Promise<TBoardMcpContext> {
  const remoteUrl = process.env.TBOARD_REMOTE_URL?.trim();
  if (remoteUrl) {
    const password = process.env.TBOARD_REMOTE_PASSWORD;
    if (!password) {
      throw new Error('TBOARD_REMOTE_URL is set but TBOARD_REMOTE_PASSWORD is missing.');
    }
    return createRemoteTBoardMcpContext({ url: remoteUrl, password });
  }
  return createTBoardMcpContext();
}
