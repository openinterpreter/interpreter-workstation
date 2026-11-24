import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForPublishedManifest } from './wait-for-published-manifest.mjs';

const options = {
  baseUrl: 'https://example.test/releases',
  name: 'latest.yml',
  version: '0.2.260',
  filenames: ['Interpreter-win-x64-0.2.260.exe'],
  sleep: async () => {},
  retryDelayMs: 0,
  maxAttempts: 3,
};
const reply = (body, status = 200) => ({ status, ok: status === 200, text: async () => body });
const current = 'version: 0.2.260\npath: Interpreter-win-x64-0.2.260.exe\n';

test('stale public alias converges only to the exact version and asset', async () => {
  const calls = [];
  const responses = [reply('version: 0.2.259\n'), reply('version: 0.2.259\n'), reply(current)];
  await waitForPublishedManifest({
    ...options,
    fetchManifest: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });
  assert.equal(calls.length, 3);
  const keys = calls.map(({ url }) => url.searchParams.get('release_verify'));
  assert.match(keys[0], /^0\.2\.260-[0-9a-f-]{36}-1$/);
  assert.deepEqual(keys.map((key) => key.slice(0, -1)), Array(3).fill(keys[0].slice(0, -1)));
  assert.deepEqual(keys.map((key) => key.at(-1)), ['1', '2', '3']);
  for (const { init } of calls) {
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers['Cache-Control'], 'no-cache');
    assert.equal(init.headers.Pragma, 'no-cache');
    assert.ok(init.signal);
  }
});

test('persistent stale version fails closed after the bounded attempts', async () => {
  let count = 0;
  await assert.rejects(waitForPublishedManifest({
    ...options,
    fetchManifest: async () => { count += 1; return reply('version: 0.2.259\n'); },
  }), /latest.yml did not converge to 0\.2\.260 after 3 attempts: wrong version/);
  assert.equal(count, 3);
});

test('matching version without required asset also fails closed', async () => {
  await assert.rejects(waitForPublishedManifest({
    ...options,
    fetchManifest: async () => reply('version: 0.2.260\npath: unrelated.exe\n'),
  }), /missing required asset Interpreter-win-x64-0\.2\.260\.exe/);
});

test('authorization denial fails immediately rather than retrying', async () => {
  let count = 0;
  await assert.rejects(waitForPublishedManifest({
    ...options,
    fetchManifest: async () => { count += 1; return reply('', 403); },
  }), /non-retryable HTTP 403/);
  assert.equal(count, 1);
});

test('transient missing public object can converge without accepting an old version', async () => {
  let count = 0;
  await waitForPublishedManifest({
    ...options,
    fetchManifest: async () => {
      count += 1;
      return count === 1 ? reply('', 404) : reply(current);
    },
  });
  assert.equal(count, 2);
});

test('network error text cannot masquerade as a permanent HTTP denial', async () => {
  let count = 0;
  await waitForPublishedManifest({
    ...options,
    fetchManifest: async () => {
      count += 1;
      if (count === 1) throw new Error('transient proxy says non-retryable HTTP in its message');
      return reply(current);
    },
  });
  assert.equal(count, 2);
});

test('attempt cap cannot be raised beyond the release bound', async () => {
  await assert.rejects(waitForPublishedManifest({
    ...options, maxAttempts: 13, fetchManifest: async () => reply(current),
  }), /between 1 and 12/);
});
