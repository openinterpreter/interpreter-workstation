const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPackage } = require('@electron/asar');

const { assertStartupUrlDependencies } = require('./afterPack.cjs');

const required = [
  '/node_modules/whatwg-url/lib/url-state-machine.js',
  '/node_modules/@exodus/bytes/package.json',
  '/node_modules/@exodus/bytes/encoding.js',
  '/node_modules/@exodus/bytes/whatwg.js',
];

test('packaging rejects a missing main-process URL dependency before release', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'startup-url-dependencies-'));
  try {
    writeFileSync(path.join(dir, 'app.asar'), 'test fixture');
    assert.doesNotThrow(() => assertStartupUrlDependencies(dir, () => required));
    for (const omitted of required.slice(1)) {
      assert.throws(
        () => assertStartupUrlDependencies(dir, () => required.filter((entry) => entry !== omitted)),
        (error) => error.message.endsWith(omitted.slice(1)),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ASAR inventory detects the exact broken whatwg-url startup path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'startup-url-asar-'));
  const input = path.join(dir, 'input');
  const resources = path.join(dir, 'resources');
  mkdirSync(resources);
  try {
    const add = (entry) => {
      const destination = path.join(input, entry);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, 'fixture');
    };
    add(required[0].slice(1));
    await createPackage(input, path.join(resources, 'app.asar'));
    assert.throws(() => assertStartupUrlDependencies(resources), /@exodus\/bytes\/package.json/);
    for (const entry of required.slice(1)) add(entry.slice(1));
    const fixedResources = path.join(dir, 'fixed-resources');
    mkdirSync(fixedResources);
    await createPackage(input, path.join(fixedResources, 'app.asar'));
    assert.doesNotThrow(() => assertStartupUrlDependencies(fixedResources));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the elevated Windows installer never launches an app with Administrator-owned userData', () => {
  const root = path.resolve(__dirname, '../..');
  const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const updater = readFileSync(path.join(root, 'electron/autoUpdater.ts'), 'utf8');
  assert.match(builder, /nsis:\s*\n\s*perMachine: true\s*\n(?:\s*#.*\n)*\s*runAfterFinish: false/);
  assert.match(updater, /autoUpdater\.quitAndInstall\(false, false\)/);
  for (const locale of readdirSync(path.join(root, 'shared/locales')).filter((name) => name.endsWith('.json'))) {
    const strings = JSON.parse(readFileSync(path.join(root, 'shared/locales', locale), 'utf8'));
    for (const key of ['windowsSubtitle', 'windowsInstall', 'windowsInstalling']) {
      assert.ok(strings[`appUpdate.${key}`], `${locale} is missing the manual-reopen copy`);
    }
  }
});
