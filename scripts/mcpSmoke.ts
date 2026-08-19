#!/usr/bin/env node
/**
 * Durable end-to-end smoke test for the tBoard MCP stdio server.
 *
 * Spawns the REAL `src/mcp/stdio.ts` entrypoint as a child process via the MCP
 * SDK's StdioClientTransport (so it exercises actual process boot, DB path
 * resolution, migrations, and stdio JSON-RPC framing — none of which the
 * in-memory unit test covers), then drives it over the protocol:
 *   1. initialize + list tools, asserting the safe tool surface
 *   2. create a card, list cards, and confirm the round-trip
 *
 * Uses a throwaway temp DB via TBOARD_DB_PATH so it never touches a real board.
 * Exits non-zero on any failure, making it usable as a CI/local gate:
 *   npm run mcp:smoke
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = [
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
].sort();

type TextContent = { type: string; text?: string };

function parseToolJson(result: unknown): unknown {
  const content = ((result as { content?: unknown }).content ?? []) as TextContent[];
  const textPart = content.find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart || typeof textPart.text !== 'string') {
    throw new Error('tool result had no text content');
  }
  return JSON.parse(textPart.text) as unknown;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Smoke assertion failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, '..');
  const stdioEntry = path.join(projectRoot, 'src', 'mcp', 'stdio.ts');

  const tempDir = mkdtempSync(path.join(tmpdir(), 'tboard-mcp-smoke-'));
  const dbPath = path.join(tempDir, 'tboard.sqlite');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), stdioEntry],
    env: {
      ...(process.env as Record<string, string>),
      TBOARD_DB_PATH: dbPath,
      TBOARD_EVIDENCE_ROOT: path.join(tempDir, 'evidence'),
    },
    cwd: projectRoot,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'tboard-mcp-smoke', version: '0.0.0' });

  try {
    await client.connect(transport);
    console.log('[smoke] connected to tBoard MCP stdio server');

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert(
      names.length === EXPECTED_TOOLS.length && names.every((n, i) => n === EXPECTED_TOOLS[i]),
      `tool surface mismatch.\n  expected: ${EXPECTED_TOOLS.join(', ')}\n  actual:   ${names.join(', ')}`,
    );
    for (const name of names) {
      assert(!/apply/i.test(name), `unsafe tool exposed over MCP: ${name}`);
    }
    console.log(`[smoke] tool surface OK (${names.length} safe tools, no apply/write tools)`);

    const created = parseToolJson(
      await client.callTool({
        name: 'tboard_cards_create',
        arguments: { type: 'task', title: 'MCP smoke card' },
      }),
    ) as { id: number; title: string };
    assert(typeof created.id === 'number' && created.id > 0, 'created card missing id');
    assert(created.title === 'MCP smoke card', 'created card title mismatch');
    console.log(`[smoke] created card #${created.id} over the protocol`);

    const listed = parseToolJson(
      await client.callTool({ name: 'tboard_cards_list', arguments: {} }),
    ) as Array<{ id: number }>;
    assert(
      listed.some((card) => card.id === created.id),
      'created card not returned by tboard_cards_list',
    );
    console.log('[smoke] card round-trip OK');

    console.log('[smoke] PASS');
  } finally {
    await client.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[smoke] FAIL:', error instanceof Error ? error.message : error);
  process.exit(1);
});
