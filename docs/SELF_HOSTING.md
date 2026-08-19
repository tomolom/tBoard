# Self-hosting tBoard on a domain

tBoard is **local-first by default** — the desktop app owns a local SQLite file and needs no server. This guide covers the **optional** web mode: run tBoard on a VPS behind your own domain, password-protected and not indexed, and view the same board from a browser **or** from the desktop app in "remote" mode.

> **Before you start — the trade-off.** The server reads git branches/modules from the local filesystem. Your repos are **not** on the VPS, so on the hosted board branch/module discovery degrades to free text (`repo_path` is just a label there). Cards, columns, drag-and-drop, types, descriptions, filters, and live updates all work normally. If you want git-aware discovery on the web too, run the server on your own machine behind a tunnel instead of a VPS.

---

## Architecture

The web server (`src/server/`) is a third entrypoint alongside the desktop app and the MCP server — it reuses the same services against a SQLite database. It:

- serves the built React renderer (the same UI as the app) and a JSON API,
- gates everything behind a single-password login (session cookie),
- pushes live updates over SSE,
- sets `noindex` headers + a disallow `robots.txt`.

**Security posture** (reviewed): `__Host-` HttpOnly/Secure/SameSite=Strict session cookie; strict exact-`Origin` check + double-submit CSRF token on every mutation; scrypt password hash; login rate-limiting; a strict CSP; no CORS; SSE authorized by the session cookie with connection caps. Bind the Node process to `127.0.0.1` and let a reverse proxy terminate TLS.

---

## 1. Build

On the VPS (or build locally and copy `out/` + `node_modules` + `package.json`):

```bash
npm ci
npm run build          # builds the renderer AND the server bundle (out/server/index.js)
```

## 2. Create the password hash

Never store a plaintext password. Generate a scrypt hash:

```bash
npm run server:hash-password -- "a long random passphrase"
# prints: TBOARD_AUTH_PASSWORD_HASH='scrypt:...'
```

## 3. Configure via environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `TBOARD_AUTH_PASSWORD_HASH` | yes | The `scrypt:...` hash from step 2. |
| `TBOARD_PUBLIC_ORIGIN` | yes | Your exact public origin, e.g. `https://board.example.com`. Used for strict Origin/CSRF checks. |
| `TBOARD_SERVER_PORT` | no | Port to listen on (default `8787`). |
| `TBOARD_SERVER_HOST` | no | Bind host (default `127.0.0.1` — keep it loopback-only behind the proxy). |
| `TBOARD_COOKIE_SECURE` | no | `true` (default) marks cookies Secure. Only set `false` for local http testing. |
| `TBOARD_DB_PATH` | no | SQLite path (defaults to the per-user data dir). Point it at a stable location on the VPS, e.g. `/var/lib/tboard/tboard.sqlite`. |

## 4. Run it (systemd)

`/etc/systemd/system/tboard.service`:

```ini
[Unit]
Description=tBoard web server
After=network.target

[Service]
Type=simple
User=tboard
WorkingDirectory=/opt/tboard
Environment=TBOARD_PUBLIC_ORIGIN=https://board.example.com
Environment=TBOARD_DB_PATH=/var/lib/tboard/tboard.sqlite
Environment=TBOARD_AUTH_PASSWORD_HASH=scrypt:32768:8:1:...:...
ExecStart=/usr/bin/node out/server/index.js
Restart=on-failure
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/tboard
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tboard
```

## 5. TLS + reverse proxy

The Node server listens on `127.0.0.1:8787` and must never be exposed directly — put a proxy in front that terminates TLS and forwards to it.

**Caddy** (`/etc/caddy/Caddyfile`) — automatic HTTPS:

```
board.example.com {
    reverse_proxy 127.0.0.1:8787
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }
}
```

**nginx** equivalent: `proxy_pass http://127.0.0.1:8787;` inside a TLS `server {}` block, and make sure it sets `X-Forwarded-For` / `X-Forwarded-Proto` (the app trusts these only from the loopback proxy). For SSE, disable proxy buffering on `/api/events` (`proxy_buffering off;`).

Point your domain's DNS at the VPS. Confirm `https://board.example.com` shows the login screen.

## 6. Seed it with your local board (optional)

Copy your existing local board (boards + cards) up to the server:

```bash
npm run server:push -- https://board.example.com
# prompts for the remote password (or set TBOARD_PUSH_PASSWORD)
```

This is idempotent by repo path — re-running won't duplicate boards.

## 7. Use it

- **Browser:** visit your domain, enter the password.
- **Desktop app:** click **Connect Remote** in the topbar, enter `https://board.example.com`, and the app reloads as the hosted board. The native **Board → Use Local Board** menu switches back to your local-first board anytime.

---

## Notes & limitations

- **Not indexed** is enforced by headers + `robots.txt`, but that only deters honest crawlers. The real protection is the password — use a long one.
- The hosted DB is **separate** from your local one; there's no automatic two-way sync. The push script is a one-way seed.
- Adding a repo from the web has no native folder picker — you type a path/label (it's opaque on the VPS anyway).
- Keep the server bundle in sync with source: `npm run build` rebuilds `out/server/index.js`. After updating, restart the service.
