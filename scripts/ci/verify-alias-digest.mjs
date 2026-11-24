import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Stream the public response: a matching Content-Length is not proof that a
// mutable download alias points to the versioned asset in SHA256SUMS.
export async function verifyAliasDigest(response, name, expectedSize, expectedDigest) {
  assert.ok(response.ok && response.body, `${name} has no readable body`);
  assert.ok(Number.isSafeInteger(expectedSize) && expectedSize > 0);
  assert.match(expectedDigest ?? '', /^[a-f0-9]{64}$/);
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    assert.ok(size <= expectedSize, `${name} exceeds expected size`);
    hash.update(bytes);
  }
  assert.equal(size, expectedSize, `${name} has incomplete bytes`);
  assert.equal(hash.digest('hex'), expectedDigest, `${name} digest does not match SHA256SUMS`);
}
