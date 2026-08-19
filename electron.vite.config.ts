import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // The window uses sandbox: true, and Electron requires a sandboxed
          // preload to be CommonJS. package.json has "type": "module", so a
          // plain .js/.mjs preload is treated as ESM and fails to load
          // ("Cannot use import statement outside a module"), leaving
          // window.tBoard undefined. Force a CommonJS .cjs preload.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
  },
});
