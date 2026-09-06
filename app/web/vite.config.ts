import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // the API lives on the Fastify process; proxying keeps the browser on one origin
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:8787', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
