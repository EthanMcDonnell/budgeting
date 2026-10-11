import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.PORT ?? 4777);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // Served locally, so one bundle is fine.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${API_PORT}` },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as any);
