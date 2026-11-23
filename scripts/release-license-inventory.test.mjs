import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeLicenseInventories, productionLicenseFilters } from './release-license-inventory.mjs';

test('production license inventory includes backend-only dependencies exactly once', () => {
  assert.deepEqual(productionLicenseFilters, ['.', '@openinterpreter/browser-agent-core']);
  const root = { MIT: [{ name: 'shared', versions: ['1.0.0'] }] };
  const browser = { MIT: [{ name: 'shared', versions: ['1.0.0'] },
    { name: 'browser-only', versions: ['2.0.0'] }] };
  assert.deepEqual(mergeLicenseInventories([root, browser]).MIT.map(entry => entry.name),
    ['shared', 'browser-only']);
  assert.throws(() => mergeLicenseInventories([root, { error: { code: 'MISSING' } }]));
});
