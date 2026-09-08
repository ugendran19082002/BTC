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
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
