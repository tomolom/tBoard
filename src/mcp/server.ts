import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { CardPriority, CardSeverity, CardStatus, CardType, CommandRunKind, EvidenceType, RepoRole } from '../shared/api';
import { resolveDefaultWorkspaceRoot } from './context';
import type { TBoardMcpContext } from './context';
import { recordMcpOutcome, recordMcpReceived } from './mcpEvents';
import { computeNextWork } from './nextWork';
import { listPendingOperations } from './pendingOperations';

const CARD_TYPES = ['component', 'bug', 'task', 'release', 'evidence'] as const satisfies readonly CardType[];
const CARD_STATUSES = [
  'backlog',
  'developing',
  'untested',
  'needs_fix',
  'approved',
  'released',
  'archived',
] as const satisfies readonly CardStatus[];
const CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const satisfies readonly CardPriority[];
const CARD_SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'] as const satisfies readonly CardSeverity[];
const EVIDENCE_TYPES = [
  'snapshot',
  'recording',
  'log',
  'screenshot',
  'note',
  'agent_summary',
  'other',
] as const satisfies readonly EvidenceType[];
const REPO_ROLES = ['source', 'target'] as const satisfies readonly RepoRole[];
const COMMAND_RUN_KINDS = ['git', 'build', 'test', 'lint', 'release', 'custom'] as const satisfies readonly CommandRunKind[];

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function jsonResource(uri: string, value: unknown): ReadResourceResult {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Builds an MCP server exposing tBoard's read-mostly, safe capabilities over
 * stdio. Deliberately excludes any tool that can write to a target repository
 * (e.g. release.applyCopy) or the filesystem outside the app-managed evidence
 * store's import path. `previewCopy` is included because it only inserts a
 * `pending_operations` row; it never touches the filesystem.
 *
 * Every tool call and resource read is recorded to `mcp_events` (PRD §9:
 * "every MCP action is logged") via `runLogged` / `runResource`, which log a
 * received→applied/failed pair per invocation. Logging is best-effort and can
 * never fail the underlying action.
 */
export function createTBoardMcpServer(context: TBoardMcpContext): McpServer {
  const server = new McpServer({
    name: 'tboard-mcp',
    version: '0.1.0',
  });

  /**
   * Runs a tool producer with mcp_events logging, normalizing sync/async
   * producers and mapping success/failure to jsonResult/errorResult. Kept as a
   * closure so each registerTool handler stays a thin arrow whose args are still
   * inferred from its inputSchema.
   */
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
    'tboard_cards_list',
    {
      title: 'List Kanban cards',
      description: 'Lists all tBoard Kanban cards, ordered by lifecycle status then most recently updated.',
      inputSchema: {},
    },
    () => runLogged('tboard_cards_list', {}, () => context.cards.listCards()),
  );

  server.registerTool(
    'tboard_cards_create',
    {
      title: 'Create a Kanban card',
      description: 'Creates a new tBoard Kanban card, optionally linked to a component variant.',
      inputSchema: {
        type: z.enum(CARD_TYPES),
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        status: z.enum(CARD_STATUSES).optional(),
        priority: z.enum(CARD_PRIORITIES).optional(),
        severity: z.enum(CARD_SEVERITIES).optional(),
        componentVariantId: z.number().int().nullable().optional(),
        componentId: z.number().int().nullable().optional(),
        repoMappingId: z.number().int().nullable().optional(),
        source: z.string().optional(),
        createdBy: z.string().optional(),
      },
    },
    (args) => runLogged('tboard_cards_create', args, () => context.cards.createCard(args)),
  );

  server.registerTool(
    'tboard_cards_move',
    {
      title: 'Move a Kanban card',
      description: 'Moves a tBoard Kanban card to a new lifecycle status.',
      inputSchema: {
        id: z.number().int(),
        status: z.enum(CARD_STATUSES),
      },
    },
    (args) => runLogged('tboard_cards_move', args, () => context.cards.moveCard(args.id, args.status)),
  );

  server.registerTool(
    'tboard_cards_update',
    {
      title: 'Update a Kanban card',
      description:
        'Updates editable fields of a tBoard Kanban card (title, description, status, priority, severity, linked component variant). Only provided fields are changed.',
      inputSchema: {
        id: z.number().int(),
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        status: z.enum(CARD_STATUSES).optional(),
        priority: z.enum(CARD_PRIORITIES).optional(),
        severity: z.enum(CARD_SEVERITIES).optional(),
        componentVariantId: z.number().int().nullable().optional(),
      },
    },
    (args) => {
      const { id, ...input } = args;
      return runLogged('tboard_cards_update', args, () => context.cards.updateCard(id, input));
    },
  );

  server.registerTool(
    'tboard_inventory_scan',
    {
      title: 'Scan workspace inventory',
      description:
        'Scans the configured (or given) workspace root for repo mappings and component variants using the active workflow profile (auto-detected: RoeLite source->target pairs if present, otherwise a generic profile where each git repo is a single-repo project). Read-only against the scanned repos.',
      inputSchema: {
        workspaceRoot: z.string().optional(),
      },
    },
    (args) => runLogged('tboard_inventory_scan', args, () => context.inventory.scanWorkspace(args.workspaceRoot)),
  );

  server.registerTool(
    'tboard_inventory_list_variants',
    {
      title: 'List component variants',
      description: 'Lists all known component variants with their source/target existence and lifecycle state.',
      inputSchema: {},
    },
    () => runLogged('tboard_inventory_list_variants', {}, () => context.inventory.listComponentVariants()),
  );

  server.registerTool(
    'tboard_inventory_list_repo_mappings',
    {
      title: 'List repo mappings',
      description:
        'Lists all repo mappings discovered by the last workspace scan. Each mapping is either a single-repo project (mappingKind "single", no release target) or a source->target pair (mappingKind "source_target").',
      inputSchema: {},
    },
    () => runLogged('tboard_inventory_list_repo_mappings', {}, () => context.inventory.listRepoMappings()),
  );

  server.registerTool(
    'tboard_diff_scan',
    {
      title: 'Scan source/target diffs',
      description:
        'Recomputes source-vs-target file diffs and persists diff snapshots. Applies ONLY to source_target mappings; single-repo projects have no release target and are skipped. Read-only against the repos.',
      inputSchema: {},
    },
    () => runLogged('tboard_diff_scan', {}, () => context.diff.scanDiffs()),
  );

  server.registerTool(
    'tboard_diff_list',
    {
      title: 'List diff overviews',
      description: 'Lists the latest diff snapshot summary for every component variant.',
      inputSchema: {},
    },
    () => runLogged('tboard_diff_list', {}, () => context.diff.listDiffOverviews()),
  );

  server.registerTool(
    'tboard_evidence_list',
    {
      title: 'List all evidence',
      description: 'Lists all evidence records across every component variant, most recently imported first.',
      inputSchema: {},
    },
    () => runLogged('tboard_evidence_list', {}, () => context.evidence.listEvidence()),
  );

  server.registerTool(
    'tboard_evidence_list_for_variant',
    {
      title: 'List evidence for a component variant',
      description: 'Lists evidence records scoped to a single component variant, most recently imported first.',
      inputSchema: {
        componentVariantId: z.number().int(),
      },
    },
    (args) => runLogged('tboard_evidence_list_for_variant', args, () => context.evidence.listEvidenceForVariant(args.componentVariantId)),
  );

  server.registerTool(
    'tboard_evidence_import',
    {
      title: 'Import evidence files',
      description:
        'Imports one or more existing files into the app-managed evidence store and links them to a component variant. Copies files into the tBoard evidence store (a filesystem write) and records evidence rows; it never modifies source or target repos. Source files must already exist on disk.',
      inputSchema: {
        componentVariantId: z.number().int(),
        type: z.enum(EVIDENCE_TYPES),
        sourceFilePaths: z.array(z.string().min(1)).min(1),
      },
    },
    (args) =>
      runLogged('tboard_evidence_import', args, () =>
        context.evidence.importFiles(args.componentVariantId, args.type, args.sourceFilePaths, 'mcp'),
      ),
  );

  server.registerTool(
    'tboard_release_preview_copy',
    {
      title: 'Preview a release copy',
      description:
        'Previews a non-destructive source-to-target folder copy for a component variant and records a pending copy_folder operation. Applies ONLY to source_target mappings; for a single-repo project it returns a release_not_applicable warning. Does NOT write to the filesystem; nothing is copied until a human applies the pending operation from the app.',
      inputSchema: {
        componentVariantId: z.number().int(),
      },
    },
    (args) => runLogged('tboard_release_preview_copy', args, () => context.releaseCopy.previewCopy(args.componentVariantId)),
  );

  server.registerTool(
    'tboard_pending_operations_list',
    {
      title: 'List pending operations',
      description: 'Lists pending_operations rows (e.g. pending release copies) newest first. Read-only; does not apply or confirm any operation.',
      inputSchema: {},
    },
    () => runLogged('tboard_pending_operations_list', {}, () => listPendingOperations(context.db)),
  );

  server.registerTool(
    'tboard_next_work',
    {
      title: 'Ask what needs work',
      description:
        'Returns a prioritized, read-only summary of what needs attention: actionable cards (highest priority/severity first), component variants with source/target drift, variants with open bugs, and variants missing a source or target root.',
      inputSchema: {},
    },
    () => runLogged('tboard_next_work', {}, () => computeNextWork(context)),
  );

  server.registerTool(
    'tboard_settings_get',
    {
      title: 'Get project settings',
      description:
        'Returns the current project configuration: the configured workspace root (null if the project has not been set up yet) and a sensible OS default workspace root.',
      inputSchema: {},
    },
    () =>
      runLogged('tboard_settings_get', {}, () => ({
        workspaceRoot: context.settings.getWorkspaceRoot(),
        defaultWorkspaceRoot: resolveDefaultWorkspaceRoot(),
      })),
  );

  server.registerTool(
    'tboard_settings_set_workspace_root',
    {
      title: 'Set the workspace root',
      description:
        'Sets (or changes) the project workspace root — the parent folder scanned for source/target repos. This is the one-time Project Setup step; run tboard_inventory_scan afterwards to populate the board. Persists to app settings only; it does not touch any repo.',
      inputSchema: {
        workspaceRoot: z.string().min(1),
      },
    },
    (args) =>
      runLogged('tboard_settings_set_workspace_root', args, () => {
        context.settings.setWorkspaceRoot(args.workspaceRoot);
        return { workspaceRoot: context.settings.getWorkspaceRoot() };
      }),
  );

  server.registerTool(
    'tboard_commands_git_status',
    {
      title: 'Read git status',
      description:
        'Returns a read-only git status snapshot for one repo of a mapping. Use role "source" for the primary repo (the only repo of a single-repo project) or "target" for the release repo of a source_target mapping. No confirmation required; runs `git status` read-only and never mutates the repo.',
      inputSchema: {
        repoMappingId: z.number().int(),
        role: z.enum(REPO_ROLES),
      },
    },
    (args) => runLogged('tboard_commands_git_status', args, () => context.commands.gitStatus(args.repoMappingId, args.role)),
  );

  server.registerTool(
    'tboard_commands_preview',
    {
      title: 'Preview a command',
      description:
        'Previews a mutating local command (git/build/test/lint/custom) against one repo of a mapping and records a pending_operations row. Use role "source" for the primary repo (single-repo projects only have this) or "target" for the release repo. Runs NOTHING — the command is only executed when a human applies the pending operation from the app. Commands are spawned shell-free (argv, no pipes/redirects/globs).',
      inputSchema: {
        repoMappingId: z.number().int(),
        role: z.enum(REPO_ROLES),
        kind: z.enum(COMMAND_RUN_KINDS),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        cardId: z.number().int().nullable().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    (args) => runLogged('tboard_commands_preview', args, () => context.commands.preview(args)),
  );

  server.registerTool(
    'tboard_commands_list_runs',
    {
      title: 'List command runs',
      description: 'Lists recorded command runs newest first, with an optional bounded limit (omit for all). Read-only; includes the total count.',
      inputSchema: {
        limit: z.number().int().positive().nullable().optional(),
      },
    },
    (args) => runLogged('tboard_commands_list_runs', args, () => context.commands.listRuns(args.limit ?? null)),
  );

  server.registerTool(
    'tboard_commands_read_run_output',
    {
      title: 'Read command run output',
      description: 'Reads the captured stdout/stderr for a recorded command run (bounded to 1MB per stream). Read-only.',
      inputSchema: {
        runId: z.number().int(),
      },
    },
    (args) => runLogged('tboard_commands_read_run_output', args, () => context.commands.readRunOutput(args.runId)),
  );

  server.registerResource(
    'tboard-cards',
    'tboard://cards',
    {
      title: 'tBoard Kanban cards',
      description: 'All tBoard Kanban cards as JSON.',
      mimeType: 'application/json',
    },
    (uri) => runResource('resource:tboard://cards', uri.href, () => context.cards.listCards()),
  );

  server.registerResource(
    'tboard-inventory-variants',
    'tboard://inventory/variants',
    {
      title: 'tBoard component variants',
      description: 'All known component variants as JSON.',
      mimeType: 'application/json',
    },
    (uri) => runResource('resource:tboard://inventory/variants', uri.href, () => context.inventory.listComponentVariants()),
  );

  server.registerResource(
    'tboard-diffs',
    'tboard://diffs',
    {
      title: 'tBoard diff overviews',
      description: 'Latest diff snapshot summary per component variant as JSON.',
      mimeType: 'application/json',
    },
    (uri) => runResource('resource:tboard://diffs', uri.href, () => context.diff.listDiffOverviews()),
  );

  server.registerResource(
    'tboard-pending-operations',
    'tboard://pending-operations',
    {
      title: 'tBoard pending operations',
      description: 'Pending operations (e.g. pending release copies) as JSON, newest first.',
      mimeType: 'application/json',
    },
    (uri) => runResource('resource:tboard://pending-operations', uri.href, () => listPendingOperations(context.db)),
  );

  return server;
}
