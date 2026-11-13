import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** Separate static/browser-only artifact: it never loads the Electron/OIX entrypoint. */
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  base: './',
  build: {
    outDir: 'dist-browser-project',
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'index.html') },
  },
  server: { host: '127.0.0.1', port: 0 },
});
