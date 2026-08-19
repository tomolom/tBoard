// Bundles the web server into a single plain-Node ESM entrypoint at
// out/server/index.js, mirroring scripts/buildMcp.mjs. better-sqlite3 (native)
// and fastify are kept external and resolved from node_modules at runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'out/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Native + heavy deps stay external; installed on the server via npm.
  external: ['better-sqlite3', 'fastify', '@fastify/cookie', '@fastify/static', '@fastify/rate-limit'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
