import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/main/db/migrations';
import { createDatabase } from '../../src/main/db/sqlite';
import type { SqliteDatabase } from '../../src/main/db/sqlite';
import { createLocalMcpContext, type TBoardMcpContext } from '../../src/mcp/context';
import { createTBoardMcpServer } from '../../src/mcp/server';
import { seedBoard } from './dbFixtures';
import { createGitRepo, createTempWorkspace } from './testFixtures';

function createInMemoryContext(): TBoardMcpContext & { db: SqliteDatabase } {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return { ...createLocalMcpContext(db), db };
}

type TextContent = { type: string; text?: string };

function parseToolJson(result: unknown): unknown {
  const content = ((result as { content?: unknown }).content ?? []) as TextContent[];
  const textPart = content.find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart || typeof textPart.text !== 'string') {
    throw new Error('tool result had no text content');
  }
  return JSON.parse(textPart.text) as unknown;
}

async function connectClient(context: TBoardMcpContext): Promise<Client> {
  const server = createTBoardMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tboard-test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('createTBoardMcpServer', () => {
  it('constructs and closes without throwing against an in-memory, migrated database', async () => {
    const context = createInMemoryContext();
    const server = createTBoardMcpServer(context);
    expect(server).toBeDefined();
    await expect(server.close()).resolves.not.toThrow();
    expect(() => context.close()).not.toThrow();
  });
});

describe('createTBoardMcpServer protocol round-trip', () => {
  it('advertises exactly the board + card tool surface', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          'tboard_boards_add',
          'tboard_boards_branches',
          'tboard_boards_list',
          'tboard_boards_modules',
          'tboard_cards_create',
          'tboard_cards_list',
          'tboard_cards_move',
          'tboard_cards_update',
        ].sort(),
      );
      await client.close();
    } finally {
      context.close();
    }
  });

  it('adds a board and round-trips a card over the protocol', async () => {
    const workspace = await createTempWorkspace();
    const context = createInMemoryContext();
    try {
      const repoPath = await createGitRepo(workspace.root, 'app');
      const client = await connectClient(context);

      const added = parseToolJson(
        await client.callTool({ name: 'tboard_boards_add', arguments: { repoPath, name: 'App' } }),
      ) as { board: { id: number; name: string } | null; error: string | null };
      expect(added.error).toBeNull();
      expect(added.board?.name).toBe('App');
      const boardId = added.board!.id;

      const created = parseToolJson(
        await client.callTool({
          name: 'tboard_cards_create',
          arguments: { boardId, title: 'Wire up CI', branch: 'main' },
        }),
      ) as { id: number; boardId: number; branch: string | null; source: string };
      expect(created.boardId).toBe(boardId);
      expect(created.branch).toBe('main');
      expect(created.source).toBe('mcp');

      const listed = parseToolJson(
        await client.callTool({ name: 'tboard_cards_list', arguments: { boardId } }),
      ) as Array<{ id: number }>;
      expect(listed.some((card) => card.id === created.id)).toBe(true);

      await client.close();
    } finally {
      context.close();
      await workspace.cleanup();
    }
  });

  it('rejects adding a board for a non-git path with an error (not a throw)', async () => {
    const workspace = await createTempWorkspace();
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);
      const result = parseToolJson(
        await client.callTool({ name: 'tboard_boards_add', arguments: { repoPath: workspace.root } }),
      ) as { board: unknown; error: string | null };
      expect(result.board).toBeNull();
      expect(result.error).toMatch(/not a git repository/i);
      await client.close();
    } finally {
      context.close();
      await workspace.cleanup();
    }
  });

  it('logs each tool call to mcp_events (received -> applied)', async () => {
    const context = createInMemoryContext();
    try {
      seedBoard(context.db, { repoPath: '/repos/x' });
      const client = await connectClient(context);
      await client.callTool({ name: 'tboard_boards_list', arguments: {} });

      const events = context.db
        .prepare("SELECT operation, status FROM mcp_events WHERE operation = 'tboard_boards_list'")
        .all() as Array<{ operation: string; status: string }>;
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('applied');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('returns isError (not a throw) for an unknown card update', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);
      const result = await client.callTool({ name: 'tboard_cards_update', arguments: { id: 999, title: 'x' } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      await client.close();
    } finally {
      context.close();
    }
  });

  it('exposes the boards resource', async () => {
    const context = createInMemoryContext();
    try {
      seedBoard(context.db, { name: 'app', repoPath: '/repos/app' });
      const client = await connectClient(context);
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain('tboard://boards');

      const read = await client.readResource({ uri: 'tboard://boards' });
      const first = read.contents[0] as { text?: string };
      const boards = JSON.parse(first.text as string) as Array<{ name: string }>;
      expect(boards[0].name).toBe('app');
      await client.close();
    } finally {
      context.close();
    }
  });
});
