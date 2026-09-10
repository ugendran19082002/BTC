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
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:8787', changeOrigin: true } },
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
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
