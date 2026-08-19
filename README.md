# tBoard

Local-first Electron workflow board for source-to-target repository tracking.

The first workflow profile is Roe plugin development: `Roe-apiv3*` source repos mapped to matching `community-plugins*` target repos.

## Current capabilities

- Configure workspace root.
- Scan Roe source/target repo mappings.
- Discover Roe plugin/component roots via `@PluginDescriptor`.
- Persist inventory in local SQLite.
- Show repo mappings, component matrix, and component variants.
- Scan source-vs-target file diffs.
- Import evidence files into app-managed per-component folders.
- Preview and explicitly apply non-destructive source-to-target folder copies.
- Create and move mixed Kanban cards.
- Run local git/build/test/lint/custom commands against mapped repos under strict preview→apply safety, with full run logging and output capture (see [Command runner](#command-runner)).
- Standalone MCP stdio server exposing safe, read-mostly tBoard tools/resources (see [MCP server](#mcp-server)).

## Install

```bash
npm install
npm run postinstall
```

`postinstall` runs `electron-rebuild` for native `better-sqlite3` support inside Electron.

## Run

```bash
npm run dev
```

On first run the workspace field is pre-filled with your OS documents folder (via `settings.getDefaultWorkspaceRoot()`); point it at the parent folder containing your source and target repos and click Save. The default is only a suggestion — nothing is persisted until you Save.

## Package

Build a distributable Windows app (NSIS installer + portable exe) with electron-builder:

```bash
npm run dist
```

Artifacts are written to `dist/`. For a fast unpacked build (no installer) while iterating on packaging:

```bash
npm run dist:dir
```

Native module note: `better-sqlite3` v13 is an N-API module and ships ABI-stable prebuilt binaries, so the same binary works under both Node (tests) and Electron (app). Packaging config (`electron-builder.yml`) sets `npmRebuild: false` and unpacks `node_modules/better-sqlite3/**` from the asar (native `.node` files cannot be loaded from inside an asar archive). `postinstall` runs `electron-builder install-app-deps` to keep native deps matched to the Electron version.

Windows/OneDrive note: packaging into a OneDrive-synced folder (e.g. under `Documents`) can fail with `EPERM` while electron-builder renames its staging dir. If that happens, point the output elsewhere, e.g. `npx electron-builder --dir -c.directories.output=$env:LOCALAPPDATA\tboard-dist`.

## Verify

```bash
npm run typecheck
npm run test:run
npm run build
```

End-to-end MCP stdio smoke (spawns the real server against a throwaway DB):

```bash
npm run mcp:smoke
```

Optional real local workspace smoke:

```powershell
$env:TBOARD_WORKSPACE_ROOT='C:\Users\tomol\Documents\GitHub'
$env:TBOARD_SCAN_DIFFS='1'
npm run test:run -- tests/integration/localWorkspaceScan.test.ts
```

## Safety notes

- Diff scans are read-only.
- Evidence import copies files into the app evidence store; it does not mutate source repos.
- Release copy is non-destructive: it copies added/modified source files into the target component folder and preserves target-only files. Nothing is deleted.
- Release copy requires preview first, then explicit apply from the UI.
- Command execution is read-only by default (`commands.gitStatus`); any mutating command is preview-first, then explicit apply, and is recorded to `command_runs` (git commands also to `git_operations`) with captured output. See [Command runner](#command-runner).

## Command runner

tBoard can run local commands (git/build/test/lint/release/custom) against the source or target repo of a mapping, under the strict safety model from `docs/PRD.md` §10.

### Safety model

- **Read-only inspection needs no confirmation.** `commands.gitStatus(repoMappingId, role)` returns a structured git status snapshot (branch, HEAD, dirty state, ahead/behind, entries) and never mutates the repo.
- **Every mutating command is preview→apply.** `commands.preview(input)` records a `pending_operations` row (`kind = 'command'`, `requires_confirmation = 1`) and captures a *before* git status; it runs nothing. `commands.apply(pendingOperationId)` executes only a still-pending operation, then captures an *after* git status.
- **No shell.** Commands execute via argv (`command` + `args[]`) with `shell: false`, so arguments (card titles, paths, etc.) are never shell-interpreted — no injection.
- **Always bounded.** Every run has a timeout (default 120s) and captured output is truncated at a byte cap; both conditions are flagged in the result.
- **Everything is logged.** Each executed command writes a `command_runs` row with captured stdout/stderr saved to files under the app's `command-output` directory; git commands additionally write a `git_operations` row with before/after status JSON. A failed, non-zero, or timed-out run marks the pending operation `failed` — never `applied`.
- **Output is viewable in-app.** Captured stdout/stderr can be read back in the panel (bounded read, on demand) from both the apply result and the run history, and "Reveal in folder" opens the containing `command-output` directory in the OS file manager.

### Not exposed over MCP

The command runner is an **app-only** capability (renderer → IPC → main). It is intentionally **not** part of the MCP tool surface: agents cannot spawn local processes through tBoard. Command execution remains a human-confirmed action in the desktop app.

## MCP server

tBoard ships a standalone MCP (Model Context Protocol) stdio server exposing read-mostly, safe tBoard capabilities to MCP-compatible clients (e.g. agent tooling), independent of the Electron app.

### Run

```bash
npm run mcp:dev
```

This runs `tsx src/mcp/stdio.ts`, which opens (or creates) a SQLite database, runs migrations, and serves MCP over stdio using `StdioServerTransport`.

To verify the server boots and answers over the protocol without wiring up an external client, run:

```bash
npm run mcp:smoke
```

This spawns the real `src/mcp/stdio.ts` entrypoint via the MCP SDK's `StdioClientTransport` against a throwaway temp database, asserts the safe tool surface, and round-trips a card create/list. It exits non-zero on failure, so it doubles as a CI gate.

### Env vars

| Variable | Purpose | Default |
| --- | --- | --- |
| `TBOARD_DB_PATH` | Path to the SQLite database file the MCP server opens/creates. | The **same** per-user database the desktop app uses (`<userData>/tboard.sqlite`), so the app and MCP share one board out of the box |
| `TBOARD_EVIDENCE_ROOT` | Root folder for evidence lookups exposed by the MCP server. | A sibling `evidence` folder next to the resolved DB path |
| `TBOARD_COMMAND_OUTPUT_ROOT` | Root folder for captured command stdout/stderr read back by `tboard_commands_read_run_output`. | A sibling `command-output` folder next to the resolved DB path |

The MCP server runs migrations automatically on startup and creates parent directories for the database path as needed. By default it opens the **same** database the desktop app uses: both resolve their path through the shared, Electron-free `src/shared/appPaths.ts` resolver (`<userData>/tboard.sqlite`, e.g. `%APPDATA%\tboard\tboard.sqlite` on Windows), so an agent driving MCP and the running app share one board with no configuration. Set `TBOARD_DB_PATH` to point at an isolated file (tests, throwaway boards). Because both processes can now open the same file at once, the SQLite connection uses WAL mode + a 5s busy timeout so concurrent reads/writes don't collide.

### Tools

| Tool | Backing call | Notes |
| --- | --- | --- |
| `tboard_cards_list` | `CardService.listCards()` | Read-only |
| `tboard_cards_create` | `CardService.createCard(input)` | Writes a `cards` row only |
| `tboard_cards_update` | `CardService.updateCard(id, input)` | Writes a `cards` row only; only provided fields change |
| `tboard_cards_move` | `CardService.moveCard(id, status)` | Writes a `cards` row only |
| `tboard_settings_get` | `SettingsService.getWorkspaceRoot()` + default | Read-only; returns configured workspace root (null if unset) + OS default |
| `tboard_settings_set_workspace_root` | `SettingsService.setWorkspaceRoot(path)` | Project Setup step; writes `app_settings` only, touches no repo |
| `tboard_inventory_scan` | `InventoryService.scanWorkspace(workspaceRoot?)` | Read-only against source/target repos; writes inventory tables |
| `tboard_inventory_list_variants` | `InventoryService.listComponentVariants()` | Read-only |
| `tboard_inventory_list_repo_mappings` | `InventoryService.listRepoMappings()` | Read-only |
| `tboard_diff_scan` | `DiffService.scanDiffs()` | Read-only against source/target repos; writes `diff_snapshots` |
| `tboard_diff_list` | `DiffService.listDiffOverviews()` | Read-only |
| `tboard_evidence_list` | `EvidenceService.listEvidence()` | Read-only |
| `tboard_evidence_list_for_variant` | `EvidenceService.listEvidenceForVariant(id)` | Read-only |
| `tboard_release_preview_copy` | `ReleaseCopyService.previewCopy(id)` | Creates a pending `copy_folder` operation row only; **never writes to the filesystem** |
| `tboard_evidence_import` | `EvidenceService.importFiles(id, type, paths, 'mcp')` | **Filesystem write**: copies existing files into the app evidence store and links them to a variant; never touches source/target repos |
| `tboard_commands_git_status` | `CommandService.gitStatus(mappingId, role)` | Read-only `git status` snapshot; no confirmation |
| `tboard_commands_preview` | `CommandService.preview(input)` | Records a pending `command` operation only; **runs nothing** until a human applies it in the app |
| `tboard_commands_list_runs` | `CommandService.listRuns(limit?)` | Read-only; recorded runs newest first |
| `tboard_commands_read_run_output` | `CommandService.readRunOutput(runId)` | Read-only; captured stdout/stderr bounded to 1MB/stream |
| `tboard_next_work` | `computeNextWork(context)` | Read-only; prioritized "what needs work" (actionable cards, drifted variants, open bugs, missing source/target) |
| `tboard_pending_operations_list` | Direct read of `pending_operations` | Read-only, newest first |

**Preview-only boundary — the two dangerous *apply* mutations are NOT exposed over MCP:** `release.applyCopy` (writes to target repos) and `commands.apply` (executes a local subprocess). Agents can drive the entire app up to the confirmation step — read everything, edit cards, configure the workspace, scan, and create pending command/release operations — but **applying** a pending command or release copy is deliberately human-only in the desktop app. This preserves the preview→apply confirmation invariant as the single human gate on repo writes and process execution.

**Filesystem writes over MCP:** `tboard_evidence_import` is the one MCP tool that writes to the filesystem — it copies files into the app-managed evidence store (never into source/target repos). This is a deliberate allowance so agents can attach evidence (PRD §3.5); every import is logged to `mcp_events` like any other MCP action.

All tools return JSON text content; caught errors are returned with `isError: true` rather than throwing across the protocol boundary.

Every tool call and resource read is logged to the `mcp_events` table (PRD §9: *"every MCP action is logged"*) as a received→applied/failed pair, with the request and response payloads recorded. Logging is best-effort and never fails the underlying action.

### Resources

- `tboard://cards`
- `tboard://inventory/variants`
- `tboard://diffs`
- `tboard://pending-operations`

Each resource returns the same JSON payload as its corresponding list tool.

## Docs

- `docs/PRD.md`
- `docs/SQLITE_SCHEMA.md`
- `docs/IMPLEMENTATION_SLICE_1.md`
