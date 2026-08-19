import { randomBytes } from 'node:crypto';

import path from 'node:path';

import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AttachmentService, AttachmentTooLargeError, MAX_ATTACHMENT_BYTES } from '../main/services/attachmentService';
import { contentDispositionAttachment } from '../main/services/attachmentStore';

import type { SqliteDatabase } from '../main/db/connection';
import { BoardService } from '../main/services/boardService';
import { CardService } from '../main/services/cardService';
import { listBranches } from '../main/services/gitBranches';
import { listModules } from '../main/services/repoModules';
import { SettingsService } from '../main/services/settingsService';
import { SessionStore, verifyPassword } from './auth';
import type { ServerConfig } from './config';

const SESSION_COOKIE = '__Host-tboard_session';
const CSRF_COOKIE = '__Host-tboard_csrf';
const CSRF_HEADER = 'x-csrf-token';
const JSON_BODY_LIMIT = 256 * 1024;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type BuildServerOptions = {
  db: SqliteDatabase;
  config: ServerConfig;
  /** Absolute path to the built renderer directory (index.html + assets). */
  staticRoot?: string;
  /** Directory where attachment files are stored (off the static tree). */
  attachmentsDir: string;
  /**
   * Registers a callback fired whenever the DB changes, used to push SSE events.
   * Returns an unsubscribe. Injected so tests can drive it without a real watcher.
   */
  onDbChange?: (cb: () => void) => () => void;
};

