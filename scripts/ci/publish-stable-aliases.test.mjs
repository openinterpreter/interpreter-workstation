import assert from 'node:assert/strict';
import test from 'node:test';
import { aliasesFor, reconcileAliases } from './publish-stable-aliases.mjs';

function fixture() {
  const mappings = new Map([['current.exe', 'versioned.exe'], ['current.deb', 'versioned.deb']]);
  const identity = new Map([...mappings.values()].map((name) => [name, { digest: `sha256:${name}`, size: 4 }]));
  const targets = new Map([['current.exe', 'sha256:old'], ['current.deb', 'sha256:old']]);
  const calls = [];
  return {
    mappings, identity, targets, calls,
    helpers: {
      mappings, identity,
      verifySource: async (name, asset) => { calls.push(`verify ${name}`); if (!asset) throw new Error('missing source'); },
      readAlias: async (name, asset) => { calls.push(`read ${name}`); return targets.get(name) === asset.digest ? 'matching' : 'mismatch'; },
      copyAlias: async (source, name) => { calls.push(`copy ${source} ${name}`); targets.set(name, identity.get(source).digest); return { code: 0 }; },
      pause: async () => {},
    },
  };
}

test('platform mappings contain only selected immutable installers', () => {
  assert.equal(aliasesFor('0.2.262', 'windows-linux').size, 3);
  assert.equal(aliasesFor('0.2.262', 'all').size, 5);
  assert.throws(() => aliasesFor('0.2.262', 'partial'), /platform mode/);
});

test('all sources are checked before any alias copy, and exact matching aliases are preserved', async () => {
  const f = fixture();
  f.targets.set('current.exe', f.identity.get('versioned.exe').digest);
  await reconcileAliases(f.helpers);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('copy')), ['copy versioned.deb current.deb']);
  assert.ok(f.calls.indexOf('verify versioned.deb') < f.calls.indexOf('copy versioned.deb current.deb'));
});

test('source mismatch fails before any alias is changed', async () => {
  const f = fixture();
  f.helpers.verifySource = async (name) => { if (name === 'versioned.deb') throw new Error('immutable mismatch'); };
  await assert.rejects(reconcileAliases(f.helpers), /immutable mismatch/);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('copy')), []);
});

test('timed-out server-side copy is reconciled by digest without replay', async () => {
  const f = fixture();
  f.helpers.copyAlias = async (source, name) => {
    f.calls.push(`copy ${name}`);
    f.targets.set(name, f.identity.get(source).digest);
    throw new Error('gateway timeout after commit');
  };
  await reconcileAliases(f.helpers);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('copy')), ['copy current.exe', 'copy current.deb']);
});

test('same-size wrong bytes after a reported success fail closed; repeated failures are bounded', async () => {
  const f = fixture();
  f.helpers.copyAlias = async () => ({ code: 0 });
  await assert.rejects(reconcileAliases(f.helpers), /success without matching bytes/);
  const g = fixture();
  g.helpers.copyAlias = async (_, name) => { g.calls.push(`copy ${name}`); return { code: 1 }; };
  await assert.rejects(reconcileAliases({ ...g.helpers, attempts: 2 }), /not reconciled after 2 attempts/);
  assert.deepEqual(g.calls.filter((call) => call.startsWith('copy')), ['copy current.exe', 'copy current.exe']);
});
