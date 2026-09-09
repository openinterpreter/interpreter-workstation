import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: [
      'src/**/*.ui.test.tsx',
      'src/**/*.vitest.test.ts',
      'agent/**/*.ui.test.tsx',
      'agent/**/*.vitest.test.ts',
      'server/**/*.vitest.test.ts',
    ],
    environment: 'jsdom',
    // Server-side tests exercise real child processes and file IO; they run in
    // the plain node environment instead of jsdom.
    environmentMatchGlobs: [['server/**', 'node']],
    setupFiles: ['./tests/setup/vitest.ts'],
    css: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    // Unbounded worker fan-out made interaction-heavy UI tests miss their
    // five-second deadlines on otherwise healthy code and multiplied the
    // child-process load from server tests.
    maxWorkers: 4,
    minWorkers: 1,
    // Cold dependency transforms on CI can legitimately push interaction-heavy
    // renderer tests beyond Vitest's five-second default without indicating a
    // hung interaction. Keep the deadline bounded while avoiding false failures.
    testTimeout: 10_000,
    passWithNoTests: false,
  },
});
