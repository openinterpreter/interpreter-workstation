import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const workerEntrySource = fs.readFileSync(
  path.join(import.meta.dir, 'workerEntry.ts'),
  'utf8',
);

describe('workerEntry home routing', () => {
  test('routes bundled worker runs through runStandaloneCli', () => {
    expect(workerEntrySource).toContain('import { runStandaloneCli } from "./standalone";');
    expect(workerEntrySource).toContain('void runStandaloneCli().catch((err) => {');
    expect(workerEntrySource).not.toContain('runHeadlessTaskCli');
  });
});
