#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SUBMODULE_PATH = path.join(ROOT, 'submodules', 'interpreter-cua');
const METADATA_OUTPUT_PATH = path.join(ROOT, 'resources', 'cua-driver', 'tool-metadata.json');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: process.env,
  });
}

function runInherited(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

function git(args, options = {}) {
  return run('git', args, options).trim();
}

function gitBuffer(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.stdio ?? 'pipe',
    env: process.env,
  });
}

function requireCleanSubmodule() {
  const status = git(['status', '--porcelain'], { cwd: SUBMODULE_PATH });
  if (status) {
    throw new Error(`submodules/interpreter-cua has local changes. Commit/stash them before updating:\n${status}`);
  }
}

function updateDriverSubtree(before, upstreamRef) {
  try {
    run('git', ['merge-base', '--is-ancestor', upstreamRef, before], { cwd: SUBMODULE_PATH });
    return before;
  } catch {
    // The fork has new upstream work to reconcile.
  }

  const mergeBase = git(['merge-base', before, upstreamRef], { cwd: SUBMODULE_PATH });
  if (!mergeBase) {
    throw new Error(`No merge base between pinned CUA commit ${before} and ${upstreamRef}`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-cua-update-'));
  const forkPatchPath = path.join(temporaryDirectory, 'driver-fork.patch');

  try {
    const forkPatch = gitBuffer(
      ['diff', '--binary', mergeBase, before, '--', 'libs/cua-driver'],
      { cwd: SUBMODULE_PATH },
    );
    fs.writeFileSync(forkPatchPath, forkPatch);

    // Record upstream ancestry without importing unrelated Cua monorepo products.
    // Workstation consumes only libs/cua-driver; its fork-owned CI and policy files
    // stay on the Interpreter side of this boundary.
    runInherited('git', ['merge', '--strategy=ours', '--no-commit', upstreamRef], {
      cwd: SUBMODULE_PATH,
    });
    runInherited('git', ['rm', '-r', '--quiet', '--ignore-unmatch', 'libs/cua-driver'], {
      cwd: SUBMODULE_PATH,
    });
    runInherited('git', ['checkout', upstreamRef, '--', 'libs/cua-driver'], {
      cwd: SUBMODULE_PATH,
    });

    try {
      runInherited('git', ['apply', '--3way', '--index', forkPatchPath], {
        cwd: SUBMODULE_PATH,
      });
    } catch {
      throw new Error(
        'Upstream CUA Driver conflicts with the Interpreter fork delta. Resolve the staged conflicts, verify the fork guards, and commit the merge manually.',
      );
    }

    const upstreamShort = git(['rev-parse', '--short=12', upstreamRef], { cwd: SUBMODULE_PATH });
    runInherited('git', ['commit', '-m', `Merge upstream CUA Driver ${upstreamShort}`], {
      cwd: SUBMODULE_PATH,
    });
    return git(['rev-parse', 'HEAD'], { cwd: SUBMODULE_PATH });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function buildCuaDriver(packagePath) {
  if (process.platform !== 'darwin') {
    throw new Error('trycua:update must run on macOS so the Rust cua-driver binary and metadata match the mac app build.');
  }

  runInherited('cargo', ['build', '--release', '-p', 'cua-driver'], { cwd: packagePath });
  const binaryPath = path.join(packagePath, 'target', 'release', 'cua-driver');
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Rust build did not produce cua-driver at ${binaryPath}`);
  }
  return binaryPath;
}

function main() {
  runInherited('git', ['submodule', 'update', '--init', '--recursive', 'submodules/interpreter-cua']);
  requireCleanSubmodule();

  const before = git(['rev-parse', 'HEAD'], { cwd: SUBMODULE_PATH });
  const upstreamUrl = git(['remote', 'get-url', 'upstream'], { cwd: SUBMODULE_PATH });
  if (upstreamUrl !== 'https://github.com/trycua/cua.git') {
    throw new Error(`submodules/interpreter-cua upstream must be https://github.com/trycua/cua.git, got ${upstreamUrl}`);
  }
  runInherited('git', ['fetch', 'upstream', 'main', '--tags', '--prune'], { cwd: SUBMODULE_PATH });
  const after = updateDriverSubtree(before, 'upstream/main');
  const subject = git(['log', '-1', '--format=%s'], { cwd: SUBMODULE_PATH });

  const binaryPath = buildCuaDriver(path.join(SUBMODULE_PATH, 'libs', 'cua-driver', 'rust'));
  runInherited('node', [
    'scripts/generate-cua-driver-tool-metadata.mjs',
    binaryPath,
    METADATA_OUTPUT_PATH,
  ]);

  const metadata = JSON.parse(fs.readFileSync(METADATA_OUTPUT_PATH, 'utf8'));
  const toolNames = Array.isArray(metadata.tools)
    ? metadata.tools.map((tool) => tool.name).filter(Boolean)
    : [];

  console.log('');
  console.log('[trycua] submodule before:', before);
  console.log('[trycua] submodule after: ', after);
  console.log('[trycua] latest commit:    ', subject);
  console.log('[trycua] metadata:         ', path.relative(ROOT, METADATA_OUTPUT_PATH));
  console.log('[trycua] tools:', toolNames.join(', '));
}

main();
