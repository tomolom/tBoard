// Bundles the MCP stdio server into a single plain-Node ESM entrypoint at
// out/mcp/stdio.js, so AI harnesses can spawn it with `node <path>` — no tsx,
// no TypeScript, no cwd assumptions. The native better-sqlite3 module is kept
// external (a .node binary cannot be bundled); it resolves from the repo's
// node_modules at runtime, same as every other script here.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/mcp/stdio.ts'],
  outfile: 'out/mcp/stdio.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3'],
  // ESM output needs a shim so bundled CJS deps that reference require() work.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
