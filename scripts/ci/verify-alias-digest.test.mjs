import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { verifyAliasDigest } from './verify-alias-digest.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('public alias bytes match the exact same-tag checksum', async () => {
  await verifyAliasDigest(new Response('good'), 'alias.exe', 4, digest('good'));
});

test('same-size wrong content fails instead of accepting a Content-Length match', async () => {
  await assert.rejects(verifyAliasDigest(new Response('evil'), 'alias.exe', 4, digest('good')),
    /digest does not match SHA256SUMS/);
});

test('missing and truncated public alias bytes fail closed', async () => {
  await assert.rejects(verifyAliasDigest(new Response('few'), 'alias.exe', 4, digest('good')),
    /incomplete bytes/);
  await assert.rejects(verifyAliasDigest(new Response(null, { status: 404 }), 'alias.exe', 4, digest('good')),
    /no readable body/);
});
