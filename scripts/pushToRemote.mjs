// One-time migration: push your LOCAL board (boards + cards) to a remote tBoard
// web server over its authenticated API.
//
//   npm run server:push -- https://board.example.com
//   (password via TBOARD_PUSH_PASSWORD env, or prompted on stdin)
//
// Idempotent by repo_path: a board that already exists remotely is reused, not
// duplicated. Cards are appended per column in their current order. Timestamps
// and source are set by the server (this is a seed, not a byte-for-byte clone).
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
  const origin = (process.argv[2] || '').replace(/\/$/, '');
  if (!origin || !/^https?:\/\//.test(origin)) {
    console.error('Usage: npm run server:push -- https://board.example.com');
    process.exit(1);
  }
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

  // Map existing remote boards by repo_path for idempotency.
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
