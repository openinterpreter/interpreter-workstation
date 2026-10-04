import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { getRootDirs } = require('@next/eslint-plugin-next/dist/utils/get-root-dirs.js');

test('Next ESLint root glob retains directory-only matching', () => {
  const cwd = resolve(import.meta.dirname, '..');
  const context = (rootDir) => ({ cwd, settings: { next: { rootDir } } });
  assert.deepEqual(getRootDirs(context(undefined)), [cwd]);
  assert.deepEqual(getRootDirs(context('app')), ['app/']);
  assert.deepEqual(getRootDirs(context('app/*')), []);
  assert.deepEqual(getRootDirs(context(['app', 'components'])), ['app/', 'components/']);
});
