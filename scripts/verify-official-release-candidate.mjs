#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(root, 'dist');
const appBundle = path.join(distRoot, 'mac-arm64', 'Interpreter.app');
const resources = path.join(appBundle, 'Contents', 'Resources');
const appAsar = path.join(resources, 'app.asar');
const requireFromApp = createRequire(path.join(root, 'package.json'));
const { extractFile } = requireFromApp('@electron/asar');

function requireFile(filePath, description, minimumBytes = 1) {
  if (!existsSync(filePath)) throw new Error(`Missing ${description}: ${filePath}`);
  if (statSync(filePath).size < minimumBytes) {
    throw new Error(`${description} is unexpectedly small: ${filePath}`);
  }
}

requireFile(appAsar, 'packaged application archive', 1024);
const product = JSON.parse(extractFile(appAsar, 'product.json').toString('utf8'));
if (product.nameLong !== 'Interpreter' || product.darwinBundleIdentifier !== 'com.openinterpreter.interpreter') {
  throw new Error('Release candidate does not use the public Interpreter product identity');
}
if (product.distribution?.id !== 'official') {
  throw new Error(`Expected official distribution, got ${product.distribution?.id ?? 'missing'}`);
}
if (product.distribution?.auth?.provider !== 'supabase') {
  throw new Error('Release candidate is missing the official hosted authentication provider');
}
if (product.distribution?.hostedApiBaseUrl !== 'https://oi-new-api.fly.dev') {
  throw new Error(`Unexpected hosted API endpoint: ${product.distribution?.hostedApiBaseUrl ?? 'missing'}`);
}

for (const relativePath of [
  'licenses/NOTICE',
  'licenses/THIRD_PARTY_NOTICES.md',
  'licenses/sharp-libvips-v1.2.4-THIRD-PARTY-NOTICES.md',
  'licenses/sharp-libvips-v1.3.2-THIRD-PARTY-NOTICES.md',
  'licenses/release-policy.json',
  'licenses/LGPL-3.0.txt',
  'licenses/GPL-3.0.txt',
  'oix/bin/interpreter',
  'oix/bin/i',
  'cua-driver/cua-driver',
]) {
  requireFile(path.join(resources, relativePath), `packaged resource ${relativePath}`);
}

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!version) throw new Error('Could not resolve public version');

const distributables = ['.dmg', '.zip'].map((extension) => {
  const matches = readdirSync(distRoot)
    .filter((name) => name.endsWith(extension) && name.startsWith('Interpreter-'));
  if (matches.length !== 1) {
    throw new Error(`Expected one public Interpreter ${extension} artifact, found ${matches.length}`);
  }
  const artifactPath = path.join(distRoot, matches[0]);
  requireFile(artifactPath, `${extension} release artifact`, 1024 * 1024);
  return artifactPath;
});

console.log(
  `[official-release-candidate] verified official distribution ${version}: ${distributables.map((item) => path.basename(item)).join(', ')}`,
);
