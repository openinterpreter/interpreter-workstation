#!/usr/bin/env node
// Resume only the mutable distribution pointers of an already published,
// independently verified release. Never touch the release, tag or immutable keys.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChecksums } from './release-identity.mjs';

const repository = 'openinterpreter/interpreter-workstation';
const sourceCommit = 'e07fb1f1db5b1b532286897ba190b0f6d223d526';
const releaseRun = '43068062236';
const version = '0.2.221';
const aliases = new Map([
  ['Interpreter-latest.AppImage', `Interpreter-linux-x86_64-${version}.AppImage`],
  ['Interpreter-linux-amd64.deb', `Interpreter-linux-amd64-${version}.deb`],
  ['Interpreter-x64.exe', `Interpreter-win-x64-${version}.exe`],
  ['Interpreter-arm64.dmg', `Interpreter-arm64-${version}.dmg`],
  ['Interpreter-x64.dmg', `Interpreter-x64-${version}.dmg`],
]);
const manifests = ['latest-linux.yml', 'latest-mac.yml', 'latest.yml'];
const metadata = ['SHA256SUMS', 'RELEASE-MANIFEST.json', ...manifests];

function run(binary, args, { hash = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const digest = createHash('sha256');
    let output = '', stderr = '', size = 0, tooLarge = false;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (hash) digest.update(chunk);
      else if (size <= maxBytes) output += chunk.toString();
      else { tooLarge = true; child.kill(); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1024); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output, size, tooLarge,
      digest: hash ? digest.digest('hex') : undefined, stderr }));
  });
}

async function checked(binary, args) {
  const result = await run(binary, args);
  if (result.code !== 0 || result.tooLarge) throw new Error(`${binary} read failed`);
  return result.output;
}

async function github(apiPath) {
  return JSON.parse(await checked('gh', ['api', `repos/${repository}/${apiPath}`]));
}

