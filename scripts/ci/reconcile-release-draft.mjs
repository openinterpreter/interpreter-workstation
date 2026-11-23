#!/usr/bin/env node
// A release draft is immutable by identity: only absent assets may be added.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile, releaseIdentity } from './release-identity.mjs';

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function findDraft(releases, tag, commit) {
  const found = releases.filter((release) => release.tag_name === tag);
  if (found.length > 1) throw new Error(`Duplicate release identity: ${tag}`);
  if (!found.length) return null;
  const release = found[0];
  if (!release.draft || release.target_commitish !== commit) {
    throw new Error(`Release tag ${tag} is published or belongs to another commit`);
  }
  return release;
}

export function draftPlan(expected, release) {
  const assets = new Map();
  for (const asset of release.assets ?? []) {
    if (assets.has(asset.name) || !expected.has(asset.name)) {
      throw new Error(`Unexpected or duplicate draft asset: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  return [...expected.values()].filter((item) => reconcile(item, assets.get(item.name), item.name) === 'missing');
}

// GitHub can accept draft creation before its release list reflects the draft.
// Never create it again on an absent read; only re-observe the exact identity.
export async function observeCreatedDraft(readReleases, tag, commit, {
  attempts = 8, intervalMs = 1500, wait = sleep,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const draft = findDraft(readReleases(), tag, commit);
    if (draft) return draft;
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  throw new Error(`Created release draft was not observable after ${attempts} bounded reads`);
}

function releases(repo) {
  // GitHub's /releases/tags endpoint omits draft releases. Paginate the
  // authenticated release list instead; a failed read must never look absent.
  const output = gh(['api', `repos/${repo}/releases?per_page=100`, '--paginate',
    '--jq', '.[] | {tag_name,draft,target_commitish,assets:[.assets[] | {name,size,digest}]} | @json']);
  return output ? output.split('\n').map((line) => JSON.parse(line)) : [];
}

export async function main(directory) {
  const repo = process.env.GITHUB_REPOSITORY;
  const commit = process.env.GITHUB_SHA;
  const tag = process.env.RELEASE_TAG;
  const version = process.env.RELEASE_VERSION;
  if (!repo || !commit || !/^v0\.2\.\d+$/.test(tag ?? '') || tag !== `v${version}` || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Exact release repository, tag, version, and source SHA required');
  }
  const expected = await releaseIdentity(directory);
  const manifest = JSON.parse(await readFile(path.join(directory, 'RELEASE-MANIFEST.json'), 'utf8'));
  if (manifest.version !== version || manifest.source?.repository !== repo || manifest.source?.commit !== commit ||
      manifest.build?.runId !== process.env.GITHUB_RUN_ID) {
    throw new Error('Release manifest does not bind this source and run');
  }
  let draft = findDraft(releases(repo), tag, commit);
  if (!draft) {
    gh(['release', 'create', tag, '--repo', repo, '--target', commit,
      '--title', `Interpreter Workstation v${version}`, '--notes-file', path.join(directory, 'RELEASE_NOTES.md'), '--draft']);
    draft = await observeCreatedDraft(() => releases(repo), tag, commit);
  }
  // Check *all* existing assets before adding any missing one.
  const missing = draftPlan(expected, draft);
  for (const asset of missing) {
    gh(['release', 'upload', tag, asset.file, '--repo', repo]); // Never --clobber.
    const current = findDraft(releases(repo), tag, commit);
    if (!current) throw new Error('Draft disappeared during upload');
    draftPlan(expected, current); // Fail closed on changed custody.
    const uploaded = current.assets.find((entry) => entry.name === asset.name);
    reconcile(asset, uploaded, asset.name);
    if (!uploaded) throw new Error(`Uploaded draft asset is absent: ${asset.name}`);
  }
  draft = findDraft(releases(repo), tag, commit);
  if (!draft || draftPlan(expected, draft).length) throw new Error('Incomplete release draft');
  console.log(`Verified ${expected.size} exact draft assets for ${tag}`);
}

if (direct) main(path.resolve(process.argv[2] ?? 'release')).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
