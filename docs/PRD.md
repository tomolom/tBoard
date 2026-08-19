# tBoard Product Requirements Document

Date: 2026-08-18  
Status: Draft v0.1

## 1. Summary

tBoard is a local-first Electron desktop app for tracking software delivery work across paired repositories: mapping one or more **source repos** (development/work repos) to matching **target repos** (release/deployment/hub repos), and tracking the components, tasks, bugs, and evidence that flow between them.

tBoard is built to be **generic across projects**. Any project that maps source repositories to target repositories, and needs a status board for the trackable units living inside them, can configure it as a **workflow profile**. The app ships with one concrete, fully working profile at v0.1:

- **Profile 1: Roe Plugin Workflow** — tracks RoeLite/RuneLite plugin development across multiple Roe API development repositories and matching `community-plugins` release repositories.

Roe plugin tracking is the primary initial use case and proves out the whole product loop end to end, but it is a *profile*, not the product's identity. The core data model, scanning pipeline, diffing, evidence system, and MCP integration are all designed generically so a second profile (a different repo-naming convention, a different kind of tracked unit) can be added later without a rewrite.

The app combines:

- mixed-card Kanban tracking for tracked components, bugs, tasks, releases, and testing evidence
- a component/target-variant status matrix
- source-vs-target diff tracking
- per-component evidence organization for snapshots, recordings, logs, and notes
- strict-safety local Git/build/release workflows
- MCP integration so agents can read, create, update, and attach evidence to board items

The first version targets a single local user, but the UI/backend boundaries should preserve a future path to a hosted web app.

## 2. Problem

Multi-repo project work commonly spans many local repositories: one or more **source repos** where development happens, and one or more matching **target repos** where finished work is released, published, or handed off. It is difficult to answer basic operational questions:

- Which tracked components are approved, untested, broken, blocked, or released?
- Which components differ between source and target repositories?
- Which bugs came from manual notes, chat reports, recordings, or agents?
- Which snapshot/log/recording proves a component was tested or still fails?
- What changed since a component was last pushed to its target repo?
- What should an agent work on next, and how should it report findings back?

### 2.1 Profile 1 concrete example: Roe plugin development

For the initial user, this problem shows up as RoeLite/RuneLite plugin development spanning:

- development repos such as `Roe-apiv3`, `Roe-apiv3-ferox`, `Roe-apiv3-orion`, `Roe-apiv3-osnr`, `Roe-apiv3-osrsps`, `Roe-apiv3-reason`, and `Roe-apiv3-amascut`
- release/community hub repos such as `community-plugins`, `community-plugins-ferox`, `community-plugins-orion`, `community-plugins-osnr`, `community-plugins-osrsps`, `community-plugins-reason`, and `community-plugins-amascut`

In the generic model, each `Roe-apiv3*` repo is a **source repo**, each `community-plugins*` repo is its paired **target repo**, and each plugin is a **tracked component**. This mapping is the app's first configured, working profile — see section 6.6.

## 3. Goals

### 3.1 Unified tracked-item board

Track work across all configured repo mappings using mixed card types:

- Component (the tracked unit itself — a plugin, a package, a module, or whatever a profile defines)
- Bug
- Task
- Release candidate
- Testing/evidence item

### 3.2 Source/target diff visibility

Map source repositories to target repositories (by naming convention, or manually) and show layered diffs:

- changed component roots
- added/deleted/modified files
- descriptor/config/guide changes
- commit deltas where available
- full folder diff on demand

### 3.3 Evidence-first testing workflow

Store development/testing evidence in per-component folders:

- `.ndjson` snapshots
- `.bin` recordings
- logs
- screenshots
- manual notes
- agent summaries

Evidence should link directly to components, target variants, bugs, tasks, and release candidates.

### 3.4 Local workflow automation

Support full local repo workflows over time:

- Git status/diff/branch/fetch/pull/commit/push
- source-to-target component folder copy
- build/test/lint/custom commands
- release packaging/checklists

All write operations must use strict safety controls.

### 3.5 Agent/MCP integration

Expose a local MCP API so agents can:

- create cards
- update card status
- attach evidence
- query board state
- ask what needs work
- record implementation/testing/release notes

### 3.6 Generalization across projects

Keep the data model, scanning pipeline, and workflows profile-driven rather than hard-coded to one project's naming conventions, so that:

- a new project can define its own source/target repo-mapping convention
- a new project can define what counts as a "tracked component" for its repos
- the Roe plugin workflow remains available as Profile 1 without special-casing it in the core engine

This goal is architectural, not a v1 UI requirement — v1 ships with Profile 1 (Roe) fully built and the extension points documented, not a profile-authoring UI.

## 4. Non-goals for the first release

