import path from 'node:path';
import { availableParallelism } from 'node:os';
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
    // Keep one CPU free for the test coordinator and child processes. Four
    // jsdom workers on a two-core runner starve interactions beyond their
    // ten-second deadlines even when each test passes in isolation.
    maxWorkers: Math.max(1, Math.min(2, availableParallelism() - 1)),
    minWorkers: 1,
    // Cold dependency transforms on CI can legitimately push interaction-heavy
    // renderer tests beyond Vitest's five-second default without indicating a
    // hung interaction. Keep the deadline bounded while avoiding false failures.
    testTimeout: 10_000,
    passWithNoTests: false,
  },
});
