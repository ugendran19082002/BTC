/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // `@/` means src/. Imports then say what a module is rather than how far away
  // it happens to sit, so moving a component does not rewrite its neighbours.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // the API lives on the Fastify process; proxying keeps the browser on one origin
    // changeOrigin off: the API refuses a change whose Origin is not its Host, and
    // rewriting Host to the target would make every local POST look foreign.
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:8787', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    // No source maps in the shipped image. They were served publicly -- 1.8 MB
    // beside a 490 KB bundle, and the whole source readable by anyone.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Libraries change far less often than the desk does. Split out, they
        // stay cached in the browser across deploys instead of downloading again.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('@radix-ui')) return 'radix';
          if (/react-day-picker|date-fns/.test(id)) return 'dates';
          if (id.includes('lucide-react')) return 'icons';
          // The chart library on its own: the phone (/m) draws no chart, and while it sat in `vendor` beside
          // clsx and tailwind-merge every phone load downloaded ~190 KB of it for one `cn()` (audit, 9 Oct 2026).
          if (/[\\/]node_modules[\\/](lightweight-charts|fancy-canvas)[\\/]/.test(id)) return 'charts';
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    /*
     * The default pool, deliberately.
     *
     * Thirty-one files each build their own jsdom, which is a quarter of the
     * run — and vitest says so on every run. Both ways out are worse:
     * `pool: 'vmThreads'` reuses one per worker but runs files in `node:vm`
     * contexts, where `instanceof` across realms stops working and 24 of 31
     * files fail on jest-dom's matchers; `isolate: false` shares the
     * environment across files, and this app has module-level state — the
     * network-failure counter, localStorage — so the suite would leak between
     * files and fail in ways nobody can reproduce.
     *
     * Five seconds is not worth either. Left as it is, with the reason written
     * down so the next person does not spend an afternoon rediscovering it.
     */
    globals: true,
    /*
     * Fifteen seconds a test, not vitest's five.
     *
     * The first test of a screen pays for loading and drawing all of it: the P&L screen's first takes 1.3 s on
     * an idle machine, and the full suite -- 78 files at once -- runs it about four times slower. On 2 Oct 2026
     * that tipped it past five seconds on one run and not the next. A test that truly hangs still fails; it fails
     * at fifteen, not at five.
     */
    testTimeout: 15_000,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
