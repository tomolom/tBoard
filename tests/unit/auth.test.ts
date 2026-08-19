import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { hashPassword, SessionStore, verifyPassword } from '../../src/server/auth';

describe('password hashing', () => {
  it('verifies the correct password and rejects wrong ones', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('produces a different salt/hash each time for the same password', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    expect(verifyPassword('same', a)).toBe(true);
    expect(verifyPassword('same', b)).toBe(true);
  });

  it('never throws and returns false on malformed stored hashes', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt:bad')).toBe(false);
    expect(verifyPassword('x', 'scrypt:32768:8:1::')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
});

describe('SessionStore', () => {
  function freshDb() {
    const db = createDatabase(':memory:');
    runMigrations(db);
    return db;
  }

  it('creates a session whose raw id validates, and rejects unknown ids', () => {
    const db = freshDb();
    try {
      const store = new SessionStore(db);
      const raw = store.create();
      expect(store.validate(raw)).toBe(true);
      expect(store.validate('some-other-id')).toBe(false);
      expect(store.validate(undefined)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('stores only the hash of the session id, never the raw id', () => {
    const db = freshDb();
    try {
      const raw = new SessionStore(db).create();
      const row = db.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string };
      expect(row.id_hash).not.toBe(raw);
      expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/u); // sha-256 hex
    } finally {
      db.close();
    }
  });

  it('rejects a session past its absolute expiry', () => {
    const db = freshDb();
    try {
      const store = new SessionStore(db, { absoluteTtlMs: 1000, idleTtlMs: 10_000 });
      const t0 = Date.now();
      const raw = store.create(t0);
      expect(store.validate(raw, t0 + 500)).toBe(true);
      expect(store.validate(raw, t0 + 1500)).toBe(false);
      // expired row is deleted
      expect(db.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a session idle beyond the idle timeout', () => {
    const db = freshDb();
    try {
      const store = new SessionStore(db, { absoluteTtlMs: 1_000_000, idleTtlMs: 1000 });
      const t0 = Date.now();
      const raw = store.create(t0);
      // Active use slides the idle window forward.
      expect(store.validate(raw, t0 + 800)).toBe(true);
      expect(store.validate(raw, t0 + 1600)).toBe(true); // 800ms since last seen
      // Now leave it idle past the timeout.
      expect(store.validate(raw, t0 + 3000)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('destroy invalidates one session; destroyAll clears them', () => {
    const db = freshDb();
    try {
      const store = new SessionStore(db);
      const a = store.create();
      const b = store.create();
      store.destroy(a);
      expect(store.validate(a)).toBe(false);
      expect(store.validate(b)).toBe(true);
      store.destroyAll();
      expect(store.validate(b)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('cleanupExpired removes only expired rows', () => {
    const db = freshDb();
    try {
      const store = new SessionStore(db, { absoluteTtlMs: 1000 });
      const t0 = Date.now();
      store.create(t0);
      expect(store.cleanupExpired(t0 + 2000)).toBe(1);
      expect(db.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
