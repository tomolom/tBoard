import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { SettingsService } from '../../src/main/services/settingsService';

function freshDb() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('SettingsService remote URL', () => {
  it('defaults to null (local-first) and round-trips a valid https origin', () => {
    const db = freshDb();
    try {
      const settings = new SettingsService(db);
      expect(settings.getRemoteUrl()).toBeNull();
      settings.setRemoteUrl('https://board.example.com/');
      // Stored as a normalized origin (no trailing path).
      expect(settings.getRemoteUrl()).toBe('https://board.example.com');
    } finally {
      db.close();
    }
  });

  it('clears back to null', () => {
    const db = freshDb();
    try {
      const settings = new SettingsService(db);
      settings.setRemoteUrl('https://board.example.com');
      settings.setRemoteUrl(null);
      expect(settings.getRemoteUrl()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects non-http(s) and malformed URLs without persisting', () => {
    const db = freshDb();
    try {
      const settings = new SettingsService(db);
      expect(() => settings.setRemoteUrl('ftp://x')).toThrow();
      expect(() => settings.setRemoteUrl('not a url')).toThrow();
      expect(settings.getRemoteUrl()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps lastBoardId and remoteUrl independent', () => {
    const db = freshDb();
    try {
      const settings = new SettingsService(db);
      settings.setLastBoardId(7);
      settings.setRemoteUrl('https://b.test');
      expect(settings.getLastBoardId()).toBe(7);
      expect(settings.getRemoteUrl()).toBe('https://b.test');
    } finally {
      db.close();
    }
  });
});