/**
 * Builds the Fastify app for the optional web server. Security posture follows
 * the reviewed design: hardened session cookies, strict Origin checks on unsafe
 * methods, no CORS, login rate-limiting, cookie-authorized SSE with connection
 * caps, and a strict security-header set.
 */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { db, config } = options;
  const app = Fastify({
    bodyLimit: JSON_BODY_LIMIT,
    // Trust X-Forwarded-* only from the configured proxy (loopback by default;
    // a single hop in Docker). Never trust arbitrary forwarded headers.
    trustProxy: config.trustProxy,
  });

  const sessions = new SessionStore(db);
  const boards = new BoardService(db);
  const cards = new CardService(db);
  const settings = new SettingsService(db);
  const attachments = new AttachmentService(db, options.attachmentsDir);

  // Security invariant (oracle-reviewed): the attachments directory must NEVER
  // sit inside the static root, or files could be served unauthenticated and
  // inline. Fail boot if a future refactor ever violates this.
  if (options.staticRoot) {
    const staticRootResolved = path.resolve(options.staticRoot);
    const attachmentsResolved = path.resolve(options.attachmentsDir);
    if (
      attachmentsResolved === staticRootResolved ||
      attachmentsResolved.startsWith(staticRootResolved + path.sep) ||
      staticRootResolved.startsWith(attachmentsResolved + path.sep)
    ) {
      throw new Error('Attachments directory must not be inside the static root (it would be served unauthenticated).');
    }
  }
  // Clean up any temp files left by a crashed upload.
  void attachments.cleanupTempFiles();

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  // Multipart is used only by the upload route; per-file/route limits are
  // enforced there and in the service. The global JSON body limit stays small.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES,
      files: 5,
      fields: 5,
      parts: 20,
    },
  });

  const cookieBase = {
    path: '/',
    secure: config.cookieSecure,
    sameSite: 'strict' as const,
  };

  function setSessionCookies(reply: FastifyReply, rawSessionId: string): void {
    reply.setCookie(SESSION_COOKIE, rawSessionId, { ...cookieBase, httpOnly: true });
    // CSRF token is readable by JS (double-submit), rotated with the session.
    reply.setCookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), { ...cookieBase, httpOnly: false });
  }

  function clearAuthCookies(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, cookieBase);
    reply.clearCookie(CSRF_COOKIE, cookieBase);
  }

  // Baseline security headers on every response.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    // A route may set a stricter CSP (e.g. the attachment download's
    // "default-src 'none'; sandbox"); don't clobber it with the app default.
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          // React sets inline styles; allow them but never inline scripts.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join('; '),
      );
    }
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    } else if (request.url.startsWith('/assets/')) {
      // Vite emits content-hashed asset filenames, so they're immutable.
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // index.html / SPA shell must never be cached.
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // Strict Origin check on all unsafe methods (primary CSRF defense), plus a
  // double-submit CSRF token match. Applies to every route before handlers.
  app.addHook('preHandler', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      return;
    }
    const origin = request.headers.origin;
    if (!origin || origin !== config.publicOrigin) {
      return reply.code(403).send({ error: 'Bad origin' });
    }
    // Login has no CSRF cookie yet (it issues one); the strict Origin check
    // above is its CSRF defense. All other unsafe methods require the
    // double-submit token to match the CSRF cookie.
    if (request.url === '/api/login') {
      return;
    }
    const headerToken = request.headers[CSRF_HEADER];
    const cookieToken = request.cookies[CSRF_COOKIE];
    if (typeof headerToken !== 'string' || !cookieToken || headerToken !== cookieToken) {
      return reply.code(403).send({ error: 'Bad CSRF token' });
    }
  });

  function isAuthed(request: FastifyRequest): boolean {
    return sessions.validate(request.cookies[SESSION_COOKIE]);
  }

  // Discourage indexing (defense-in-depth with the X-Robots-Tag header).
  app.get('/robots.txt', async (_request, reply) => {
    reply.header('Content-Type', 'text/plain');
    return reply.send('User-agent: *\nDisallow: /\n');
  });

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!isAuthed(request)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // --- Auth routes ---------------------------------------------------------
  app.post(
    '/api/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { password?: unknown };
      const password = typeof body.password === 'string' ? body.password : '';
      // Constant-ish failure delay to blunt brute force.
      if (!verifyPassword(password, config.passwordHash)) {
        await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 200)));
        return reply.code(401).send({ error: 'Invalid password' });
      }
      // Rotate: drop any existing session id on this browser before issuing new.
      sessions.destroy(request.cookies[SESSION_COOKIE]);
      const rawId = sessions.create();
      setSessionCookies(reply, rawId);
      return reply.send({ ok: true });
    },
  );

  app.post('/api/logout', async (request, reply) => {
    sessions.destroy(request.cookies[SESSION_COOKIE]);
    clearAuthCookies(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/session', async (request, reply) => {
    return reply.send({ authenticated: isAuthed(request) });
  });

  // --- Board routes --------------------------------------------------------
  app.get('/api/boards', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return reply.send(boards.listBoards());
  });

  app.post('/api/boards', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { repoPath?: unknown; name?: unknown };
    const repoPath = typeof body.repoPath === 'string' ? body.repoPath : '';
    // On the VPS repoPath is an opaque label — validate shape, never touch fs.
    if (repoPath.length === 0 || repoPath.length > 1024 || /[\u0000-\u001f]/u.test(repoPath)) {
      return reply.code(400).send({ error: 'Invalid repoPath' });
    }
    const name = typeof body.name === 'string' ? body.name : undefined;
    // On the VPS the repo isn't present; repoPath is an opaque label.
    return reply.send(await boards.addBoard({ repoPath, name }, { validateRepo: false }));
  });

  app.patch('/api/boards/:id', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    try {
      return reply.send(boards.renameBoard(id, name));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Rename failed' });
    }
  });

  app.delete('/api/boards/:id', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    boards.removeBoard(Number((request.params as { id: string }).id));
    return reply.send({ ok: true });
  });

  app.get('/api/boards/:id/branches', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const board = boards.getBoard(Number((request.params as { id: string }).id));
    if (!board) {
      return reply.send({ branches: [], current: null, error: 'Board not found' });
    }
    return reply.send(await listBranches(board.repoPath));
  });

  app.get('/api/boards/:id/modules', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const board = boards.getBoard(Number((request.params as { id: string }).id));
    if (!board) {
      return reply.send([]);
    }
    return reply.send(await listModules(board.repoPath));
  });

  app.get('/api/boards/:id/cards', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return reply.send(cards.listCards(Number((request.params as { id: string }).id)));
  });

  // --- Card routes ---------------------------------------------------------
  app.post('/api/cards', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send(cards.createCard({ ...(request.body as object), source: 'mcp' } as never));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Create failed' });
    }
  });

  app.patch('/api/cards/:id', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = Number((request.params as { id: string }).id);
    try {
      return reply.send(cards.updateCard(id, request.body as object));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  app.post('/api/cards/:id/move', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { status?: unknown; afterCardId?: unknown };
    try {
      return reply.send(
        cards.moveCard(id, body.status as never, typeof body.afterCardId === 'number' ? body.afterCardId : null),
      );
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Move failed' });
    }
  });

  app.delete('/api/cards/:id', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    cards.removeCard(Number((request.params as { id: string }).id));
    return reply.send({ ok: true });
  });

  // --- Settings ------------------------------------------------------------
  app.get('/api/settings/last-board', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return reply.send({ boardId: settings.getLastBoardId() });
  });

  app.put('/api/settings/last-board', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { boardId?: unknown };
    settings.setLastBoardId(typeof body.boardId === 'number' ? body.boardId : null);
    return reply.send({ ok: true });
  });

  // --- Attachments ---------------------------------------------------------
  app.get('/api/cards/:id/attachments', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return reply.send(attachments.list(Number((request.params as { id: string }).id)));
  });

  app.post('/api/cards/:id/attachments', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const cardId = Number((request.params as { id: string }).id);
    let stored;
    try {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'No file provided.' });
      }
      stored = await attachments.createFromStream(cardId, file.filename, file.mimetype, file.file, 'user');
      // @fastify/multipart flags truncation when fileSize is exceeded.
      if (file.file.truncated) {
        await attachments.remove(stored.id);
        return reply.code(413).send({ error: 'Attachment exceeds the size limit.' });
      }
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) {
        return reply.code(413).send({ error: error.message });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Upload failed' });
    }
    return reply.send(stored);
  });

  app.get('/api/attachments/:id', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const row = attachments.getRow(Number((request.params as { id: string }).id));
    if (!row) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // Force download; never render inline. Separate strict CSP + octet-stream +
    // nosniff + safe Content-Disposition (both ascii and RFC 5987 forms).
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', contentDispositionAttachment(row.original_name));
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    const { createReadStream } = await import('node:fs');
    return reply.send(createReadStream(attachments.resolveFilePath(row.stored_name)));
  });

  app.delete('/api/attachments/:id', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    await attachments.remove(Number((request.params as { id: string }).id));
    return reply.send({ ok: true });
  });

  // --- SSE live updates ----------------------------------------------------
  registerSse(app, options, isAuthed);

  // --- Static SPA (built renderer) -----------------------------------------
  // Serves ONLY the built renderer directory. Hashed assets are cached
  // immutably; index.html is never cached; unknown non-API GETs fall back to
  // the SPA shell so client routing works. The login gate lives in the SPA.
  if (options.staticRoot) {
    const staticRoot = options.staticRoot;
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
      cacheControl: false,
    });

    app.setNotFoundHandler((request, reply) => {
      // API 404s stay JSON; everything else serves the SPA shell.
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html');
    });
  }

  return app;
}

const MAX_SSE_CLIENTS = 20;

/** SSE endpoint: cookie-authorized, capped, heartbeated. */
function registerSse(
  app: FastifyInstance,
  options: BuildServerOptions,
  isAuthed: (request: FastifyRequest) => boolean,
): void {
  const clients = new Set<FastifyReply>();
  let unsubscribe: (() => void) | null = null;

  function ensureWatching(): void {
    if (!unsubscribe && options.onDbChange) {
      unsubscribe = options.onDbChange(() => {
        for (const client of clients) {
          client.raw.write('event: db-changed\ndata: {}\n\n');
        }
      });
    }
  }

  app.get('/api/events', async (request, reply) => {
    if (!isAuthed(request)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (clients.size >= MAX_SSE_CLIENTS) {
      return reply.code(429).send({ error: 'Too many streams' });
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    clients.add(reply);
    ensureWatching();

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(reply);
    });
    // Keep the reply open; Fastify must not send a normal response.
    return reply;
  });

  app.addHook('onClose', async () => {
    unsubscribe?.();
    for (const client of clients) {
      client.raw.end();
    }
    clients.clear();
  });
}
