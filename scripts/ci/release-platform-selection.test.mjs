import assert from 'node:assert/strict';
import test from 'node:test';
import { releasePlatformSelection } from './release-platform-selection.mjs';

test('default all-platform release still schedules both macOS architectures', () => {
  const value = releasePlatformSelection('all');
  assert.equal(value.mode, 'all');
  assert.deepEqual(value.matrix.include.map(job => job.id),
    ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64']);
});

test('explicit Windows/Linux release schedules no Apple signing jobs', () => {
  const value = releasePlatformSelection('windows-linux');
  assert.equal(value.mode, 'windows-linux');
  assert.deepEqual(value.matrix.include.map(job => job.id), ['windows-x64', 'linux-x64']);
  assert.ok(value.matrix.include.every(job => job.os !== 'macos'));
});

test('missing or unknown selection fails closed', () => {
  for (const mode of [undefined, '', 'macos', 'windows-linux,all', 'ALL']) {
    assert.throws(() => releasePlatformSelection(mode));
  }
});
