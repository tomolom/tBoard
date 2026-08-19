// Push your LOCAL board (boards + cards) to a remote tBoard web server over its
// authenticated API. Two modes:
//
//   npm run server:push -- https://board.example.com
//       SEED (default): create any missing boards and APPEND all local cards.
//       Safe for a first push to an empty remote; re-running DUPLICATES cards.
//
//   npm run server:push -- https://board.example.com --replace
//       MIRROR: delete every existing remote board first, then push fresh, so
//       the remote ends up exactly matching local. Idempotent — safe to re-run.
//       Use this to re-sync after local changes. Destroys remote-only edits.
//
// Password via TBOARD_PUSH_PASSWORD env, or prompted on stdin.
import { createInterface } from 'node:readline';

import { createDatabase, getRuntimeDatabasePath } from '../src/main/db/connection.ts';
import { runMigrations } from '../src/main/db/migrations.ts';
import { BoardService } from '../src/main/services/boardService.ts';
import { CardService } from '../src/main/services/cardService.ts';

function parseSetCookie(headers) {
  // Node fetch exposes multiple Set-Cookie via getSetCookie().
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const jar = {};
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const origin = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/$/, '');
  if (!origin) {
    console.error('Usage: npm run server:push -- https://board.example.com [--replace]');
    process.exit(1);
  }
  console.log(replace ? 'Mode: MIRROR (--replace) — remote will be wiped, then matched to local.' : 'Mode: SEED — appends local cards (re-running duplicates; use --replace to mirror).');
  const password = process.env.TBOARD_PUSH_PASSWORD || (await prompt('Remote board password: '));
  if (!password) {
    console.error('No password provided.');
    process.exit(1);
  }

  // Read the local board.
  const db = createDatabase(getRuntimeDatabasePath());
  runMigrations(db);
  const localBoards = new BoardService(db).listBoards();
  const cardsService = new CardService(db);
  const localCards = new Map(localBoards.map((b) => [b.id, cardsService.listCards(b.id)]));
  const totalCards = [...localCards.values()].reduce((n, cs) => n + cs.length, 0);
  console.log(`Local board: ${localBoards.length} board(s), ${totalCards} card(s).`);
  if (localBoards.length === 0) {
    console.log('Nothing to push.');
    db.close();
    return;
  }

  // Authenticate.
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) {
    console.error(`Login failed (${login.status}). Check the password and the URL.`);
    db.close();
    process.exit(1);
  }
  const jar = parseSetCookie(login.headers);
  const cookie = `__Host-tboard_session=${jar['__Host-tboard_session']}; __Host-tboard_csrf=${jar['__Host-tboard_csrf']}`;
  const csrf = jar['__Host-tboard_csrf'];
  const authHeaders = { 'content-type': 'application/json', origin, cookie, 'x-csrf-token': csrf };
  console.log('Authenticated to remote.');

  // In mirror mode, delete every existing remote board first (cards cascade),
  // so the push produces an exact copy with no duplicates.
  if (replace) {
    const existing = await (await fetch(`${origin}/api/boards`, { headers: { cookie } })).json();
    for (const b of existing) {
      const res = await fetch(`${origin}/api/boards/${b.id}`, { method: 'DELETE', headers: authHeaders });
      console.log(`  - removed remote board "${b.name}" (#${b.id}): ${res.ok ? 'ok' : 'FAILED ' + res.status}`);
    }
  }

  // Map existing remote boards by repo_path for idempotency (empty after wipe).
  const remoteBoards = await (await fetch(`${origin}/api/boards`, { headers: { cookie } })).json();
  const remoteByPath = new Map(remoteBoards.map((b) => [b.repoPath, b.id]));

  let boardsCreated = 0;
  let cardsCreated = 0;
  for (const board of localBoards) {
    let remoteId = remoteByPath.get(board.repoPath);
    if (remoteId === undefined) {
      const res = await fetch(`${origin}/api/boards`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ repoPath: board.repoPath, name: board.name }),
      });
      const data = await res.json();
      if (!res.ok || !data.board) {
        console.error(`  ! board "${board.name}" failed: ${data.error || res.status}`);
        continue;
      }
      remoteId = data.board.id;
      boardsCreated += 1;
      console.log(`  + board "${board.name}" -> #${remoteId}`);
    } else {
      console.log(`  = board "${board.name}" already on remote (#${remoteId}), adding its cards`);
    }

    for (const card of localCards.get(board.id) ?? []) {
      const res = await fetch(`${origin}/api/cards`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          boardId: remoteId,
          title: card.title,
          description: card.description,
          type: card.type,
          status: card.status,
          priority: card.priority,
          branch: card.branch,
          module: card.module,
        }),
      });
      if (res.ok) cardsCreated += 1;
      else console.error(`    ! card "${card.title}" failed: ${res.status}`);
    }
  }

  console.log(`\nDone. Pushed ${boardsCreated} new board(s) and ${cardsCreated} card(s) to ${origin}.`);
  db.close();
}

main().catch((error) => {
  console.error('Push failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
