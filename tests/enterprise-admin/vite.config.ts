import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({ root, plugins: [tailwindcss()], build: {
  outDir: '../../.tmp/enterprise-admin-browser', emptyOutDir: true, minify: false,
} });
