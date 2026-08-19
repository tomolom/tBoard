# tBoard Implementation Slice 1

Date: 2026-08-18  
Status: Draft v0.1

## 1. Slice goal

Build the first vertical slice that proves tBoard's core local loop, generalized across projects:

```text
configure workspace root
  -> scan repo mappings (source repo <-> target repo)
  -> discover tracked components/items
  -> persist inventory in SQLite
  -> show board/matrix
```

This slice ships with exactly one working scanner/profile: the **Roe plugin workflow** (Profile 1), which scans `Roe-apiv3*` dev repos and `community-plugins*` release repos for plugin roots. The scanning pipeline, data model, and UI are written against generic concepts (repo mapping, tracked component, component variant) so a second profile can be added later by adding a new scanner, not by reworking this slice.

This slice is intentionally read-heavy. It creates the foundation for later diff, evidence, Git write, release-copy, and MCP workflows without taking on every full-beta feature at once.

## 2. Why this slice first

The app's value depends on a trustworthy inventory. Before building release automation or MCP writes, it must reliably answer:

- Which repo mappings exist?
- Which components exist in each source repo?
- Which target repos exist?
- Which component variants exist per repo mapping?
- What is the current status of each component variant?

For the Roe profile specifically, that means: which plugins exist in each dev repo, which release repos exist, which plugin variants exist per server, and what is each plugin variant's current status.

If inventory is wrong, Kanban, diffs, evidence, and release automation will all be unreliable.

## 3. In scope

### 3.1 App shell

- Electron desktop app
- TypeScript
- React renderer
- local SQLite database
- typed internal API between renderer and backend

### 3.2 Settings

- configure local workspace root (the parent directory containing all relevant repos)
- store setting in SQLite
- default should support the current expected layout:

```text
C:\Users\tomol\Documents\GitHub
```

### 3.3 Repo-mapping scanner (Roe profile)

Detect source/target repo mappings using the Roe plugin workflow's name convention (Profile 1). This is the only scanner shipped in slice 1; it should be written behind a scanner interface so a future profile can supply an alternate implementation without changing the rest of the pipeline.

Initial known mappings:

| Mapping key | Source repo | Target repo |
| --- | --- | --- |
| `main` | `Roe-apiv3` | `community-plugins` |
| `ferox` | `Roe-apiv3-ferox` | `community-plugins-ferox` |
| `orion` | `Roe-apiv3-orion` | `community-plugins-orion` |
| `osnr` | `Roe-apiv3-osnr` | `community-plugins-osnr` |
| `osrsps` | `Roe-apiv3-osrsps` | `community-plugins-osrsps` |
| `reason` | `Roe-apiv3-reason` | `community-plugins-reason` |
| `amascut` | `Roe-apiv3-amascut` | `community-plugins-amascut` |

Scanner output should upsert:

- `repo_mappings`
- `repos`

### 3.4 Component scanner (Roe profile)

Initial component discovery should use the Roe plugin workflow's named plugin-root conventions. For this profile, a "tracked component" is a plugin root.

Minimum behavior:

- walk each detected source repo
- identify likely component roots (plugin roots)
- derive a canonical component name from the root name
- create/update `components`
- create/update `component_variants`
- mark `source_exists`
- check whether a matching target component root exists
- mark `target_exists`

Implementation note: if actual repo structure is inconsistent, add scanner diagnostics instead of silently guessing.

### 3.5 Inventory UI

Create an initial UI with:

- settings panel for workspace root
- scan button
- scan result summary
- component matrix foundation
- basic Kanban board foundation using component cards/variants

The UI does not need final polish yet, but should be usable enough to verify scanner correctness.

### 3.6 Persistence

- run SQLite migrations on startup
- persist settings, repo mappings, repos, components, and component variants
- keep scan updates idempotent

## 4. Out of scope for slice 1

