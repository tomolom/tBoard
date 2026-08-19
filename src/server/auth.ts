import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { SqliteDatabase } from '../main/db/connection';

/**
 * Auth core for the optional web server. Two pieces:
 *   1. A shared-password scrypt hash, stored as a self-describing string so its
 *      parameters can evolve: `scrypt:N:r:p:base64Salt:base64Hash`.
 *   2. Server-side sessions in SQLite. The cookie carries a raw 256-bit id; only
 *      SHA-256(id) is stored, so a DB leak never yields a live session cookie.
 *
 * This module is deliberately free of any HTTP/Fastify types so it is trivially
 * unit-testable and reusable.
 */

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
// scrypt needs ~128*N*r bytes (~33.5MB here), above Node's default 32MB maxmem.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** Builds a `scrypt:...` hash string for a plaintext password (used by the hash CLI). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/**
 * Verifies a plaintext password against a stored `scrypt:...` hash in constant
 * time. Returns false (never throws) on any malformed hash or length mismatch.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) {
      return false;
    }
    const derived = scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    if (derived.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function hashSessionId(rawId: string): string {
  return createHash('sha256').update(rawId).digest('hex');
}

export type SessionConfig = {
  /** Absolute session lifetime in ms (default 14 days). */
  absoluteTtlMs?: number;
  /** Idle timeout in ms — a session unused this long is invalid (default 24h). */
  idleTtlMs?: number;
};

const DEFAULT_ABSOLUTE_TTL = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_TTL = 24 * 60 * 60 * 1000;

export class SessionStore {
  private readonly absoluteTtlMs: number;
  private readonly idleTtlMs: number;

  constructor(
    private readonly db: SqliteDatabase,
    config: SessionConfig = {},
  ) {
    this.absoluteTtlMs = config.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL;
    this.idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL;
  }

  /** Creates a new session and returns the RAW id to put in the cookie. */
  create(now: number = Date.now()): string {
    const rawId = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + this.absoluteTtlMs).toISOString();
    const createdAt = new Date(now).toISOString();
    this.db
      .prepare('INSERT INTO sessions (id_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashSessionId(rawId), createdAt, createdAt, expiresAt);
    return rawId;
  }

  /**
   * Validates a raw cookie id: exists, not past absolute expiry, and not idle
   * beyond the idle timeout. On success, slides last_seen_at forward and returns
   * true. Invalid/expired sessions are deleted.
   */
  validate(rawId: string | undefined, now: number = Date.now()): boolean {
    if (!rawId) {
      return false;
    }
    const idHash = hashSessionId(rawId);
    const row = this.db
      .prepare('SELECT last_seen_at, expires_at FROM sessions WHERE id_hash = ?')
      .get(idHash) as { last_seen_at: string; expires_at: string } | undefined;
    if (!row) {
      return false;
    }
    const expiresAt = Date.parse(row.expires_at);
    const lastSeen = Date.parse(row.last_seen_at);
    if (now >= expiresAt || now - lastSeen >= this.idleTtlMs) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return false;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(new Date(now).toISOString(), idHash);
    return true;
  }

  /** Destroys one session (logout). */
  destroy(rawId: string | undefined): void {
    if (!rawId) {
      return;
    }
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSessionId(rawId));
  }

  /** Destroys every session (logout-everywhere / password rotation). */
  destroyAll(): void {
    this.db.prepare('DELETE FROM sessions').run();
  }

  /** Removes expired rows; safe to call periodically. */
  cleanupExpired(now: number = Date.now()): number {
    const result = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
    return result.changes;
  }
}