async function publishedIdentity() {
  const [latest, release] = await Promise.all([
    github('releases/latest'), github(`releases/tags/v${version}`),
  ]);
  if (latest.id !== release.id || release.draft !== false || release.prerelease !== false ||
      release.tag_name !== `v${version}` || release.target_commitish !== sourceCommit) {
    throw new Error('Published release is not the latest exact source');
  }
  const assets = await github(`releases/${release.id}/assets?per_page=100`);
  if (!Array.isArray(assets) || assets.length !== 19 ||
      new Set(assets.map((asset) => asset.name)).size !== 19 ||
      assets.some((asset) => !/^sha256:[0-9a-f]{64}$/.test(asset.digest) ||
        !Number.isSafeInteger(asset.size) || asset.size < 1)) {
    throw new Error('Incomplete release asset/digest inventory');
  }
  return new Map(assets.map((asset) => [asset.name, asset]));
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function verifyMetadata(files, assets) {
  const checksums = parseChecksums(files.get('SHA256SUMS').toString());
  const manifest = JSON.parse(files.get('RELEASE-MANIFEST.json').toString());
  if (manifest.version !== version || manifest.source?.repository !== repository ||
      manifest.source?.commit !== sourceCommit || manifest.build?.runId !== releaseRun ||
      manifest.runtime?.oixRelease !== 'rust-v0.0.61' ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 17 ||
      checksums.size !== assets.size - 1) throw new Error('Original release provenance mismatch');
  for (const [name, asset] of assets) {
    if (name !== 'SHA256SUMS' && checksums.get(name) !== asset.digest.slice(7))
      throw new Error(`Published checksum mismatch: ${name}`);
  }
  for (const item of manifest.artifacts) {
    const asset = assets.get(item.name);
    if (!asset || asset.size !== item.bytes || asset.digest !== `sha256:${item.sha256}`)
      throw new Error('Published artifact manifest mismatch');
  }
  for (const [name, bytes] of files) {
    const asset = assets.get(name);
    if (!asset || bytes.length !== asset.size || digest(bytes) !== asset.digest.slice(7))
      throw new Error(`Published metadata digest mismatch: ${name}`);
  }
  for (const name of manifests) {
    const body = files.get(name).toString();
    if (!new RegExp(`^version: ['\"]?${version.replaceAll('.', '\\.')}['\"]?$`, 'm').test(body))
      throw new Error(`Updater manifest version mismatch: ${name}`);
  }
  for (const target of aliases.values()) if (!assets.has(target)) throw new Error(`Missing asset: ${target}`);
}

export function updaterVersion(bytes) {
  if (bytes === null) return null;
  const match = /^version: ['\"]?(0\.2\.\d+)['\"]?\s*$/m.exec(bytes.toString());
  if (!match) throw new Error('Unrecognized existing updater manifest');
  if (Number(match[1].split('.')[2]) > 221) throw new Error('Newer updater manifest exists');
  return match[1];
}

export async function reconcilePointers({ verifySource, readTarget, copy, identity, promote, verifyLatest,
  targets = aliases, updater = manifests, retry = 4, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  await verifyLatest();
  // Prove every source and every destination before changing any pointer.
  for (const [alias, source] of targets) await verifySource(source, identity.get(source));
  const states = new Map();
  for (const [alias, source] of targets) states.set(alias, await readTarget(alias, source, identity.get(source)));
  const updaterStates = new Map();
  for (const name of updater) updaterStates.set(name, await readTarget(name));
  for (const [alias, source] of targets) {
    if (states.get(alias) === 'matching') continue;
    for (let attempt = 1; attempt <= retry; attempt++) {
      await verifyLatest();
      if (await readTarget(alias, source, identity.get(source)) === 'matching') break;
      const outcome = await copy(source, alias).catch(() => null);
      const state = await readTarget(alias, source, identity.get(source));
      if (state === 'matching') break; // Includes a committed copy whose response timed out.
      if (outcome?.code === 0) throw new Error(`Copy reported success without matching alias: ${alias}`);
      if (attempt === retry) throw new Error(`Alias unavailable after retries: ${alias}`);
      await pause(attempt * 1000);
    }
  }
  // Recheck all pointers and source bytes before promoting ANY updater.
  await verifyLatest();
  for (const [alias, source] of targets) {
    await verifySource(source, identity.get(source));
    if (await readTarget(alias, source, identity.get(source)) !== 'matching')
      throw new Error(`Alias changed during promotion: ${alias}`);
  }
  for (const name of updater) {
    if (updaterStates.get(name) === 'matching') continue;
    for (let attempt = 1; attempt <= retry; attempt++) {
      await verifyLatest();
      for (const [alias, source] of targets) {
        if (await readTarget(alias, source, identity.get(source)) !== 'matching')
          throw new Error(`Alias changed during updater promotion: ${alias}`);
      }
      if (await readTarget(name) === 'matching') break;
      const outcome = await promote(name).catch(() => null);
      const state = await readTarget(name);
      if (state === 'matching') break;
      if (outcome?.code === 0) throw new Error(`Manifest promotion returned success without matching bytes: ${name}`);
      if (attempt === retry) throw new Error(`Updater unavailable after retries: ${name}`);
      await pause(attempt * 1000);
    }
  }
  await verifyLatest();
  for (const [alias, source] of targets) {
    if (await readTarget(alias, source, identity.get(source)) !== 'matching') throw new Error(`Alias changed: ${alias}`);
  }
  for (const name of updater) {
    if (await readTarget(name) !== 'matching') throw new Error(`Updater changed: ${name}`);
  }
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.RELEASE_RECOVERY_CONFIRM !== 'recover-0.2.221' || !process.env.AWS_ENDPOINT_URL ||
      !process.env.AWS_REGION) throw new Error('Recovery context invalid');
  const assets = await publishedIdentity();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-221-recovery-'));
  try {
    const files = new Map();
    for (const name of metadata) {
      await checked('gh', ['release', 'download', `v${version}`, '-R', repository,
        '--pattern', name, '--dir', temporary]);
      files.set(name, await readFile(path.join(temporary, name)));
    }
    verifyMetadata(files, assets);
    const aws = ['--endpoint-url', process.env.AWS_ENDPOINT_URL, '--region', process.env.AWS_REGION];
    const object = (name) => `s3://workstationupdater/releases/${name}`;
    const remote = (name) => run('aws', ['s3', 'cp', object(name), '-', '--no-progress', ...aws], { hash: true });
    const hashRemote = async (name) => {
      const result = await remote(name);
      if (result.code !== 0) throw new Error(`Cannot digest object: ${name}`);
      return result;
    };
    const verifyLatest = async () => {
      const latest = await github('releases/latest');
      if (latest.tag_name !== `v${version}` || latest.target_commitish !== sourceCommit ||
          latest.draft !== false) throw new Error('A different release became latest');
    };
    const previous = await github('releases/tags/v0.2.215');
    if (previous.draft !== false || previous.prerelease !== false) throw new Error('Predecessor unavailable');
    const previousAssets = await github(`releases/${previous.id}/assets?per_page=100`);
    if (!Array.isArray(previousAssets) || previousAssets.length !== 19 ||
        new Set(previousAssets.map((item) => item.name)).size !== 19) throw new Error('Incomplete predecessor inventory');
    const oldAssets = new Map(previousAssets.map((item) => [item.name, item]));
    const verifySource = async (name, asset) => {
      const result = await hashRemote(name);
      if (result.size !== asset?.size || result.digest !== asset.digest.slice(7))
        throw new Error(`Immutable source object mismatch: ${name}`);
    };
    const readTarget = async (name, source, asset) => {
      // A missing or unknown target is never proof of an old, safe alias.
      const result = source ? await remote(name) : await run('aws',
        ['s3', 'cp', object(name), '-', '--no-progress', ...aws]);
      if (result.code !== 0) throw new Error(`Destination read unavailable: ${name}`);
      if (source) {
        if (result.size === asset.size && result.digest === asset.digest.slice(7)) return 'matching';
        // Existing aliases must be recognizable as the last published updater's
        // predecessor, never arbitrary conflicting bytes.
        const oldName = source.replace(`-${version}.`, '-0.2.215.');
        const old = oldAssets.get(oldName);
        if (!old || old.size !== result.size || old.digest !== `sha256:${result.digest}`)
          throw new Error(`Unrecognized existing alias: ${name}`);
        return 'old';
      }
      if (result.tooLarge) throw new Error(`Updater oversized: ${name}`);
      const observed = updaterVersion(Buffer.from(result.output));
      const actual = `sha256:${digest(result.output)}`;
      if (result.size === files.get(name).length && actual === assets.get(name).digest) return 'matching';
      const old = oldAssets.get(name);
      if (observed !== '0.2.215' || !old || old.size !== result.size || old.digest !== actual)
        throw new Error(`Unrecognized existing updater: ${name}`);
      return 'old';
    };
    // Small manifests need their version read separately: hash-only streams do
    // not retain body. Reject unrecognized or newer pointers before alias PUTs.
    for (const name of manifests) {
      const result = await run('aws', ['s3', 'cp', object(name), '-', '--no-progress', ...aws]);
      if (result.code !== 0 || result.tooLarge) throw new Error(`Updater unreadable: ${name}`);
      updaterVersion(Buffer.from(result.output));
    }
    for (const name of ['RELEASE-MANIFEST.json', 'SHA256SUMS']) {
      const result = await hashRemote(name);
      if (result.size !== files.get(name).length || result.digest !== digest(files.get(name)))
        throw new Error(`Current release metadata mismatch: ${name}`);
    }
    await reconcilePointers({ verifySource, readTarget,
      copy: (source, target) => run('aws', ['s3', 'cp', object(source), object(target), '--no-progress', ...aws]),
      promote: (name) => run('aws', ['s3', 'cp', path.join(temporary, name), object(name), '--no-progress', ...aws]),
      identity: assets, verifyLatest });
    console.log(`Verified five aliases and three updater manifests for v${version}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
