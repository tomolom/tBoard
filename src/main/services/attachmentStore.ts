import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Security primitives for on-disk attachment storage, kept separate from any
 * HTTP/Electron code so they are trivially testable. Every rule here exists to
 * prevent path traversal / arbitrary file access:
 *
 *  - stored names are random hex, never derived from user input;
 *  - a stored name is validated against a strict pattern before use;
 *  - the final path is resolved and asserted to sit INSIDE the attachments dir.
 */

const STORED_NAME_RE = /^[a-f0-9]{64}$/u;

/** Generates a fresh random on-disk name (32 bytes hex). Never user-derived. */
export function generateStoredName(): string {
  return randomBytes(32).toString('hex');
}

export function isValidStoredName(name: string): boolean {
  return STORED_NAME_RE.test(name);
}

/**
 * Resolves the absolute path for a stored attachment and guarantees it is
 * contained within `baseDir`. Throws on an invalid name or any escape attempt.
 */
export function resolveStoredPath(baseDir: string, storedName: string): string {
  if (!isValidStoredName(storedName)) {
    throw new Error('Invalid attachment name.');
  }
  const base = path.resolve(baseDir);
  const full = path.resolve(base, storedName);
  // Containment check: full must be a direct child of base.
  if (full !== path.join(base, storedName) || !full.startsWith(base + path.sep)) {
    throw new Error('Attachment path escaped the storage directory.');
  }
  return full;
}

/** The temp path used during an atomic write (same dir → rename is atomic). */
export function tempPathFor(baseDir: string, storedName: string): string {
  return path.join(path.resolve(baseDir), `.tmp-${storedName}`);
}

/**
 * Sanitizes a user filename for DISPLAY and header use only (never for a path):
 * strips path separators and control chars (incl. CR/LF/NUL to block header
 * injection) and caps the length. Falls back to "attachment".
 */
export function sanitizeDisplayName(name: string): string {
  const cleaned = (name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/]/gu, '_')
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * Builds a safe `Content-Disposition: attachment` value with both an ASCII
 * fallback (`filename="..."`) and an RFC 5987 `filename*=UTF-8''...` for
 * non-ASCII names. The display name is sanitized first, so no CR/LF/NUL can
 * reach the header.
 */
export function contentDispositionAttachment(displayName: string): string {
  const safe = sanitizeDisplayName(displayName);
  // ASCII fallback: replace any non-ASCII and quotes/backslashes.
  // eslint-disable-next-line no-control-regex
  const ascii = safe.replace(/[^\u0020-\u007e]/gu, '_').replace(/["\\]/gu, '_');
  // RFC 5987: percent-encode, keeping the unreserved set.
  const encoded = encodeURIComponent(safe).replace(/['()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
