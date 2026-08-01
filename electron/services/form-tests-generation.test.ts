import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildGeneratedTests,
  generateTests,
} = require('../../form-tests/generate-tests.cjs');

const RECEIPT_GENERATION_TIMEOUT_MS = 15_000;

describe('form test generation', () => {
  // NOTE(victor): Sharp rasterization can exceed Bun's 5s default timeout on slower CI runners.
  test('builds receipt fixtures in memory with inline image data', async () => {
    const generatedTests = await buildGeneratedTests({ selectedIds: ['test-011'] });

    expect(generatedTests).toHaveLength(1);
    expect(generatedTests[0].testId).toBe('test-011');
    expect(generatedTests[0].config.info.document.imageUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(generatedTests[0].config.info.document.receiptAsset).toBeUndefined();
  }, RECEIPT_GENERATION_TIMEOUT_MS);

  test('writes inspection artifacts without standalone receipt image files', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'form-tests-generated-'));

    try {
      const generatedTests = await generateTests({
        outputDir,
        selectedIds: ['test-011'],
        log: false,
      });

      expect(generatedTests).toHaveLength(1);

      const testDir = join(outputDir, 'test-011');
      const files = (await readdir(testDir)).sort();
      expect(files).toEqual(['analysis.txt', 'config.json', 'document.txt']);

      const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf8'));
      expect(config.info.document.imageUrl.startsWith('data:image/png;base64,')).toBe(true);

      const summary = await readFile(join(outputDir, 'SUMMARY.md'), 'utf8');
      expect(summary).toContain('test-011');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, RECEIPT_GENERATION_TIMEOUT_MS);
});
