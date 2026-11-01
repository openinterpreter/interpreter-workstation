#!/usr/bin/env node

// Build the platform's complete Simple-mode dependency tree before packaging.
// The installed application copies this tree into each new project; opening a
// project never contacts a package registry.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'resources', 'simple-interface-runtime');
const manifestPath = path.join(runtime, 'runtime-manifest.json');
const packagePath = path.join(runtime, 'package.json');
const lockPath = path.join(runtime, 'pnpm-lock.yaml');
const npmrcPath = path.join(runtime, '.npmrc');
const hash = createHash('sha256');
for (const file of [packagePath, lockPath, npmrcPath]) hash.update(readFileSync(file));
const expected = {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  dependencySha256: hash.digest('hex'),
};
const packages = JSON.parse(readFileSync(packagePath, 'utf8')).dependencies;
const runtimeRequire = createRequire(packagePath);

function nativeCompilerReady() {
  const { getSupportedArchTriples } = runtimeRequire('next/dist/build/swc');
  const triples = getSupportedArchTriples()[process.platform]?.[process.arch] ?? [];
  return triples.some(({ platformArchABI }) => {
    try {
      runtimeRequire(`@next/swc-${platformArchABI}`);
      return true;
    } catch {
      return false;
    }
  });
}

function valid() {
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Object.keys(expected).some((key) => manifest[key] !== expected[key])) return false;
    return Object.entries(packages).every(([name, version]) => {
      const installed = path.join(runtime, 'node_modules', name, 'package.json');
      return existsSync(installed) && JSON.parse(readFileSync(installed, 'utf8')).version === version;
    }) && nativeCompilerReady();
  } catch {
    return false;
  }
}

if (!valid()) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  execFileSync(pnpm, ['install', '--frozen-lockfile', '--prod'], {
    cwd: runtime,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_manage_package_manager_versions: 'false' },
  });
  writeFileSync(manifestPath, `${JSON.stringify(expected, null, 2)}\n`);
  if (!valid()) throw new Error('The bundled Simple interface runtime is incomplete.');
}

console.log(`[simple-interface-runtime] Ready for ${process.platform}-${process.arch}`);
