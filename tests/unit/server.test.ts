import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDatabase, type SqliteDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { hashPassword } from '../../src/server/auth';
import { buildServer } from '../../src/server/app';
import type { ServerConfig } from '../../src/server/config';

const ORIGIN = 'https://board.test';
const PASSWORD = 'correct horse battery staple';

const config: ServerConfig = {
  port: 8787,
  host: '127.0.0.1',
  publicOrigin: ORIGIN,
  passwordHash: hashPassword(PASSWORD),
  cookieSecure: false, // inject() is not TLS; __Host- cookies still parse in tests
};

describe('web server', () => {
  let db: SqliteDatabase;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    app = await buildServer({ db, config });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  /** Logs in and returns the session + csrf cookies and csrf token value. */
  async function login(): Promise<{ cookies: string; csrf: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const setCookies = res.cookies;
    const session = setCookies.find((c) => c.name === '__Host-tboard_session');
    const csrf = setCookies.find((c) => c.name === '__Host-tboard_csrf');
    expect(session?.value).toBeTruthy();
    expect(csrf?.value).toBeTruthy();
    const cookies = `__Host-tboard_session=${session!.value}; __Host-tboard_csrf=${csrf!.value}`;
    return { cookies, csrf: csrf!.value };
  }

  it('rejects unauthenticated API reads with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/boards' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects login with a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN },
      payload: { password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a mutation with a missing/bad Origin even when authed', async () => {
    const { cookies, csrf } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/api/boards',
      headers: { origin: 'https://evil.test', cookie: cookies, 'x-csrf-token': csrf },
      payload: { repoPath: '/x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a mutation with a missing CSRF token', async () => {
    const { cookies } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/api/boards',
      headers: { origin: ORIGIN, cookie: cookies }, // no x-csrf-token
      payload: { repoPath: '/x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows an authed board+card round-trip with correct Origin + CSRF', async () => {
    const { cookies, csrf } = await login();
    const headers = { origin: ORIGIN, cookie: cookies, 'x-csrf-token': csrf };

    const add = await app.inject({
      method: 'POST',
      url: '/api/boards',
      headers,
      payload: { repoPath: '/repos/app', name: 'App' },
    });
    expect(add.statusCode).toBe(200);
    const board = add.json().board as { id: number };
    expect(board.id).toBeGreaterThan(0);

    const create = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers,
      payload: { boardId: board.id, title: 'Web card', status: 'developing' },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().status).toBe('developing');

    const list = await app.inject({ method: 'GET', url: `/api/boards/${board.id}/cards`, headers: { cookie: cookies } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it('logout invalidates the session', async () => {
    const { cookies, csrf } = await login();
    const out = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { origin: ORIGIN, cookie: cookies, 'x-csrf-token': csrf },
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/boards', headers: { cookie: cookies } });
    expect(after.statusCode).toBe(401);
  });

  it('validates repoPath: rejects control chars and overlong input', async () => {
    const { cookies, csrf } = await login();
    const headers = { origin: ORIGIN, cookie: cookies, 'x-csrf-token': csrf };
    const bad = await app.inject({ method: 'POST', url: '/api/boards', headers, payload: { repoPath: 'a\u0000b' } });
    expect(bad.statusCode).toBe(400);
    const long = await app.inject({ method: 'POST', url: '/api/boards', headers, payload: { repoPath: 'x'.repeat(2000) } });
    expect(long.statusCode).toBe(400);
  });

  it('sets hardened security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/session' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