- release folder copy
- Git commit/push support
- build/test command runner
- full diff dashboard
- evidence import UI
- MCP server
- GitHub integration
- hosted web deployment
- complex manual mapping UI
- a second workflow profile or a profile-authoring UI (the scanner boundary is established, but only the Roe profile ships)

These are planned follow-up slices.

## 5. Recommended project structure

```text
tBoard/
  docs/
    PRD.md
    SQLITE_SCHEMA.md
    IMPLEMENTATION_SLICE_1.md
  package.json
  tsconfig.json
  vite.config.ts
  electron.vite.config.ts
  src/
    main/
      index.ts
      db/
        connection.ts
        migrations.ts
        migrations/
          001_initial_schema.sql
      services/
        settingsService.ts
        repoScanner.ts
        componentScanner.ts
        inventoryService.ts
      profiles/
        roe/
          roeRepoScanner.ts
          roeComponentScanner.ts
      ipc/
        inventoryIpc.ts
        settingsIpc.ts
    preload/
      index.ts
    renderer/
      main.tsx
      App.tsx
      api/
        client.ts
      pages/
        SettingsPage.tsx
        InventoryPage.tsx
        BoardPage.tsx
      components/
        RepoMappingTable.tsx
        ComponentMatrix.tsx
        KanbanBoard.tsx
  tests/
    fixtures/
      repos/
    unit/
      repoScanner.test.ts
      componentScanner.test.ts
      migrations.test.ts
```

`src/main/profiles/roe/` isolates the Roe-specific naming conventions (`Roe-apiv3*`, `community-plugins*`, plugin-root heuristics) behind the generic `repoScanner`/`componentScanner` service interfaces, so `services/` stays profile-agnostic.

## 6. Suggested dependencies

Core:

- `electron`
- `electron-vite`
- `vite`
- `react`
- `react-dom`
- `typescript`
- `better-sqlite3`
- `zod`

Testing:

- `vitest`
- `@testing-library/react`

Future likely additions:

- diff library for file/folder comparison
- MCP SDK
- command runner abstraction
- UI component library

## 7. Internal API draft

Renderer should call typed backend APIs, not filesystem directly.

Initial API surface:

```ts
type SettingsApi = {
  getWorkspaceRootPath(): Promise<string | null>;
  setWorkspaceRootPath(path: string): Promise<void>;
};

type InventoryApi = {
  scanRepos(): Promise<ScanResult>;
  listRepoMappings(): Promise<RepoMappingDto[]>;
  listComponentVariants(): Promise<ComponentVariantOverviewDto[]>;
};
```

DTOs:

```ts
type ScanResult = {
  repoMappingsFound: number;
  reposFound: number;
  componentsFound: number;
  componentVariantsFound: number;
  warnings: ScanWarning[];
};

type ScanWarning = {
  code: string;
  message: string;
  path?: string;
};

type RepoMappingDto = {
  id: number;
  mappingKey: string;
  displayName: string;
  sourceRepoPath: string;
  targetRepoPath: string;
  enabled: boolean;
  lastScannedAt: string | null;
};

type ComponentVariantOverviewDto = {
  componentVariantId: number;
  componentId: number;
  canonicalName: string;
  componentDisplayName: string;
  mappingKey: string;
  mappingDisplayName: string;
  sourceExists: boolean;
  targetExists: boolean;
  lifecycleStatus: string;
  approvalState: string;
  testedState: string;
  releaseState: string;
  sourceComponentRootPath: string | null;
  targetComponentRootPath: string | null;
  openBugCount: number;
  evidenceCount: number;
};
```

## 8. Scanner behavior

### 8.1 Repo-mapping scanner (Roe profile)

Input:

- workspace root directory

Algorithm:

1. List direct child directories.
2. Match known source repo names (`Roe-apiv3*`).
3. For each source repo, derive expected target repo name (`community-plugins*`).
4. If target repo exists, upsert enabled repo mapping.
5. If target repo is missing, upsert disabled or warning-only mapping depending on UX decision.
6. Upsert source/target repo records.

Diagnostics:

