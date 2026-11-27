import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Electron E2E retains first-attempt failure traces, screenshots, and console logs in CI', async () => {
  const config = await readFile('playwright.config.ts', 'utf8');
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const shard = workflow.split('  electron-e2e-shard:')[1]?.split('\n  electron-e2e:')[0];
  assert.ok(shard, 'Electron E2E shard job is missing');
  assert.match(config, /trace:\s*["']retain-on-failure["']/);
  assert.match(config, /screenshot:\s*["']only-on-failure["']/);
  assert.match(shard, /- run: pnpm run test:e2e:ci/);
  assert.match(shard, /- name: Upload Electron E2E failure diagnostics\n\s+if: failure\(\)\n\s+uses: actions\/upload-artifact@v7/);
  assert.match(shard, /name: electron-e2e-diagnostics-shard-\$\{\{ matrix\.shard \}\}/);
  assert.match(shard, /test-runs\/\*\*\/logs/);
  assert.match(shard, /test-runs\/\*\*\/test-results/);
});
