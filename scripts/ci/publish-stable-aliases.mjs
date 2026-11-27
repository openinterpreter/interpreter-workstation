#!/usr/bin/env node
// Copy immutable versioned installers to mutable download names without
// re-uploading large payloads through the gateway. Verify actual bytes.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseIdentity } from './release-identity.mjs';

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export function aliasesFor(version, mode) {
  if (!/^0\.2\.\d+$/.test(version) || !['all', 'windows-linux'].includes(mode))
    throw new Error('Exact release version and platform mode required');
  const mappings = new Map([
    ['Interpreter-x64.exe', `Interpreter-win-x64-${version}.exe`],
    ['Interpreter-latest.AppImage', `Interpreter-linux-x86_64-${version}.AppImage`],
    ['Interpreter-linux-amd64.deb', `Interpreter-linux-amd64-${version}.deb`],
  ]);
  if (mode === 'all') {
    mappings.set('Interpreter-arm64.dmg', `Interpreter-arm64-${version}.dmg`);
    mappings.set('Interpreter-x64.dmg', `Interpreter-x64-${version}.dmg`);
  }
  return mappings;
}

export async function reconcileAliases({ mappings, identity, verifySource, readAlias, copyAlias,
  attempts = 4, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) throw new Error('Invalid copy attempt bound');
  // Check every immutable source and destination before changing any alias.
  for (const source of mappings.values()) await verifySource(source, identity.get(source));
  const states = new Map();
  for (const [alias, source] of mappings) states.set(alias, await readAlias(alias, identity.get(source)));
  for (const [alias, source] of mappings) {
    if (states.get(alias) === 'matching') continue;
    let matched = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (await readAlias(alias, identity.get(source)) === 'matching') { matched = true; break; }
      let result;
      try { result = await copyAlias(source, alias); }
      catch { result = { code: -1 }; }
      // A timed-out response may follow an already committed copy.
      if (await readAlias(alias, identity.get(source)) === 'matching') { matched = true; break; }
      if (result.code === 0) throw new Error(`Copy returned success without matching bytes: ${alias}`);
      if (attempt < attempts) await pause(attempt * 1000);
    }
    if (!matched) throw new Error(`Alias not reconciled after ${attempts} attempts: ${alias}`);
  }
  for (const [alias, source] of mappings) {
    await verifySource(source, identity.get(source));
    if (await readAlias(alias, identity.get(source)) !== 'matching')
      throw new Error(`Alias changed after publication: ${alias}`);
  }
}

function runAws(args, hashOutput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256');
    let size = 0;
    let output = '';
    let stderr = '';
    child.stdout.on('data', (bytes) => {
      if (hashOutput) { hash.update(bytes); size += bytes.length; }
      else output += bytes.toString();
    });
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-2048); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output, stderr, size,
      digest: hashOutput ? `sha256:${hash.digest('hex')}` : undefined }));
  });
}

export async function main(args) {
  const [version, mode, bucket, prefix, endpoint, region, directory = 'release'] = args;
  const mappings = aliasesFor(version, mode);
  if (!bucket || !/^[a-z0-9-]+$/.test(bucket) || !prefix || !endpoint || !region ||
      process.env.RELEASE_VERSION !== version || process.env.RELEASE_PLATFORM_MODE !== mode ||
      process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Alias publication context invalid');
  const root = path.resolve(directory);
  const identity = await releaseIdentity(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'RELEASE-MANIFEST.json'), 'utf8'));
  if (manifest.version !== version || manifest.source?.repository !== process.env.GITHUB_REPOSITORY ||
      manifest.source?.commit !== process.env.GITHUB_SHA ||
      manifest.build?.runId !== process.env.GITHUB_RUN_ID ||
      !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) {
    throw new Error('Stable aliases do not belong to this exact release run');
  }
  const aws = ['--endpoint-url', endpoint, '--region', region];
  const key = (name) => `${prefix.replace(/\/$/, '')}/${name}`;
  const object = (name) => `s3://${bucket}/${key(name)}`;
  const remote = (name) => runAws(['s3', 'cp', object(name), '-', '--no-progress', ...aws], true);
  const read = async (name) => {
    const head = await runAws(['s3api', 'head-object', '--bucket', bucket, '--key', key(name), ...aws]);
    if (head.code !== 0) {
      if (/\b(?:404|NoSuchKey|Not Found)\b/.test(head.stderr)) return null;
      throw new Error(`Cannot inspect object: ${name}`);
    }
    let metadata;
    try { metadata = JSON.parse(head.output); }
    catch { throw new Error(`Invalid object metadata: ${name}`); }
    if (!Number.isSafeInteger(metadata.ContentLength) || metadata.ContentLength < 1)
      throw new Error(`Invalid object size: ${name}`);
    return metadata.ContentLength;
  };
  const digestRemote = async (name, asset, { allowMissing = false } = {}) => {
    if (!asset) throw new Error(`Missing release checksum identity: ${name}`);
    const size = await read(name);
    if (size === null && allowMissing) return 'missing';
    if (size === null || size !== asset.size) {
      if (allowMissing) return 'mismatch';
      throw new Error(`Immutable source size mismatch: ${name}`);
    }
    const result = await remote(name);
    if (result.code !== 0 || result.size !== asset.size) throw new Error(`Cannot hash object: ${name}`);
    if (result.digest !== asset.digest) {
      if (allowMissing) return 'mismatch';
      throw new Error(`Immutable source digest mismatch: ${name}`);
    }
    return 'matching';
  };
  await reconcileAliases({ mappings, identity,
    verifySource: async (name, asset) => {
      await digestRemote(name, asset);
      console.log(`Verified immutable ${name}: ${asset.digest}`);
    },
    readAlias: (name, asset) => digestRemote(name, asset, { allowMissing: true }),
    copyAlias: async (source, alias) => {
      const result = await runAws(['s3api', 'copy-object', '--bucket', bucket, '--key', key(alias),
        '--copy-source', `${bucket}/${key(source)}`, '--metadata-directive', 'COPY', ...aws]);
      let copyEvidence = {};
      try {
        const observed = JSON.parse(result.output);
        copyEvidence = { sourceVersionId: observed.CopySourceVersionId ?? null,
          destinationETag: observed.CopyObjectResult?.ETag ?? null };
      } catch { /* A failed copy may have no response; the digest recheck decides. */ }
      console.log(`Copy ${source} -> ${alias}: exit=${result.code} ${JSON.stringify(copyEvidence)}`);
      return result;
    },
  });
  for (const [alias, source] of mappings) {
    console.log(`Verified alias ${alias} from ${source}: ${identity.get(source).digest}`);
  }
  console.log(`Verified ${mappings.size} exact stable alias digests for v${version}`);
}

if (direct) main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
