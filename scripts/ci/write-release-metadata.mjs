#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDirectory = path.resolve(process.argv[2] ?? 'release');
const version = process.env.RELEASE_VERSION;
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;

if (!version || !repository || !commit) {
  throw new Error('RELEASE_VERSION, GITHUB_REPOSITORY, and GITHUB_SHA are required');
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function releaseFiles() {
  return readdirSync(releaseDirectory)
    .filter((name) => !['SHA256SUMS', 'RELEASE-MANIFEST.json'].includes(name))
    .filter((name) => statSync(path.join(releaseDirectory, name)).isFile())
    .sort();
}

function submodules() {
  const output = execFileSync('git', ['submodule', 'status', '--recursive'], {
    cwd: root,
    encoding: 'utf8',
  }).trimEnd();
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const match = line.match(/^(.)([0-9a-f]{40})\s+(\S+)(?:\s+\((.+)\))?$/i);
    if (!match) throw new Error(`Cannot parse submodule status: ${line}`);
    return {
      path: match[3],
      commit: match[2],
      state: match[1] === ' ' ? 'exact' : match[1],
      description: match[4] ?? '',
    };
  });
}

const oixSource = readFileSync(path.join(root, 'scripts/download-oix.mjs'), 'utf8');
const oixMatch = oixSource.match(/PINNED_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!oixMatch) throw new Error('Cannot determine the pinned OIX release');

const artifacts = releaseFiles().map((name) => {
  const filePath = path.join(releaseDirectory, name);
  return {
    name,
    bytes: statSync(filePath).size,
    sha256: sha256(filePath),
  };
});

const manifest = {
  schemaVersion: 1,
  product: 'Interpreter Workstation',
  version,
  source: {
    repository,
    commit,
    ref: process.env.GITHUB_REF ?? '',
  },
  build: {
    workflow: process.env.GITHUB_WORKFLOW ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
    url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '',
  },
  runtime: {
    oixRelease: oixMatch[1],
    submodules: submodules(),
  },
  artifacts,
};

writeFileSync(
  path.join(releaseDirectory, 'RELEASE-MANIFEST.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const checksumFiles = [...releaseFiles(), 'RELEASE-MANIFEST.json'].sort();
const checksums = checksumFiles
  .map((name) => `${sha256(path.join(releaseDirectory, name))}  ${name}`)
  .join('\n');
writeFileSync(path.join(releaseDirectory, 'SHA256SUMS'), `${checksums}\n`);

console.log(`[release-metadata] wrote metadata for ${checksumFiles.length} files`);
