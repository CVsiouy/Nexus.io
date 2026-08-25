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
    // Vite rejects requests whose Host header it doesn't recognise. A tunnel
    // sends its own random hostname, so the playtest setup opts out — see
    // docker-compose.playtest.yml. Left strict everywhere else.
    ...(process.env.VITE_ALLOWED_HOSTS === 'all' ? { allowedHosts: true } : {}),
    // A tunnel serves over HTTPS while the container speaks HTTP, so hot-reload
    // has to be told which protocol and port the browser actually sees.
    ...(process.env.VITE_ALLOWED_HOSTS === 'all'
      ? { hmr: { clientPort: 443, protocol: 'wss' } }
      : {}),
  },
  resolve: {
    // Explicit paths rather than relying on npm's workspace symlinks —
    // symlink resolution through a Docker bind-mount is fragile, and this
    // removes the whole class of problem.
    alias: {
      '@basewar/sim': pkg('../../packages/sim/index.js'),
      '@basewar/protocol': pkg('../../packages/protocol/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
});
