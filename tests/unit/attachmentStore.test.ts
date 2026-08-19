import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  contentDispositionAttachment,
  generateStoredName,
  isValidStoredName,
  resolveStoredPath,
  sanitizeDisplayName,
} from '../../src/main/services/attachmentStore';

describe('attachment store security primitives', () => {
  it('generates 64-hex random stored names that validate', () => {
    const a = generateStoredName();
    const b = generateStoredName();
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
    expect(a).not.toBe(b);
    expect(isValidStoredName(a)).toBe(true);
  });

  it('rejects non-conforming stored names', () => {
    for (const bad of ['', '../etc', 'abc', 'A'.repeat(64), 'g'.repeat(64), '../../x', 'a/'.repeat(32)]) {
      expect(isValidStoredName(bad)).toBe(false);
    }
  });

  it('resolves a valid stored path inside the base dir', () => {
    const base = path.resolve('/data/attachments');
    const name = generateStoredName();
    expect(resolveStoredPath(base, name)).toBe(path.join(base, name));
  });

  it('throws on traversal / invalid names instead of escaping the base', () => {
    const base = path.resolve('/data/attachments');
    expect(() => resolveStoredPath(base, '../secret')).toThrow();
    expect(() => resolveStoredPath(base, '../../etc/passwd')).toThrow();
    expect(() => resolveStoredPath(base, 'sub/dir')).toThrow();
    expect(() => resolveStoredPath(base, '')).toThrow();
  });

  it('sanitizes display names: strips control chars, separators, caps length', () => {
    expect(sanitizeDisplayName('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(sanitizeDisplayName('evil\r\nSet-Cookie: x')).toBe('evilSet-Cookie: x');
    expect(sanitizeDisplayName('\u0000\u0000')).toBe('attachment');
    expect(sanitizeDisplayName('')).toBe('attachment');
    expect(sanitizeDisplayName('x'.repeat(300)).length).toBe(180);
  });

  it('builds a Content-Disposition with no CR/LF and both filename forms', () => {
    const header = contentDispositionAttachment('résumé v2.pdf');
    expect(header).toContain('attachment;');
    expect(header).toContain('filename="');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).not.toMatch(/[\r\n]/u);
    // A header-injection attempt cannot break out: no CR/LF, and the embedded
    // quote is neutralized so the quoted filename has exactly one segment.
    const injected = contentDispositionAttachment('a"\r\nSet-Cookie: evil=1');
    expect(injected).not.toMatch(/[\r\n]/u);
    expect(injected.split('"')).toHaveLength(3); // prefix, filename value, suffix
  });
});
