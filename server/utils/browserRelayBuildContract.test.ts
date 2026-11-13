import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;

test('separate Electron builds prepare the browser relay before bundling', () => {
  const commands = scripts['build:electron'].split(' && ');
  expect(commands[0]).toBe('pnpm run ensure:browser-extension-relay-assets');
  const bundleIndex = commands.findIndex((command) => /\bnode build-electron\.mjs$/.test(command));
  expect(bundleIndex).toBeGreaterThan(0);
  const simpleRuntimeIndex = commands.indexOf('pnpm run ensure:simple-interface-runtime-assets');
  expect(simpleRuntimeIndex).toBeGreaterThanOrEqual(0);
  expect(simpleRuntimeIndex).toBeLessThan(bundleIndex);
});

test('full and separate Electron builds retain a relay preparation path', () => {
  expect(scripts.build).toMatch(/\bpnpm run build:electron$/);
  expect(scripts['build:electron']).toMatch(/^pnpm run ensure:browser-extension-relay-assets && /);
  expect(scripts['ensure:browser-extension-relay-assets']).toMatch(/ensure-browser-extension-relay-assets\.mjs$/);
});
