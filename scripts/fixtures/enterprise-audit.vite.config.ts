import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Start with: vite --config scripts/fixtures/enterprise-audit.vite.config.ts --host 127.0.0.1 --port 55472
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: ['scripts/fixtures/enterprise-audit-fixture.html'] },
  server: { host: '127.0.0.1', port: 55472, strictPort: true },
});