- hosted multi-user deployment
- GitHub Projects sync
- GitHub Issues as the primary source of truth
- Discord bot ingestion
- cloud evidence storage
- automatic approval without user review
- fully automated release publishing without confirmation
- a general-purpose profile-authoring UI (profiles are configured/extended in code for v0.1; only Profile 1 ships)

GitHub integration is desirable later, but v1 should focus on local repos, local evidence, local Git, and MCP.

## 5. Users

### 5.1 Primary user

The initial user is a developer maintaining work across multiple local source/target repo pairs. Concretely at v0.1, that is the developer maintaining many RoeLite/RuneLite plugins across multiple server branches and release repos (Profile 1).

### 5.2 Future users

Possible later users:

- the same developer applying tBoard to a different, non-plugin project via a new profile
- small collaborators working across shared source/target repos
- community plugin maintainers
- hosted-web users reviewing bugs/releases
- agents operating through MCP

The initial app must not require multi-user infrastructure.

## 6. Core concepts

The concepts below are named generically first, with the Roe Profile 1 meaning given as a concrete example.

### 6.1 Repo mapping

A repo mapping maps one **source repo** to one **target repo**. This generalizes what a Roe-focused reading of the app would call a "dev/release repo pair."

For Profile 1 (Roe), mappings are inferred by name convention: each `Roe-apiv3*` repo maps to its matching `community-plugins*` repo (see 6.6).

### 6.2 Tracked component

A tracked component is the app's unit for scanning, diffing, testing, and release copying — the thing that lives inside a source repo and gets released into a target repo. What counts as a component is profile-defined.

For Profile 1 (Roe), a tracked component is a **plugin root**. Initial detection uses named plugin-root conventions; later versions may add descriptor-parent, Gradle-module, and manual override detection. Other profiles could define a component as a package, a service, a module, or any other repeatable unit.

### 6.3 Component variant

A component variant is one tracked component within one repo mapping (i.e., on one source/target pair).

For Profile 1 (Roe), this is a **plugin variant** — one plugin on one server/repo pair. Examples:

- `InfernoHelper` on OSRS
- `InfernoHelper` on Ferox
- `AutoSomething` on Reason

Approval, testing, release, and diff state may vary per component variant.

### 6.4 Card

A card is a trackable work item. Cards are mixed-type and may represent:

- a component status item
- a bug
- an implementation task
- a release candidate
- a testing/evidence item

Cards can be linked together.

### 6.5 Evidence / artifacts

Evidence is any artifact that supports development, testing, debugging, or release decisions.

Evidence examples:

- snapshot file (for Profile 1: RoeProx `.ndjson` snapshot)
- recording `.bin`
- crash log
- app/component log
- screenshot
- pasted chat report
- manual note
- agent-generated summary

### 6.6 Workflow profiles

A workflow profile packages a project's repo-mapping convention, its definition of "tracked component," and any profile-specific scanning logic. tBoard v0.1 ships with exactly one profile, but the data model and scanning pipeline are built so more can be added later without redesigning the core schema.

**Profile 1: Roe Plugin Workflow** (the initial configured profile)

Initial source/target repo mapping, inferred by name convention:

| Source repo | Target repo |
| --- | --- |
| `Roe-apiv3` | `community-plugins` |
| `Roe-apiv3-ferox` | `community-plugins-ferox` |
| `Roe-apiv3-orion` | `community-plugins-orion` |
| `Roe-apiv3-osnr` | `community-plugins-osnr` |
| `Roe-apiv3-osrsps` | `community-plugins-osrsps` |
| `Roe-apiv3-reason` | `community-plugins-reason` |
| `Roe-apiv3-amascut` | `community-plugins-amascut` |

Within this profile, a tracked component is a plugin root, and a component variant is a plugin on one server/repo mapping.

## 7. Lifecycle

Default Kanban status columns:

1. Backlog
2. Developing
3. Untested
4. Needs Fix
5. Approved
6. Released

Approval means self-approved by the developer after sufficient testing/evidence.

Testing should support manual state plus attached evidence. Snapshot files are especially important and should be organized by component.

## 8. Main views

### 8.1 Kanban board

The Kanban board is the main planning surface.

Requirements:

- show cards grouped by lifecycle status
- support mixed card types
- filter by component, target variant, repo mapping, card type, priority, severity, approval state, test state, release state, and diff state
- support drag/drop status changes
- show badges for linked bugs, evidence, diffs, and release readiness

### 8.2 Component matrix

The component matrix shows tracked components across target variants.

Rows: components  
Columns: target variants (repo mappings)

Each cell should summarize:

- source component exists
- target component exists
- approved state
- tested state
- released state
- open bugs
- unmerged diff
- latest evidence date

For Profile 1 (Roe), rows are plugins and columns are server/repo pairs.

### 8.3 Diff dashboard

The diff dashboard shows divergence between source and target repositories.

Requirements:

