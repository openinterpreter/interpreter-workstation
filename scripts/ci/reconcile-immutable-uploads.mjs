#!/usr/bin/env node
// Reconcile release objects by exact bytes, never by HEAD size or S3 ETag.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseIdentity } from './release-identity.mjs';

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export function options(args) {
  const result = { files: [] };
  for (let i = 0; i < args.length; i++) {
    if (['--bucket', '--prefix', '--endpoint-url', '--region', '--checksums'].includes(args[i])) {
      result[args[i].slice(2)] = args[++i];
    } else if (args[i]?.startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
    else result.files.push(args[i]);
  }
  if (!result.bucket || !result.prefix || !result['endpoint-url'] || !result.region || !result.checksums || !result.files.length) {
    throw new Error('Bucket, prefix, endpoint, region, checksums, and payloads required');
  }
  if (new Set(result.files.map((file) => path.basename(file))).size !== result.files.length) {
    throw new Error('Duplicate payload name');
  }
  return result;
}

function awsArgs(opts) {
  return ['--endpoint-url', opts['endpoint-url'], '--region', opts.region];
}

async function run(args, hashOutput = false) {
  const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const hash = createHash('sha256');
  let size = 0;
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk) => {
    if (hashOutput) { hash.update(chunk); size += chunk.length; }
    else output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => { error = (error + chunk.toString()).slice(-4096); });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output, error, size, digest: hashOutput ? `sha256:${hash.digest('hex')}` : undefined };
}

export function objectState(contents, key, expected) {
  if (!Array.isArray(contents)) throw new Error('Object listing unavailable');
  const exact = contents.filter((entry) => entry.Key === key);
  if (exact.length > 1) throw new Error(`Duplicate object listing: ${key}`);
  if (!exact.length) return 'missing';
  if (exact[0].Size !== expected.size) throw new Error(`Immutable object size mismatch: ${key}`);
  return 'present';
}

async function inspect(opts, asset) {
  const key = `${opts.prefix.replace(/\/$/, '')}/${asset.name}`;
  const listed = await run(['s3api', 'list-objects-v2', '--bucket', opts.bucket, '--prefix', key,
    '--output', 'json', ...awsArgs(opts)]);
  if (listed.code !== 0) throw new Error(`Cannot list immutable object ${key}: ${listed.error}`);
  const listing = JSON.parse(listed.output);
  if (listing.IsTruncated !== false || !Number.isSafeInteger(listing.KeyCount) ||
      !Array.isArray(listing.Contents) && listing.KeyCount !== 0) {
    throw new Error(`Incomplete immutable object listing: ${key}`);
  }
  const state = objectState(listing.Contents ?? [], key, asset);
  if (state === 'missing') return { key, state };
  const read = await run(['s3', 'cp', `s3://${opts.bucket}/${key}`, '-', '--no-progress', ...awsArgs(opts)], true);
  if (read.code !== 0 || read.size !== asset.size || read.digest !== asset.digest) {
    throw new Error(`Immutable object digest/custody mismatch: ${key}`);
  }
  return { key, state: 'matching' };
}

export async function main(args) {
  const opts = options(args);
  const directory = path.dirname(path.resolve(opts.checksums));
  const identity = await releaseIdentity(directory);
  const items = opts.files.map((file) => {
    const absolute = path.resolve(file);
    const asset = identity.get(path.basename(absolute));
    if (!asset || asset.file !== absolute ||
        (process.env.RELEASE_VERSION && (!asset.name.startsWith('Interpreter-') ||
          !asset.name.includes(`-${process.env.RELEASE_VERSION}.`)))) {
      throw new Error(`Unverified immutable payload: ${file}`);
    }
    return asset;
  });
  // Preflight every key before any PUT. A conflict anywhere prevents all writes.
  const states = [];
  for (const asset of items) states.push(await inspect(opts, asset));
  for (let index = 0; index < items.length; index++) {
    if (states[index].state === 'matching') continue;
    const asset = items[index];
    const target = `s3://${opts.bucket}/${states[index].key}`;
    let matched = false;
    for (let attempt = 1; attempt <= 4 && !matched; attempt++) {
      const upload = await run(['s3', 'cp', asset.file, target, '--no-progress', ...awsArgs(opts)]);
      // A timeout can occur after the server has committed the bytes. Always
      // inspect again before deciding whether a retry is required.
      const state = await inspect(opts, asset);
      matched = state.state === 'matching';
      if (!matched && upload.code === 0) throw new Error(`Upload returned success without object: ${target}`);
      if (!matched && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
    if (!matched) throw new Error(`Missing immutable object after retries: ${target}`);
  }
  // A race or external mutation after a successful PUT must also fail closed.
  for (const asset of items) await inspect(opts, asset);
  console.log(`Verified ${items.length} exact immutable payloads; uploaded ${states.filter((s) => s.state === 'missing').length} missing`);
}

if (direct) main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
