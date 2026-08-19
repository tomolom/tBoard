import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/main/db/migrations';
import { createDatabase } from '../../src/main/db/sqlite';
import { CardService } from '../../src/main/services/cardService';
import { CommandService } from '../../src/main/services/commandService';
import { DiffService } from '../../src/main/services/diffService';
import { EvidenceService } from '../../src/main/services/evidenceService';
import { InventoryService } from '../../src/main/services/inventoryService';
import { ReleaseCopyService } from '../../src/main/services/releaseCopyService';
import { SettingsService } from '../../src/main/services/settingsService';
import type { TBoardMcpContext } from '../../src/mcp/context';
import { listPendingOperations } from '../../src/mcp/pendingOperations';
import { createTBoardMcpServer } from '../../src/mcp/server';
import { seedComponentVariant, seedRepoMapping } from './dbFixtures';
import { createTempWorkspace } from './testFixtures';

function contextForDb(db: ReturnType<typeof createDatabase>, roots?: { evidenceRoot?: string; commandOutputRoot?: string }): TBoardMcpContext {
  const evidenceRoot = roots?.evidenceRoot ?? '/tmp/tboard-mcp-test-evidence';
  const commandOutputRoot = roots?.commandOutputRoot ?? '/tmp/tboard-mcp-test-command-output';
  return {
    db,
    dbPath: ':memory:',
    evidenceRoot,
    commandOutputRoot,
    cards: new CardService(db),
    commands: new CommandService(db, commandOutputRoot),
    diff: new DiffService(db),
    evidence: new EvidenceService(db, evidenceRoot),
    inventory: new InventoryService(db),
    releaseCopy: new ReleaseCopyService(db),
    settings: new SettingsService(db),
    close: () => db.close(),
  };
}

function createInMemoryContext(): TBoardMcpContext {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return contextForDb(db);
}

describe('createTBoardMcpServer', () => {
  it('constructs and closes without throwing against an in-memory, migrated database', async () => {
    const context = createInMemoryContext();

    const server = createTBoardMcpServer(context);
    expect(server).toBeDefined();

    await expect(server.close()).resolves.not.toThrow();
    expect(() => context.close()).not.toThrow();
  });

  it('constructs a server that reflects existing data via its underlying services', () => {
    const context = createInMemoryContext();
    try {
      seedComponentVariant(context.db, { canonicalName: 'gauntlet', mappingKey: 'main' });
      const card = context.cards.createCard({ type: 'task', title: 'Seeded card' });

      const server = createTBoardMcpServer(context);
      expect(server).toBeDefined();

      // The server is constructed against the same context/services, so the
      // underlying data is reachable without needing to spawn a transport.
      const cards = context.cards.listCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe(card.id);

      const variants = context.inventory.listComponentVariants();
      expect(variants).toHaveLength(1);
      expect(variants[0].canonicalName).toBe('gauntlet');
    } finally {
      context.close();
    }
  });
});

type TextContent = { type: string; text?: string };

function parseToolJson(result: unknown): unknown {
  const content = ((result as { content?: unknown }).content ?? []) as TextContent[];
  const textPart = content.find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart || typeof textPart.text !== 'string') {
    throw new Error('tool result had no text content');
  }
  return JSON.parse(textPart.text) as unknown;
}

