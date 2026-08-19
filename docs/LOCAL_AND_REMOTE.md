# Local & remote tBoard: how the pieces fit

tBoard is **local-first by default**, with an **optional** self-hosted server so you can view and drive the same board from a browser, the desktop app, and AI agents — from anywhere. This doc explains the model and the day-to-day workflows.

## The two stores

There are two independent SQLite databases:

| | Where it lives | Who uses it |
| --- | --- | --- |
| **Local** | `%APPDATA%/tboard/tboard.sqlite` (per-user data dir) | The desktop app (default), and the MCP server (default) |
| **Remote** | On your server, on a persistent volume (`/data/tboard.sqlite` in Docker) | The web page, the desktop app in *remote mode*, and the MCP server in *remote mode* |

They do **not** auto-sync. `TBOARD_DB_PATH` overrides the database location for every entrypoint (app, server, MCP) — this is what pins the server's DB to its Docker volume.

## Three ways to reach a board

1. **Desktop app** — local by default; **Connect Remote** (topbar) points it at your server; **Board → Use Local Board** switches back.
2. **Browser** — `https://your-domain`, password-gated.
3. **AI agent (MCP)** — local by default; set two env vars to drive the remote board (below).

## Syncing your local board to the remote

The remote starts empty. To copy your local boards + cards up:

```bash
# First time (remote is empty): a seed.
npm run server:push -- https://your-domain

# Re-sync later (remote already has data): MIRROR mode — wipes the remote and
# rewrites it to exactly match local. Safe to re-run; never duplicates.
npm run server:push -- https://your-domain --replace
```

- **Seed (default)** appends every local card. Running it twice **duplicates** cards — only use it against an empty remote.
- **`--replace` (mirror)** deletes all remote boards first, then pushes fresh, so remote ends up identical to local. This is the one to use for re-syncing. It **discards anything that existed only on the remote**, so use it when local is the source of truth (e.g. before you switch your agents over to remote).
- Password via prompt, or `TBOARD_PUSH_PASSWORD` env.

> The sync is **one-way (local → remote)**. Once you switch your agents/app to remote, the remote becomes your source of truth and you stop pushing local → remote.

> **Attachments are not synced.** `server:push` copies boards and cards only. File attachments live next to each store's database (`<dir(TBOARD_DB_PATH)>/attachments/`, i.e. on the Docker `/data` volume in prod) and stay with the store where they were uploaded. Upload files directly on whichever board is your source of truth.

## Pointing AI agents (MCP) at the remote board

By default the MCP server opens the local DB. To make a **local** agent drive the **remote** board over HTTPS, set two environment variables on the MCP server:

| Variable | Value |
| --- | --- |
| `TBOARD_REMOTE_URL` | `https://your-domain` |
| `TBOARD_REMOTE_PASSWORD` | your board password |

The same 8 tools then operate on the remote board (it logs in over the API; branch/module discovery is free-text there since the repos aren't on the server).

### OpenCode example

In `~/.config/opencode/opencode.json`, add an `environment` block to the `tboard` server:

```json
"tboard": {
  "type": "local",
  "command": ["node", "C:\\path\\to\\tBoard\\out\\mcp\\stdio.js"],
  "enabled": true,
  "environment": {
    "TBOARD_REMOTE_URL": "https://your-domain",
    "TBOARD_REMOTE_PASSWORD": "your-board-password"
  }
}
```

Restart OpenCode for it to take effect. Remove the `environment` block to go back to the local board. Other harnesses (Claude Desktop, Cursor, VS Code, …) use the same two variables in their own `env`/`environment` block — see [MCP_SETUP.md](MCP_SETUP.md).

> **Security note:** the password sits in plaintext in your local harness config (and, for the desktop remote mode / sync, in `deploy/deploy.env`). Those files are local-only and gitignored — never commit them. To rotate the password: `docker run --rm ghcr.io/<owner>/tboard hash "new pass"`, put the hash in the server's `.env`, `docker compose -f docker-compose.prod.yml up -d`, then update your harness/`deploy.env`.

## Typical setup, end to end

1. Deploy the server ([SELF_HOSTING.md](SELF_HOSTING.md)) — `docker compose -f docker-compose.prod.yml up -d`.
2. Seed it: `npm run server:push -- https://your-domain` (or `--replace` to re-sync).
3. Point the app at it (Connect Remote) and/or your agents (the two env vars).
4. From then on, everything reads/writes the one remote board; the desktop app can still drop to local anytime.
