/**
 * Server configuration, entirely from environment variables so no secret ever
 * lives in the repo. Loaded once at startup; throws early with a clear message
 * if a required value is missing or malformed.
 */
export type ServerConfig = {
  /** Port the Node server listens on (bound to host below). */
  port: number;
  /** Bind host — defaults to 127.0.0.1 so only the local reverse proxy reaches it. */
  host: string;
  /** The exact public origin (scheme+host[:port]) used for strict Origin checks. */
  publicOrigin: string;
  /** scrypt:... hash of the shared password. */
  passwordHash: string;
  /** Whether to mark cookies Secure (true in production behind TLS). */
  cookieSecure: boolean;
  /**
   * Fastify trustProxy value. 'loopback' (default) suits a reverse proxy on the
   * same host (systemd + Caddy). In Docker, Caddy is a separate container and
   * the tBoard port is NOT published to the host, so only Caddy can reach it —
   * set TBOARD_TRUST_PROXY=true there to read the real client IP. Never set true
   * on a server whose port is directly reachable (spoofable X-Forwarded-For).
   */
  trustProxy: boolean | string;
};

function parseTrustProxy(value: string | undefined): boolean | string {
  if (value === undefined || value.trim() === '') {
    return 'loopback';
  }
  const trimmed = value.trim();
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true';
  }
  // An IP, subnet, or 'loopback'/'linklocal'/'uniquelocal' keyword.
  return trimmed;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const passwordHash = env.TBOARD_AUTH_PASSWORD_HASH?.trim();
  if (!passwordHash) {
    throw new Error(
      'TBOARD_AUTH_PASSWORD_HASH is required. Generate one with `npm run server:hash-password` and set it in the environment.',
    );
  }
  if (!passwordHash.startsWith('scrypt:')) {
    throw new Error('TBOARD_AUTH_PASSWORD_HASH must be a scrypt:... hash (from `npm run server:hash-password`).');
  }

  const publicOrigin = env.TBOARD_PUBLIC_ORIGIN?.trim();
  if (!publicOrigin) {
    throw new Error('TBOARD_PUBLIC_ORIGIN is required, e.g. https://board.example.com (used for strict Origin checks).');
  }
  try {
    const url = new URL(publicOrigin);
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error('origin must be scheme + host only');
    }
  } catch {
    throw new Error(`TBOARD_PUBLIC_ORIGIN is not a valid origin: ${publicOrigin}`);
  }

  const port = Number(env.TBOARD_SERVER_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TBOARD_SERVER_PORT is not a valid port: ${env.TBOARD_SERVER_PORT}`);
  }

  return {
    port,
    host: env.TBOARD_SERVER_HOST?.trim() || '127.0.0.1',
    publicOrigin: new URL(publicOrigin).origin,
    passwordHash,
    // Secure cookies by default; opt out only for local http testing.
    cookieSecure: parseBooleanEnv(env.TBOARD_COOKIE_SECURE, true),
    trustProxy: parseTrustProxy(env.TBOARD_TRUST_PROXY),
  };
}
