<div align="center">

# tBoard

### A local-first Kanban board for your git repos.

One board per repository · cards tied to real git branches · a built-in MCP server so your AI agents can drive the board too.

<br />

[![GitHub stars](https://img.shields.io/github/stars/tomolom/tBoard?style=flat-square&logo=github&color=f5c518)](https://github.com/tomolom/tBoard/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/tomolom/tBoard?style=flat-square&logo=github)](https://github.com/tomolom/tBoard/network/members)
[![GitHub issues](https://img.shields.io/github/issues/tomolom/tBoard?style=flat-square&logo=github)](https://github.com/tomolom/tBoard/issues)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/tag/tomolom/tBoard?style=flat-square&label=version&color=success)](https://github.com/tomolom/tBoard/tags)

[![Last commit](https://img.shields.io/github/last-commit/tomolom/tBoard?style=flat-square)](https://github.com/tomolom/tBoard/commits/main)
[![Top language](https://img.shields.io/github/languages/top/tomolom/tBoard?style=flat-square)](https://github.com/tomolom/tBoard)
[![Electron](https://img.shields.io/badge/Electron-2f3242?style=flat-square&logo=electron&logoColor=9feaf9)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-20232a?style=flat-square&logo=react&logoColor=61dafb)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-server-6f42c1?style=flat-square)](https://modelcontextprotocol.io/)

</div>

---

## What is tBoard?

**tBoard** is a desktop Kanban board built for how developers actually work: around git repos and branches. Point it at a repository, and it becomes a board. Every card can be tied to a real branch and a module (subfolder) in that repo, so your work-in-progress lines up with your code.

It's **local-first** — everything lives in a single SQLite database on your machine, no account, no cloud, no telemetry. And it ships with a **Model Context Protocol (MCP) server**, so AI agents can read and update the same board you're looking at.

## Features

- 📋 **A board per repository.** Add a git repo and get a dedicated Kanban board. Switch between repos from the top bar.
- 🌿 **Cards tied to real git branches.** Branches are read straight from the repo. Tag a card with the branch it belongs to, filter the board by branch, and it stays in sync with `git`.
- 📁 **Module links.** Associate a card with a subfolder of the repo (auto-discovered, monorepo-aware: `packages/*`, `apps/*`, …).
- 🐞 **Typed cards.** Task, Bug, or Feature — colour-coded so bugs and features stand out at a glance. Full description on every card, previewed on the card face.
- 🖱️ **Drag and drop.** Move cards between columns and reorder within a column. Priorities, statuses, and inline editing in a detail drawer.
- 🔎 **Compose filters.** Narrow the board by branch, module, and type together.
- 🤖 **Built-in MCP server.** A standalone stdio server lets MCP-compatible agents list/add boards, read branches & modules, and create/update/move cards — against the *same* database the app uses.
- 🔒 **Local-first & private.** One SQLite file under your user data dir. No network, no sign-in.
- 🌙 **Dark, focused UI.** Keyboard-friendly, accessible overlays, built to stay out of the way.

## Quick start

```bash
git clone https://github.com/tomolom/tBoard.git
cd tBoard
npm install
npm run dev
```

On first launch, click **Add Repo**, pick a git repository folder, and start adding cards. The board you were last on is remembered between launches.

> **Requirements:** Node.js 20+ and `git` on your `PATH`.

## Build a desktop app

Package a distributable Windows app (NSIS installer + portable `.exe`) with electron-builder:

```bash
npm run dist        # installer + portable in dist/
npm run dist:dir    # fast unpacked build, no installer
```

> **Windows/OneDrive:** packaging inside a OneDrive-synced folder (e.g. under `Documents`) can fail with `EPERM` mid-rename. Point the output elsewhere:
> `npx electron-builder --dir -c.directories.output=$env:LOCALAPPDATA\tboard-dist`

## MCP server

tBoard ships a standalone [Model Context Protocol](https://modelcontextprotocol.io/) stdio server so AI agents can drive your boards. It opens the **same** database as the desktop app by default, so what an agent changes shows up in the app and vice-versa.

```bash
npm run mcp:dev     # serve MCP over stdio
npm run mcp:smoke   # end-to-end self-test against a throwaway DB (CI gate)
```

### Tools

| Tool | Description |
| --- | --- |
| `tboard_boards_list` | List all boards (git repos). |
| `tboard_boards_add` | Add a board for a git repo path (validated; never writes to the repo). |
| `tboard_boards_branches` | List a board repo's local git branches. |
| `tboard_boards_modules` | List a board repo's discovered subfolders (modules). |
| `tboard_cards_list` | List a board's cards, ordered by status then position. |
| `tboard_cards_create` | Create a card (title, type, status, priority, branch, module). |
| `tboard_cards_update` | Update a card's editable fields. |
| `tboard_cards_move` | Move a card to a status/position. |

It also exposes a `tboard://boards` resource. Every call is logged to an `mcp_events` table. All tools return JSON; errors come back as `isError` rather than throwing across the protocol boundary.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `TBOARD_DB_PATH` | SQLite database the server opens. | The same per-user database the app uses (`<userData>/tboard.sqlite`) |

The database path is resolved by a shared, Electron-free helper, so the app and the MCP server agree by construction. Because both can open the file at once, the connection uses WAL mode with a busy timeout.

## Tech stack

**Electron** · **React 19** · **TypeScript** · **Vite / electron-vite** · **SQLite** (`better-sqlite3`, N-API prebuilds) · **@modelcontextprotocol/sdk** · **Vitest**

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run test:run    # vitest
npm run build       # typecheck + electron-vite build
npm run mcp:smoke   # MCP stdio end-to-end
```

Database schema changes live in `src/main/db/migrations/*.sql` and are embedded for production via `npm run db:embed` (never hand-edit `embeddedMigrations.ts`).

## Roadmap

- Keyboard-driven card reordering (drag is currently mouse-only)
- Card search
- Board reordering in the switcher
- Cross-platform packaging (macOS / Linux)

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck`, `npm run test:run`, and `npm run build` before opening a PR.

## License

[MIT](LICENSE) © tomol
