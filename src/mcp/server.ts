import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { CardPriority, CardStatus } from '../shared/api';
import type { TBoardMcpContext } from './context';
import { recordMcpOutcome, recordMcpReceived } from './mcpEvents';

const CARD_STATUSES = ['backlog', 'in_progress', 'in_review', 'done'] as const satisfies readonly CardStatus[];
const CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const satisfies readonly CardPriority[];

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function jsonResource(uri: string, value: unknown): ReadResourceResult {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Builds the tBoard MCP server. tBoard is a Kanban board per git repo, so the
 * tool surface is boards (list/add/branches) and cards (list/create/update/
 * move). `boards_add` is the one filesystem-touching tool — it validates and
 * registers a git repo path but never writes to that repo. Every tool call and
 * resource read is logged to `mcp_events` (received -> applied/failed).
 */
export function createTBoardMcpServer(context: TBoardMcpContext): McpServer {
  const server = new McpServer({ name: 'tboard-mcp', version: '0.2.0' });

  const runLogged = (operation: string, request: unknown, produce: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
    const eventId = recordMcpReceived(context.db, operation, request);
    return Promise.resolve()
      .then(() => produce())
      .then((value) => {
        const result = jsonResult(value);
        recordMcpOutcome(context.db, eventId, 'applied', result);
        return result;
      })
      .catch((error) => {
        const result = errorResult(error);
        recordMcpOutcome(context.db, eventId, 'failed', result);
        return result;
      });
  };

  const runResource = (operation: string, uri: string, produce: () => unknown): ReadResourceResult => {
    const eventId = recordMcpReceived(context.db, operation, { uri });
    try {
      const result = jsonResource(uri, produce());
      recordMcpOutcome(context.db, eventId, 'applied', { uri });
      return result;
    } catch (error) {
      recordMcpOutcome(context.db, eventId, 'failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  server.registerTool(
    'tboard_boards_list',
    {
      title: 'List boards',
      description: 'Lists all tBoard boards. Each board is a git repository the user added.',
      inputSchema: {},
    },
    () => runLogged('tboard_boards_list', {}, () => context.boards.listBoards()),
  );

  server.registerTool(
    'tboard_boards_add',
    {
      title: 'Add a board',
      description:
        'Adds a board for a git repository at the given absolute path. Validates the path is a git repo and is not already added. Registers the path only; never writes to the repo.',
      inputSchema: {
        repoPath: z.string().min(1),
        name: z.string().optional(),
      },
    },
    (args) => runLogged('tboard_boards_add', args, () => context.boards.addBoard(args)),
  );

  server.registerTool(
    'tboard_boards_branches',
    {
      title: "List a board's git branches",
      description: "Lists the local git branches in a board's repository, flagging the currently checked-out branch. Read-only.",
      inputSchema: {
        boardId: z.number().int(),
      },
    },
    (args) =>
      runLogged('tboard_boards_branches', args, () => {
        const board = context.boards.getBoard(args.boardId);
        if (!board) {
          return { branches: [], current: null, error: `Board ${args.boardId} was not found.` };
        }
        return context.listBranches(board.repoPath);
      }),
  );

  server.registerTool(
    'tboard_cards_list',
    {
      title: 'List cards on a board',
      description: 'Lists all cards on a board, ordered by status then most recently updated.',
      inputSchema: {
        boardId: z.number().int(),
      },
    },
    (args) => runLogged('tboard_cards_list', args, () => context.cards.listCards(args.boardId)),
  );

  server.registerTool(
    'tboard_cards_create',
    {
      title: 'Create a card',
      description: 'Creates a card on a board, optionally associated with a git branch.',
      inputSchema: {
        boardId: z.number().int(),
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        status: z.enum(CARD_STATUSES).optional(),
        priority: z.enum(CARD_PRIORITIES).optional(),
        branch: z.string().nullable().optional(),
      },
    },
    (args) => runLogged('tboard_cards_create', args, () => context.cards.createCard({ ...args, source: 'mcp', createdBy: 'mcp' })),
  );

  server.registerTool(
    'tboard_cards_update',
    {
      title: 'Update a card',
      description: 'Updates editable fields of a card (title, description, status, priority, branch). Only provided fields change.',
      inputSchema: {
        id: z.number().int(),
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        status: z.enum(CARD_STATUSES).optional(),
        priority: z.enum(CARD_PRIORITIES).optional(),
        branch: z.string().nullable().optional(),
      },
    },
    (args) => {
      const { id, ...input } = args;
      return runLogged('tboard_cards_update', args, () => context.cards.updateCard(id, input));
    },
  );

  server.registerTool(
    'tboard_cards_move',
    {
      title: 'Move a card',
      description: 'Moves a card to a new status (backlog, in_progress, in_review, done).',
      inputSchema: {
        id: z.number().int(),
        status: z.enum(CARD_STATUSES),
      },
    },
    (args) => runLogged('tboard_cards_move', args, () => context.cards.moveCard(args.id, args.status)),
  );

  server.registerResource(
    'tboard-boards',
    'tboard://boards',
    {
      title: 'tBoard boards',
      description: 'All tBoard boards (git repos) as JSON.',
      mimeType: 'application/json',
    },
    (uri) => runResource('resource:tboard://boards', uri.href, () => context.boards.listBoards()),
  );

  return server;
}
