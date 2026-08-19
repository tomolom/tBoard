import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRemoteTBoardMcpContext } from '../../src/mcp/context';
import { createTBoardMcpServer } from '../../src/mcp/server';

type TextContent = { type: string; text?: string };
function parseToolJson(result: unknown): unknown {
  const content = ((result as { content?: unknown }).content ?? []) as TextContent[];
  const part = content.find((p) => p.type === 'text' && typeof p.text === 'string');
  if (!part?.text) throw new Error('no text content');
  return JSON.parse(part.text) as unknown;
}

/** A tiny in-memory fake of the remote server's HTTP API. */
function installFakeServer(): { calls: string[] } {
  const calls: string[] = [];
  const boards = [{ id: 1, name: 'App', repoPath: '/repos/app', createdAt: 't', updatedAt: 't' }];
  const cards: Array<Record<string, unknown>> = [];
  let nextId = 1;

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);

    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

    if (path === '/api/login') {
      const headers = new Headers();
      headers.append('Set-Cookie', '__Host-tboard_session=sess-abc; Path=/; HttpOnly');
      headers.append('Set-Cookie', '__Host-tboard_csrf=csrf-xyz; Path=/');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    // Every authed call must carry the session cookie + (mutations) CSRF header.
    const cookie = (init?.headers as Record<string, string>)?.Cookie ?? '';
    if (!cookie.includes('__Host-tboard_session=sess-abc')) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (path === '/api/boards' && method === 'GET') return json(boards);
    if (path === '/api/cards' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const card = { id: nextId++, source: 'mcp', status: body.status ?? 'backlog', ...body };
      cards.push(card);
      return json(card);
    }
    if (path === `/api/boards/1/cards` && method === 'GET') return json(cards);
    return json({ error: 'not found' }, 404);
  });
  return { calls };
}

async function connect(context: Awaited<ReturnType<typeof createRemoteTBoardMcpContext>>): Promise<Client> {
  const server = createTBoardMcpServer(context);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'remote-test', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

describe('MCP remote backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs in on construction and drives a hosted board over HTTP', async () => {
    const { calls } = installFakeServer();
    const context = await createRemoteTBoardMcpContext({ url: 'https://board.test/', password: 'pw' });
    expect(context.label).toBe('remote https://board.test');
    expect(calls).toContain('POST /api/login'); // authenticated up front

    const client = await connect(context);
    const boards = parseToolJson(await client.callTool({ name: 'tboard_boards_list', arguments: {} })) as unknown[];
    expect(boards).toHaveLength(1);

    const created = parseToolJson(
      await client.callTool({
        name: 'tboard_cards_create',
        arguments: { boardId: 1, title: 'Remote card', status: 'developing' },
      }),
    ) as { id: number; source: string; status: string };
    expect(created.source).toBe('mcp');
    expect(created.status).toBe('developing');

    const listed = parseToolJson(await client.callTool({ name: 'tboard_cards_list', arguments: { boardId: 1 } })) as unknown[];
    expect(listed).toHaveLength(1);
    // The card create must have gone over HTTP POST.
    expect(calls).toContain('POST /api/cards');
    await client.close();
  });

  it('fails fast when the remote password is wrong', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      new URL(url).pathname === '/api/login'
        ? new Response(JSON.stringify({ error: 'Invalid password' }), { status: 401 })
        : new Response('{}', { status: 200 }),
    );
    await expect(createRemoteTBoardMcpContext({ url: 'https://board.test', password: 'bad' })).rejects.toThrow(/password/i);
  });
});
