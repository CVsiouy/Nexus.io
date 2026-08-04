import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const pkg = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: { usePolling: true, interval: 300 },
    // The client lives in apps/client but imports from packages/, which is
    // outside its root. Vite blocks that by default for security.
    fs: { allow: ['../..'] },
  },
  resolve: {
    // Explicit paths rather than relying on npm's workspace symlinks —
    // symlink resolution through a Docker bind-mount is fragile, and this
    // removes the whole class of problem.
    alias: {
      '@nexus/sim': pkg('../../packages/sim/index.js'),
      '@nexus/protocol': pkg('../../packages/protocol/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
});
