import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Invalid or duplicate release checksum entry');
    entries.set(match[2], match[1]);
  }
  if (!entries.size) throw new Error('Empty release checksums');
  return entries;
}

export async function releaseIdentity(directory) {
  const checksums = parseChecksums(await readFile(path.join(directory, 'SHA256SUMS'), 'utf8'));
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (names.length !== checksums.size + 1 || !names.includes('SHA256SUMS')) {
    throw new Error('Release files and SHA256SUMS do not match exactly');
  }
  const assets = new Map();
  for (const name of names) {
    const file = path.join(directory, name);
    const [digest, metadata] = await Promise.all([sha256(file), stat(file)]);
    if (name !== 'SHA256SUMS' && checksums.get(name) !== digest) {
      throw new Error(`Release checksum mismatch: ${name}`);
    }
    if (name !== 'SHA256SUMS' && !checksums.has(name)) throw new Error(`Unlisted asset: ${name}`);
    assets.set(name, { name, file, size: metadata.size, digest: `sha256:${digest}` });
  }
  return assets;
}

export function reconcile(expected, actual, name) {
  if (!actual) return 'missing';
  if (actual.size !== expected.size || actual.digest !== expected.digest) {
    throw new Error(`Immutable ${name} identity mismatch`);
  }
  return 'matching';
}
