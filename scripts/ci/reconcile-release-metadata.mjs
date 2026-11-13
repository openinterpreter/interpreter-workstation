#!/usr/bin/env node
// Preserve the first assembled release bytes across a failed publish-job retry.
// Rebuilt SBOM metadata can vary even when the platform artifacts do not.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseIdentity } from './release-identity.mjs';

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const name = 'official-release-metadata';
const files = ['SBOM.spdx.json', 'RELEASE-MANIFEST.json', 'SHA256SUMS'];

export function snapshotId(artifacts, runId) {
  if (!Array.isArray(artifacts)) throw new Error('Release metadata artifact listing unavailable');
  const matches = artifacts.filter((item) => item.name === name);
  if (matches.length > 1) throw new Error('Duplicate release metadata snapshot');
  if (!matches.length) return null;
  const item = matches[0];
  if (!Number.isSafeInteger(item.id) || item.id < 1 || item.expired !== false ||
      String(item.workflow_run?.id) !== runId) throw new Error('Release metadata snapshot custody mismatch');
  return item.id;
}

export async function verifyRestored(directory, runId, repository, commit, version) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'RELEASE-MANIFEST.json'), 'utf8'));
  if (manifest.version !== version || manifest.source?.repository !== repository ||
      manifest.source?.commit !== commit || manifest.build?.runId !== runId) {
    throw new Error('Release metadata snapshot source identity mismatch');
  }
  await releaseIdentity(directory); // Every current installer and metadata byte must match the original checksums.
}

async function main(directory) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_SHA: commit,
    RELEASE_VERSION: version, GITHUB_OUTPUT: output } = process.env;
  if (!/^openinterpreter\/interpreter-workstation$/.test(repo ?? '') ||
      !/^\d+$/.test(runId ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '') ||
      !/^0\.2\.\d+$/.test(version ?? '') || !output) throw new Error('Exact release context required');
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const listing = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`]));
  if (!Number.isSafeInteger(listing.total_count) || listing.total_count > 100) {
    throw new Error('Incomplete release metadata artifact listing');
  }
  const id = snapshotId(listing.artifacts, runId);
  if (id) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-metadata-'));
    try {
      gh(['run', 'download', runId, '-n', name, '-D', temporary, '-R', repo]);
      for (const file of files) await copyFile(path.join(temporary, file), path.join(directory, file));
      await verifyRestored(directory, runId, repo, commit, version);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    await writeFile(output, 'created=false\n', { flag: 'a' });
    console.log(`Verified exact first-attempt release metadata from artifact ${id}`);
  } else {
    execFileSync(process.execPath, [fileURLToPath(new URL('./write-release-metadata.mjs', import.meta.url)), directory],
      { stdio: 'inherit' });
    await verifyRestored(directory, runId, repo, commit, version);
    await writeFile(output, 'created=true\n', { flag: 'a' });
    console.log('Created exact release metadata snapshot for this run');
  }
}

if (direct) main(path.resolve(process.argv[2] ?? 'release')).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