- show all mapped repo mappings
- show changed/added/deleted component roots
- show file-level change summary
- highlight descriptor/config/guide changes
- show commit delta where available
- allow opening a full folder diff
- allow starting a release-copy workflow from a changed component

### 8.4 Evidence library

The evidence library organizes testing/debugging artifacts.

Requirements:

- browse by target variant, component, card, date, and evidence type
- attach existing local files
- copy files into app-managed per-component folders
- show file metadata: original path, stored path, hash, size, imported date, type
- link evidence to bugs, tests, component variants, and release candidates

### 8.5 Card detail

Each card should have a full detail page or drawer.

Suggested fields:

- title
- type
- status
- component
- target variant / repo mapping
- priority
- severity
- notes/description
- repro steps for bugs
- acceptance/testing notes for tasks/releases
- linked cards
- linked evidence
- diff summary
- command history
- MCP/agent activity log
- release checklist

## 9. Key workflows

### 9.1 Initial repo scan

1. User configures the local **workspace root** (the parent directory containing all relevant repos).
2. App finds repos matching the active profile's repo-mapping convention. For Profile 1 (Roe), that means matching `Roe-apiv3*` and `community-plugins*` repos.
3. App maps source/target repo mappings by the profile's convention.
4. App scans each source repo for tracked components using the profile's component-detection rules. For Profile 1, that means plugin roots by named plugin-root convention.
5. App extracts component metadata from descriptors where possible.
6. App creates or updates component inventory records in SQLite.

### 9.2 Bug capture

Bug cards can be created from:

- manual entry
- pasted chat/Discord report
- attached recording/snapshot/log
- MCP request from an agent

Bug cards should include:

- component
- target variant
- title
- repro notes
- severity
- status
- evidence links
- linked fix task
- linked release candidate

### 9.3 Testing evidence capture

1. User or agent attaches a snapshot/log/recording.
2. App stores it in the component's evidence area.
3. App records metadata and links it to the relevant card/component/target variant.
4. User or agent records testing result.
5. Card can move to `Untested`, `Needs Fix`, or `Approved` based on result.

### 9.4 Source-to-target update

Initial release update method: copy component folder from source repo to target repo.

Workflow:

1. App detects a component differs between source and target.
2. User opens diff summary.
3. User opens full folder diff if needed.
4. App previews folder-copy operation.
5. User confirms.
6. App copies selected component folder from source repo to target repo.
7. App shows resulting Git diff in target repo.
8. User runs build/test/custom commands.
9. User commits and pushes through app if desired.
10. Release candidate moves toward `Released`.

Open behavior decision: whether copy should delete target files missing from source, or only add/overwrite files.

### 9.5 MCP agent workflow

Agents should be able to:

- query component/repo/card state
- ask for next high-priority work
- create bug/task/test cards
- attach evidence
- update status
- record implementation notes
- record test results
- request diff summaries

Default safety:

- DB-only board updates may be allowed if configured
- filesystem/Git writes require explicit confirmation unless trusted mode is enabled
- every MCP action is logged

## 10. Safety requirements

The app must use strict safety for destructive or mutating operations.

Required controls:

- dry-run previews before file/Git writes
- confirmation before sync, commit, push, delete, overwrite, or custom write command
- operation log for every mutation
- command output capture
- visible before/after Git status for repo mutations
- rollback/undo where practical
- clear distinction between read-only inspection and write actions

## 11. Data model draft

See `docs/SQLITE_SCHEMA.md` for the full schema. This section summarizes the entity shape at the PRD level; naming there documents which tables are v0.1 Roe-profile-biased and which are already generic.

### 11.1 Tables/entities

Suggested initial entities (generic role — schema doc has exact table names):

- app settings (workspace root, etc.)
- repo mapping (source repo <-> target repo)
- repo (individual source/target repo record)
- component (canonical tracked unit, e.g. a plugin)
- component variant (one component within one repo mapping)
- card (mixed-type work item)
- card link
- evidence
- diff snapshot
- command run
- git operation
- pending operation
- custom command
- MCP event

### 11.2 Repo mapping

Fields:

- id
- mapping key (Profile 1: server key, e.g. `ferox`)
- source repo path
- target repo path
- mapping source: inferred/manual
- enabled
- last scanned at

### 11.3 Component

Fields:

- id
- canonical name
- display name
- descriptor name
- package/name hints
- created at
- updated at

### 11.4 Component variant

Fields:

- id
- component id
- repo mapping id
- source component root path
- target component root path
- source exists
- target exists
- status
- approved state
- tested state
- released state
- last diff snapshot id
- latest evidence id

### 11.5 Card

Fields:

- id
- type: component, bug, task, release, evidence
- title
- description
- status
- priority
- severity
- component id nullable
- component variant id nullable
- repo mapping id nullable
- created source: manual, chat, recording, mcp, scan
- created at
- updated at
- completed/released at nullable