- missing target repo
- duplicate repo name
- inaccessible directory
- unexpected matching repo

### 8.2 Component scanner (Roe profile)

Input:

- repo mapping
- source repo path
- target repo path

Initial component-root heuristic (plugin-root heuristic for this profile):

1. Search source repo for likely component root directories by naming convention.
2. Derive canonical component name from root directory.
3. Check for matching target component root by same relative/named root.
4. Upsert component and component variant.

Required scanner output per component variant:

- canonical component name
- display name
- source root path
- target root path if found
- source exists
- target exists
- warnings

If the real repo layout proves more complex, slice 1 should add explicit warnings rather than expanding into full custom mapping UI immediately.

## 9. UI requirements for slice 1

### 9.1 Settings page

- text field for workspace root path
- save button
- scan button
- latest scan summary
- warnings list

### 9.2 Inventory page

- repo-mapping table
- component variant table/matrix
- filters by mapping and existence state
- show source/target paths
- show scan warnings

### 9.3 Board page

- basic columns using lifecycle statuses
- component variant cards generated from inventory
- card shows component name, mapping, source/target existence, approval/test/release state
- drag/drop can be deferred if table controls are faster for first verification

## 10. Verification plan

### 10.1 Unit tests

Create fixture directories that mimic Roe repo naming.

Tests:

- repo-mapping scanner detects all known Roe repo mappings
- repo-mapping scanner reports missing target repo
- component scanner derives canonical component names
- component scanner sets `source_exists` and `target_exists`
- repeated scan is idempotent
- migrations create expected tables/views

### 10.2 Manual verification

Against the real local GitHub directory:

1. Set workspace root path to `C:\Users\tomol\Documents\GitHub`.
2. Run scan.
3. Confirm expected repo mappings appear.
4. Confirm component inventory looks plausible.
5. Confirm warnings identify uncertain/missing mappings.
6. Restart app.
7. Confirm persisted inventory reloads.

### 10.3 Acceptance criteria

Slice 1 is done when:

- app starts successfully
- database initializes from migration
- workspace root path can be saved
- scan detects known repo mappings (Roe profile)
- scan persists repo mappings and repos
- scan discovers component variants from source repos
- inventory UI shows component variants grouped by repo mapping
- board UI shows component variant cards by lifecycle status
- repeated scans update existing rows rather than duplicating data
- scanner warnings are visible to the user

## 11. Follow-up slices

### Slice 2: diff dashboard

- folder diff summary per component variant
- changed/added/deleted files
- descriptor/config/guide highlighting
- persist `diff_snapshots`

### Slice 3: evidence library

- attach/copy evidence files
- per-component evidence folders
- evidence metadata
- link evidence to cards and component variants

### Slice 4: release copy workflow

- preview source-to-target folder copy
- confirm copy
- record pending/apply operation
- show resulting target repo diff

### Slice 5: command runner and Git workflow

- Git status/diff/fetch/pull/commit/push
- build/test/custom commands
- command logs
- strict confirmation gates

### Slice 6: MCP server

- board read API
- card/evidence write API
- pending operations for risky writes
- agent event log

### Slice 7 (future, not yet planned in detail): second workflow profile

- add a second scanner implementing the repo-mapping/component-detection interfaces for a non-Roe project
- confirm the generic schema and pipeline require no changes beyond new scanner logic and profile configuration

## 12. Immediate implementation checklist

1. Scaffold Electron/Vite/React/TypeScript app.
2. Add SQLite dependency and migration runner.
3. Add `001_initial_schema.sql` from `docs/SQLITE_SCHEMA.md`.
4. Implement settings service.
5. Implement Roe repo-mapping scanner behind a generic scanner interface.
6. Implement Roe component (plugin-root) scanner behind a generic scanner interface.
7. Implement inventory read models/DTOs.
8. Add Settings and Inventory pages.
9. Add basic Board page.
10. Add unit tests with fixture repos.
11. Run against real GitHub folder and refine scanner warnings.
