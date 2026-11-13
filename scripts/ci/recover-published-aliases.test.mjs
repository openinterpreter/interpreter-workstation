import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { reconcilePointers, updaterVersion, verifyMetadata } from './recover-published-aliases.mjs';

const hex = (text) => createHash('sha256').update(text).digest('hex');

function fixture() {
  const targets = new Map([['alias-a', 'artifact-a'], ['alias-b', 'artifact-b']]);
  const updater = ['latest.yml'];
  const identity = new Map([['artifact-a', { digest: `sha256:${hex('a')}`, size: 1 }],
    ['artifact-b', { digest: `sha256:${hex('b')}`, size: 1 }]]);
  const existing = new Map([['alias-a', 'old'], ['alias-b', 'old'], ['latest.yml', 'old']]);
  const calls = [];
  let latest = true;
  const helpers = {
    targets, updater, identity, retry: 2, pause: async () => {},
    verifyLatest: async () => { if (!latest) throw new Error('A different release became latest'); },
    verifySource: async (source, asset) => {
      calls.push(`verify ${source}`);
      assert.equal(asset, identity.get(source));
    },
    readTarget: async (name) => {
      const state = existing.get(name);
      if (state === 'unknown') throw new Error(`Unrecognized existing pointer: ${name}`);
      calls.push(`read ${name}=${state}`);
      return state === 'new' ? 'matching' : 'old';
    },
    copy: async (_, name) => { calls.push(`copy ${name}`); existing.set(name, 'new'); return { code: 0 }; },
    promote: async (name) => { calls.push(`promote ${name}`); existing.set(name, 'new'); return { code: 0 }; },
  };
  return { helpers, existing, calls, setLatest: (value) => { latest = value; } };
}

test('partial success preserves matching alias and promotes updater last', async () => {
  const f = fixture();
  f.existing.set('alias-a', 'new');
  await reconcilePointers(f.helpers);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('copy')), ['copy alias-b']);
  assert.ok(f.calls.slice(0, f.calls.indexOf('promote latest.yml')).includes('read alias-b=new'));
  const writes = f.calls.length;
  await reconcilePointers(f.helpers);
  assert.equal(f.calls.slice(writes).filter((call) => /^(copy|promote) /.test(call)).length, 0);
});

test('unknown alias or newer release fails before a write', async () => {
  const f = fixture();
  f.existing.set('alias-b', 'unknown');
  await assert.rejects(reconcilePointers(f.helpers), /Unrecognized existing pointer/);
  assert.ok(!f.calls.some((call) => /^(copy|promote) /.test(call)));
  f.existing.set('alias-b', 'old');
  f.setLatest(false);
  await assert.rejects(reconcilePointers(f.helpers), /different release/);
  assert.ok(!f.calls.some((call) => /^(copy|promote) /.test(call)));
});

test('immutable source mismatch aborts before aliases and updater change', async () => {
  const f = fixture();
  f.helpers.verifySource = async (name) => {
    if (name === 'artifact-b') throw new Error('Immutable source object mismatch');
  };
  await assert.rejects(reconcilePointers(f.helpers), /Immutable source object mismatch/);
  assert.ok(!f.calls.some((call) => /^(copy|promote) /.test(call)));
  assert.equal(f.existing.get('latest.yml'), 'old');
});

test('updater promotion lost response reconciles exact bytes on retry', async () => {
  const f = fixture();
  f.helpers.promote = async (name) => {
    f.calls.push(`promote ${name}`);
    f.existing.set(name, 'new');
    throw new Error('response lost');
  };
  await reconcilePointers(f.helpers);
  const count = f.calls.filter((call) => call === 'promote latest.yml').length;
  await reconcilePointers(f.helpers);
  assert.equal(f.calls.filter((call) => call === 'promote latest.yml').length, count);
});

test('committed copy whose response is lost is reconciled; interrupted retry does not promote early', async () => {
  const f = fixture();
  f.helpers.copy = async (_, name) => {
    f.calls.push(`copy ${name}`);
    if (name === 'alias-a') { f.existing.set(name, 'new'); throw new Error('response lost'); }
    throw new Error('retry later');
  };
  await assert.rejects(reconcilePointers(f.helpers), /Alias unavailable after retries/);
  assert.equal(f.existing.get('alias-a'), 'new');
  assert.equal(f.existing.get('latest.yml'), 'old');
  f.helpers.copy = async (_, name) => { f.calls.push(`copy ${name}`); f.existing.set(name, 'new'); return { code: 0 }; };
  await reconcilePointers(f.helpers);
  assert.equal(f.calls.filter((call) => call === 'copy alias-a').length, 1);
  assert.equal(f.existing.get('latest.yml'), 'new');
});

test('updater refuses a future version and metadata refuses a changed immutable digest', () => {
  assert.equal(updaterVersion(Buffer.from('version: 0.2.215\n')), '0.2.215');
  assert.throws(() => updaterVersion(Buffer.from('version: 0.2.222\n')), /Newer/);
  assert.throws(() => updaterVersion(Buffer.from('nonsense')), /Unrecognized/);
  const files = new Map([['SHA256SUMS', Buffer.from('changed')],
    ['RELEASE-MANIFEST.json', Buffer.from('{}')]]);
  assert.throws(() => verifyMetadata(files, new Map()), /Invalid|provenance/);
});