### 11.6 Evidence

Fields:

- id
- component id nullable
- component variant id nullable
- card id nullable
- type: snapshot, recording, log, screenshot, note, agent-summary, other
- original path nullable
- stored path
- hash
- size bytes
- metadata JSON
- imported at
- created by: user, app, mcp-agent

### 11.7 Diff snapshot

Fields:

- id
- repo mapping id
- component variant id nullable
- source ref/path
- target ref/path
- summary JSON
- file changes JSON
- descriptor changes JSON
- created at

### 11.8 Command run

Fields:

- id
- repo id nullable
- component variant id nullable
- card id nullable
- command kind: git, build, test, lint, release, custom
- command string
- cwd
- exit code
- stdout path/blob
- stderr path/blob
- started at
- finished at
- triggered by: user, app, mcp-agent

## 12. MCP API draft

Initial MCP operations:

- `board.query`
- `board.createCard`
- `board.updateCard`
- `board.moveCard`
- `board.linkCards`
- `components.list`
- `components.getState`
- `components.getDiffSummary`
- `evidence.attach`
- `evidence.list`
- `testing.recordResult`
- `work.next`
- `release.getReadiness`
- `release.requestFolderCopy`

Operations that mutate files/Git should return a pending operation requiring app/user confirmation unless trusted mode is explicitly enabled.

## 13. Technical architecture

### 13.1 Desktop app

Recommended stack:

- Electron
- TypeScript
- React renderer
- SQLite local database
- Node backend services in Electron main process or sidecar

### 13.2 Portability for future web

To preserve a future hosted path:

- keep renderer UI independent from Electron-only APIs
- expose app functionality through a typed internal API
- keep filesystem/Git behavior behind adapters
- design DB access behind repositories/services
- keep MCP server as a backend module, not renderer logic

Future hosted deployment can replace local adapters with server-side workers, auth, and remote storage.

### 13.3 Profile boundary

To preserve a future path to multiple workflow profiles without a rewrite:

- keep repo-mapping detection and component-detection behind a profile interface (a "scanner"), even though only the Roe plugin scanner (Profile 1) ships in v0.1
- keep the core schema's naming and shape generic (component/component variant/repo mapping) so a second profile does not require new tables, only new scanner logic and profile configuration
- avoid encoding Roe-specific naming assumptions (`Roe-apiv3*`, `community-plugins*`, plugin-root conventions) anywhere outside the Profile 1 scanner module

## 14. Release phases

### Phase 1: Local inventory and board

- Electron shell
- SQLite setup
- configure workspace root
- scan repo mappings (Profile 1: Roe repo pairs)
- scan tracked components (Profile 1: plugin roots)
- show Kanban board
- create/edit cards

### Phase 2: Matrix and evidence

- component/target-variant matrix
- evidence import/copy
- per-component evidence folders
- link evidence to cards/components

### Phase 3: Diff dashboard

- source/target repo-mapping diff scan
- changed component summary
- file-level diff summary
- descriptor/guide/config highlighting

### Phase 4: Release copy workflow

- preview copy operation
- confirm copy
- show resulting Git diff
- command log
- release checklist

### Phase 5: Git/build/custom commands

- Git status/diff/commit/push flows
- build/test/lint/custom command configuration
- strict confirmation and logs

### Phase 6: MCP integration

- MCP read API
- MCP card/evidence writes
- MCP status updates
- MCP pending write-operation requests

## 15. Success criteria

The first full beta is successful when:

- all local Profile 1 (Roe) repo mappings are detected
- component inventory is automatically populated from the local repos
- every component variant can show status, approval, testing, release, evidence, and diff state
- bugs/tasks/releases can be tracked as cards
- snapshot/recording evidence can be organized by component
- changed source components can be compared against target versions
- release folder-copy can be previewed and executed safely
- Git/build/custom commands can be run with captured logs
- agents can use MCP to create/update/query board items and attach evidence
- the core data model and scanning pipeline show no Roe-specific assumptions outside the Profile 1 scanner module (validates the generalization goal, even though no second profile ships yet)

## 16. Open questions

1. What exact naming convention defines a tracked component root for Profile 1 (Roe)?
2. Should release copy delete files that no longer exist in source, or only add/overwrite?
3. Should approval always be per component+target variant, or can some components have global approval?
4. Which MCP writes should be allowed without confirmation?
5. Which UI library should be used for the Electron renderer?
6. Where should large command logs and evidence metadata summaries be stored: SQLite blobs, files, or both?
7. Should GitHub support later be GitHub Issues, GitHub Projects, PR tracking, or all three?
8. When a second workflow profile is eventually added, should profile selection be per-workspace or should one tBoard instance support multiple active profiles at once?
