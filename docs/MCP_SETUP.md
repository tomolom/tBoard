# Connecting tBoard's MCP server to AI harnesses

tBoard ships a standalone [Model Context Protocol](https://modelcontextprotocol.io/) server so AI agents can drive your boards — list/add boards, read a repo's branches and modules, and create/update/move cards. It talks over **stdio**, so any MCP-compatible client can spawn it.

By default it opens the **same** SQLite database as the desktop app (`<userData>/tboard.sqlite`), so anything an agent changes shows up in the app and vice-versa.

**Local or remote board.** By default the MCP server drives your **local** board. To point it at a **hosted** board instead (see [SELF_HOSTING.md](SELF_HOSTING.md)), set two environment variables on the MCP server and it talks to that server over its authenticated HTTP API:

| Variable | Purpose |
| --- | --- |
| `TBOARD_REMOTE_URL` | The hosted board origin, e.g. `https://board.example.com`. When set, the MCP server runs in remote mode. |
| `TBOARD_REMOTE_PASSWORD` | The board's login password (used to authenticate; sent only to your server over HTTPS). |

In remote mode the same 8 tools operate on the hosted board; branch/module discovery returns whatever the server reports (free-text there, since the repos aren't on the VPS). Omit both variables for local mode. Add them to the `env`/`environment` block of any harness config below.

---

## 1. Build the entrypoint (one time)

Harnesses launch the server with plain `node`, so build the bundled entrypoint first:

```bash
npm install
npm run mcp:build
```

This produces **`out/mcp/stdio.js`** — a single Node-runnable file. Keep it inside the repo: it loads the native `better-sqlite3` module from the repo's `node_modules`, so don't copy `stdio.js` elsewhere on its own.

Your absolute path to it (use this in the configs below):

```
<repo>/out/mcp/stdio.js
```

> On this machine that is:
> `C:\Users\tomol\Documents\GitHub\tBoard\out\mcp\stdio.js`

**Sanity check** that it launches:

```bash
node out/mcp/stdio.js
```

It will sit waiting for a client on stdio (Ctrl-C to quit). No output is normal.

---

## 2. Register it with your harness

Every config below launches `node <repo>/out/mcp/stdio.js`. The `env` block is **optional** — omit it to share the desktop app's board; set `TBOARD_DB_PATH` to point the agent at a separate database file.

> ⚠️ **Two gotchas** that cause most failures:
> - **VS Code uses the key `servers`**, not `mcpServers`.
> - **Cursor and VS Code require `"type": "stdio"`**; the others don't.

Replace `C:\\path\\to\\tBoard` with your actual repo path (note the doubled backslashes in JSON on Windows).

### Claude Desktop

Config file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tboard": {
      "command": "node",
      "args": ["C:\\path\\to\\tBoard\\out\\mcp\\stdio.js"]
    }
  }
}
```

Restart Claude Desktop after editing. (Optional isolated DB: add `"env": { "TBOARD_DB_PATH": "C:\\path\\to\\agent-board.sqlite" }`.)

### Claude Code (CLI)

One command — no file editing:

```bash
# shares the app's database
claude mcp add tboard -- node /absolute/path/to/tBoard/out/mcp/stdio.js

# or with an isolated database, shared with your team via .mcp.json
claude mcp add tboard --scope project -e TBOARD_DB_PATH=/path/to/board.sqlite -- node /absolute/path/to/tBoard/out/mcp/stdio.js
```

Scopes: `local` (default, private to you), `project` (writes `.mcp.json`, commit to share), `user` (all your projects).

### Cursor

Config file: `.cursor/mcp.json` (this project) or `~/.cursor/mcp.json` (global). **`type` is required.**

```json
{
  "mcpServers": {
    "tboard": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\tBoard\\out\\mcp\\stdio.js"]
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

Config file: `.vscode/mcp.json` (workspace). **Top-level key is `servers`, and `type` is required.**

```json
{
  "servers": {
    "tboard": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\tBoard\\out\\mcp\\stdio.js"]
    }
  }
}
```

Or from a terminal:

```bash
code --add-mcp "{\"name\":\"tboard\",\"command\":\"node\",\"args\":[\"C:\\\\path\\\\to\\\\tBoard\\\\out\\\\mcp\\\\stdio.js\"]}"
```

### Other clients (Windsurf, Cline, …)

Most other clients use the same **`mcpServers`** shape as Claude Desktop:

- **Windsurf:** `~/.codeium/windsurf/mcp_config.json`
- **Cline:** manage via `cline mcp add tboard -- node /absolute/path/to/tBoard/out/mcp/stdio.js`, or its `cline_mcp_settings.json`.

```json
{
  "mcpServers": {
    "tboard": {
      "command": "node",
      "args": ["/absolute/path/to/tBoard/out/mcp/stdio.js"]
    }
  }
}
```

---

## 3. Verify the connection

Once registered, ask the agent to **list tboard boards** (tool `tboard_boards_list`). You should get back your boards. If the board list is empty, add one in the desktop app (or via `tboard_boards_add` with a git repo path) and list again.

### Available tools

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

There is also a `tboard://boards` resource. Every call is logged to the `mcp_events` table.

---

## Troubleshooting

- **"command not found: node"** — the harness couldn't find Node. Use an absolute path to your Node binary as `command` (find it with `where node` / `which node`).
- **Server starts then exits / native module error** — you ran `stdio.js` from a copy outside the repo. It must stay in `out/mcp/` so it can load `better-sqlite3` from the repo's `node_modules`. Re-run `npm run mcp:build` after `npm install`.
- **Agent and app show different boards** — you set `TBOARD_DB_PATH` to a different file than the app uses. Remove it to share the default database.
- **Nothing happens on a plain `node out/mcp/stdio.js`** — that's expected; it's waiting for an MCP client on stdio.
- **Changes to config not picked up** — fully restart the harness (Claude Desktop and VS Code load MCP config at startup).