describe('createTBoardMcpServer protocol round-trip', () => {
  async function connectClient(context: TBoardMcpContext): Promise<Client> {
    const server = createTBoardMcpServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tboard-test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  it('advertises only the safe tool surface (no target-repo apply/write tools)', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();

      expect(names).toEqual(
        [
          'tboard_cards_create',
          'tboard_cards_list',
          'tboard_cards_move',
          'tboard_cards_update',
          'tboard_commands_git_status',
          'tboard_commands_list_runs',
          'tboard_commands_preview',
          'tboard_commands_read_run_output',
          'tboard_diff_list',
          'tboard_diff_scan',
          'tboard_evidence_import',
          'tboard_evidence_list',
          'tboard_evidence_list_for_variant',
          'tboard_inventory_list_repo_mappings',
          'tboard_inventory_list_variants',
          'tboard_inventory_scan',
          'tboard_next_work',
          'tboard_pending_operations_list',
          'tboard_release_preview_copy',
          'tboard_settings_get',
          'tboard_settings_set_workspace_root',
        ].sort(),
      );

      // Guard rail: the two dangerous *apply* mutations (command execution,
      // target-repo copy apply) must never be exposed over MCP. Command reads
      // and preview are allowed; applying is human-only in the app.
      for (const name of names) {
        expect(name).not.toMatch(/apply/i);
      }
      expect(names).not.toContain('tboard_commands_apply');
      expect(names).not.toContain('tboard_release_apply_copy');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('creates and lists a card end-to-end through the MCP protocol', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      const created = parseToolJson(
        await client.callTool({
          name: 'tboard_cards_create',
          arguments: { type: 'task', title: 'Round-trip card' },
        }),
      ) as { id: number; title: string; status: string };

      expect(created.id).toBeGreaterThan(0);
      expect(created.title).toBe('Round-trip card');

      const listed = parseToolJson(
        await client.callTool({ name: 'tboard_cards_list', arguments: {} }),
      ) as Array<{ id: number; title: string }>;

      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(created.id);

      await client.close();
    } finally {
      context.close();
    }
  });

  it('moves a card to a new status through the MCP protocol', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      const created = parseToolJson(
        await client.callTool({
          name: 'tboard_cards_create',
          arguments: { type: 'bug', title: 'Movable card' },
        }),
      ) as { id: number };

      const moved = parseToolJson(
        await client.callTool({
          name: 'tboard_cards_move',
          arguments: { id: created.id, status: 'developing' },
        }),
      ) as { id: number; status: string };

      expect(moved.id).toBe(created.id);
      expect(moved.status).toBe('developing');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('returns an isError result (not a throw) for invalid tool input', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      const result = await client.callTool({
        name: 'tboard_cards_move',
        arguments: { id: 999999, status: 'developing' },
      });

      expect(result.isError).toBe(true);

      await client.close();
    } finally {
      context.close();
    }
  });

  it('logs a received→applied mcp_events pair for a successful tool call', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      await client.callTool({
        name: 'tboard_cards_create',
        arguments: { type: 'task', title: 'Logged card' },
      });

      const events = context.db
        .prepare("SELECT operation, actor, status FROM mcp_events WHERE operation = 'tboard_cards_create'")
        .all() as Array<{ operation: string; actor: string; status: string }>;

      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe('mcp');
      expect(events[0].status).toBe('applied');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('logs a failed mcp_events row when a tool returns an error result', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      await client.callTool({
        name: 'tboard_cards_move',
        arguments: { id: 999999, status: 'developing' },
      });

      const events = context.db
        .prepare("SELECT status FROM mcp_events WHERE operation = 'tboard_cards_move'")
        .all() as Array<{ status: string }>;

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('failed');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('logs an mcp_events row for a resource read', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      await client.readResource({ uri: 'tboard://cards' });

      const events = context.db
        .prepare("SELECT status FROM mcp_events WHERE operation = 'resource:tboard://cards'")
        .all() as Array<{ status: string }>;

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('applied');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('imports evidence files directly over the protocol (createdBy = mcp)', async () => {
    const workspace = await createTempWorkspace();
    const evidenceRoot = path.join(workspace.root, 'evidence-store');
    const db = createDatabase(':memory:');
    runMigrations(db);
    const context = contextForDb(db, { evidenceRoot });
    try {
      const { componentVariantId } = seedComponentVariant(db, { canonicalName: 'gauntlet', mappingKey: 'main' });
      const sourceDir = path.join(workspace.root, 'incoming');
      await mkdir(sourceDir, { recursive: true });
      const sourceFile = path.join(sourceDir, 'proof.log');
      await writeFile(sourceFile, 'evidence contents', 'utf8');

      const client = await connectClient(context);
      const result = parseToolJson(
        await client.callTool({
          name: 'tboard_evidence_import',
          arguments: { componentVariantId, type: 'log', sourceFilePaths: [sourceFile] },
        }),
      ) as { imported: Array<{ id: number; createdBy: string; type: string }>; warnings: unknown[] };

      expect(result.warnings).toHaveLength(0);
      expect(result.imported).toHaveLength(1);
      expect(result.imported[0].createdBy).toBe('mcp');
      expect(result.imported[0].type).toBe('log');

      // Persisted and linked to the variant.
      const stored = context.evidence.listEvidenceForVariant(componentVariantId);
      expect(stored).toHaveLength(1);

      await client.close();
    } finally {
      context.close();
      await workspace.cleanup();
    }
  });

  it('answers tboard_next_work with prioritized actionable work', async () => {
    const context = createInMemoryContext();
    try {
      // urgent bug in needs_fix should rank above a normal task in backlog.
      context.cards.createCard({ type: 'task', title: 'normal task' });
      context.cards.createCard({ type: 'bug', title: 'urgent bug', status: 'needs_fix', priority: 'urgent', severity: 'critical' });
      // A released card is not actionable.
      context.cards.createCard({ type: 'task', title: 'done', status: 'released' });

      const client = await connectClient(context);
      const result = parseToolJson(await client.callTool({ name: 'tboard_next_work', arguments: {} })) as {
        actionableCards: Array<{ title: string; status: string }>;
        generatedAt: string;
      };

      expect(result.actionableCards).toHaveLength(2);
      expect(result.actionableCards[0].title).toBe('urgent bug');
      expect(result.actionableCards.some((card) => card.status === 'released')).toBe(false);
      expect(typeof result.generatedAt).toBe('string');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('exposes read-only resources over the protocol', async () => {
    const context = createInMemoryContext();
    try {
      seedComponentVariant(context.db, { canonicalName: 'gauntlet', mappingKey: 'main' });
      const client = await connectClient(context);

      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri).sort();
      expect(uris).toContain('tboard://cards');
      expect(uris).toContain('tboard://inventory/variants');

      const read = await client.readResource({ uri: 'tboard://inventory/variants' });
      const firstContent = read.contents[0] as { text?: string };
      expect(firstContent.text).toBeDefined();
      const variants = JSON.parse(firstContent.text as string) as Array<{ canonicalName: string }>;
      expect(variants).toHaveLength(1);
      expect(variants[0].canonicalName).toBe('gauntlet');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('gets and sets the workspace root over the protocol', async () => {
    const context = createInMemoryContext();
    try {
      const client = await connectClient(context);

      const before = parseToolJson(await client.callTool({ name: 'tboard_settings_get', arguments: {} })) as {
        workspaceRoot: string | null;
        defaultWorkspaceRoot: string;
      };
      expect(before.workspaceRoot).toBeNull();
      expect(typeof before.defaultWorkspaceRoot).toBe('string');
      expect(before.defaultWorkspaceRoot.length).toBeGreaterThan(0);

      const set = parseToolJson(
        await client.callTool({ name: 'tboard_settings_set_workspace_root', arguments: { workspaceRoot: '/tmp/projects' } }),
      ) as { workspaceRoot: string };
      expect(set.workspaceRoot).toBe('/tmp/projects');

      // Persisted: a fresh read reflects the set value.
      const after = parseToolJson(await client.callTool({ name: 'tboard_settings_get', arguments: {} })) as {
        workspaceRoot: string | null;
      };
      expect(after.workspaceRoot).toBe('/tmp/projects');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('updates a card over the protocol', async () => {
    const context = createInMemoryContext();
    try {
      const created = context.cards.createCard({ type: 'task', title: 'original' });
      const client = await connectClient(context);

      const updated = parseToolJson(
        await client.callTool({
          name: 'tboard_cards_update',
          arguments: { id: created.id, title: 'renamed', priority: 'high' },
        }),
      ) as { id: number; title: string; priority: string };
      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe('renamed');
      expect(updated.priority).toBe('high');

      await client.close();
    } finally {
      context.close();
    }
  });

  it('lists repo mappings over the protocol', async () => {
    const context = createInMemoryContext();
    try {
      seedRepoMapping(context.db, { mappingKey: 'main', sourceRepoPath: '/src/main', targetRepoPath: '/tgt/main' });
      const client = await connectClient(context);

      const mappings = parseToolJson(
        await client.callTool({ name: 'tboard_inventory_list_repo_mappings', arguments: {} }),
      ) as Array<{ id: number }>;
      expect(mappings).toHaveLength(1);
      expect(mappings[0].id).toBeGreaterThan(0);

      await client.close();
    } finally {
      context.close();
    }
  });

  it('previews a command over the protocol without executing it (records a pending op)', async () => {
    const workspace = await createTempWorkspace();
    const context = createInMemoryContext();
    try {
      // preview validates that the repo cwd exists on disk, so point at a real dir.
      const { repoMappingId } = seedRepoMapping(context.db, {
        mappingKey: 'main',
        sourceRepoPath: workspace.root,
        targetRepoPath: workspace.root,
      });
      const client = await connectClient(context);

      const preview = parseToolJson(
        await client.callTool({
          name: 'tboard_commands_preview',
          arguments: { repoMappingId, role: 'source', kind: 'custom', command: 'echo', args: ['hi'] },
        }),
      ) as { pendingOperationId: number | null; summary: { command: string } | null };
      expect(preview.pendingOperationId).not.toBeNull();
      expect(preview.summary?.command).toBe('echo');

      // Nothing was executed: no command_runs rows exist.
      const runs = (context.db.prepare('SELECT COUNT(*) AS n FROM command_runs').get() as { n: number }).n;
      expect(runs).toBe(0);

      // The pending op is recorded and awaiting a human apply.
      const pending = (context.db.prepare("SELECT COUNT(*) AS n FROM pending_operations WHERE kind = 'command' AND status = 'pending'").get() as { n: number }).n;
      expect(pending).toBe(1);

      await client.close();
    } finally {
      context.close();
      await workspace.cleanup();
    }
  });
});

describe('listPendingOperations', () => {
  it('returns pending_operations rows newest first with parsed JSON payload/preview', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      db.prepare(
        `INSERT INTO pending_operations (kind, status, requested_by, summary, payload_json, preview_json, requires_confirmation, created_at)
         VALUES ('copy_folder', 'pending', 'user', 'first operation', '{"a":1}', '{"b":2}', 1, datetime('now', '-1 minute'))`,
      ).run();
      db.prepare(
        `INSERT INTO pending_operations (kind, status, requested_by, summary, payload_json, preview_json, requires_confirmation, created_at)
         VALUES ('copy_folder', 'applied', 'user', 'second operation', '{"a":2}', '{"b":3}', 1, datetime('now'))`,
      ).run();

      const operations = listPendingOperations(db);

      expect(operations).toHaveLength(2);
      expect(operations[0].summary).toBe('second operation');
      expect(operations[1].summary).toBe('first operation');
      expect(operations[0].payload).toEqual({ a: 2 });
      expect(operations[0].preview).toEqual({ b: 3 });
      expect(operations[0].requiresConfirmation).toBe(true);
      expect(operations[0].appliedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('returns an empty array when there are no pending operations', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      expect(listPendingOperations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
