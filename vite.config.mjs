import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('src'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve('dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    chunkSizeWarningLimit: 20000,
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
});
