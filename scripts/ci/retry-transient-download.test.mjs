import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientDownloadFailure, retryTransientDownload } from './retry-transient-download.mjs';

test('only transport 502/503/504 retries; assertions and auth failures never do', async () => {
  for (const text of ['HTTPError: Response code 504 (Gateway Time-out)',
    'curl: (22) The requested URL returned error: 503', 'Response code 502']) {
    assert.equal(isTransientDownloadFailure(text), true);
  }
  for (const text of ['Assertion failed: expected 504', 'Response code 401',
    'curl: (6) DNS resolution failed', 'test failed']) {
    assert.equal(isTransientDownloadFailure(text), false);
  }
  let calls = 0;
  const result = await retryTransientDownload('fixture', [], { delay: async () => {}, execute: async () => {
    calls++;
    return calls === 1 ? { code: 22, tail: 'curl: (22) The requested URL returned error: 504' }
      : { code: 0, tail: '' };
  } });
  assert.equal(result, 0);
  assert.equal(calls, 2);
  calls = 0;
  assert.equal(await retryTransientDownload('fixture', [], { execute: async () => {
    calls++;
    return { code: 17, tail: 'test assertion failed' };
  } }), 17);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await retryTransientDownload('fixture', [], { delay: async () => {}, execute: async () => {
    calls++;
    return { code: 22, tail: 'Response code 504' };
  } }), 22);
  assert.equal(calls, 3);
});
