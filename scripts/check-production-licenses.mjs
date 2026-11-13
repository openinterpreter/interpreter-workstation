#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInventoryPath } from './release-license-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(root, 'licenses', 'release-policy.json');
const inventoryPath = resolveInventoryPath(process.argv.slice(2));

function readInventory() {
  if (inventoryPath) {
    return JSON.parse(readFileSync(inventoryPath, 'utf8'));
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const output = execFileSync(pnpm, ['licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function wildcardMatches(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function flattenInventory(inventory) {
  return Object.entries(inventory).flatMap(([inventoryLicense, packages]) => {
    if (!Array.isArray(packages)) {
      throw new Error(`License inventory group ${inventoryLicense} is not an array`);
    }
    return packages.flatMap((entry) => {
      if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
        throw new Error(`License inventory entry ${entry.name} has no versions`);
      }
      return entry.versions.map((version) => ({
        package: entry.name,
        version,
        inventoryLicense,
      }));
    });
  });
}

function readRelayLibvipsPackages(runtimeName = 'browser-extension-relay') {
  const scopeDir = path.join(root, 'resources', runtimeName, 'node_modules', '@img');
  if (!existsSync(scopeDir)) return [];

  return readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('sharp-libvips-'))
    .map((entry) => {
      const manifestPath = path.join(scopeDir, entry.name, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return {
        package: manifest.name,
        version: manifest.version,
        inventoryLicense: manifest.license,
      };
    });
}

const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const entries = flattenInventory(readInventory());
const relayLibvipsEntries = [
  ...readRelayLibvipsPackages(),
  ...readRelayLibvipsPackages('simple-interface-runtime'),
];
const failures = [];

for (const noticeFile of policy.noticeFiles) {
  if (!existsSync(path.join(root, noticeFile))) {
    failures.push(`missing required notice file: ${noticeFile}`);
  }
}

for (const decision of policy.decisions) {
  const match = entries.find(
    (entry) => entry.package === decision.package && entry.version === decision.version,
  );
  if (!match) {
    failures.push(`reviewed package is absent from inventory: ${decision.package}@${decision.version}`);
    continue;
  }
  if (match.inventoryLicense !== decision.inventoryLicense) {
    failures.push(
      `${decision.package}@${decision.version} license drifted from ${decision.inventoryLicense} to ${match.inventoryLicense}`,
    );
  }
  if (!existsSync(path.join(root, decision.notice))) {
    failures.push(`missing selected-license notice for ${decision.package}: ${decision.notice}`);
  }
}

const manuallyReviewed = new Set(
  policy.decisions.map((decision) => `${decision.package}@${decision.version}`),
);
for (const entry of entries.filter((item) => item.inventoryLicense === 'Unknown')) {
  if (!manuallyReviewed.has(`${entry.package}@${entry.version}`)) {
    failures.push(`unreviewed Unknown license: ${entry.package}@${entry.version}`);
  }
}

for (const entry of entries.filter(
  (item) => /GPL/i.test(item.inventoryLicense) && !/LGPL/i.test(item.inventoryLicense),
)) {
  const decision = policy.decisions.find(
    (item) => item.package === entry.package && item.version === entry.version,
  );
  if (!decision || /GPL/i.test(decision.selectedLicense)) {
    failures.push(
      `GPL-containing license expression has no recorded permissive selection: ${entry.package}@${entry.version} (${entry.inventoryLicense})`,
    );
  }
}

for (const entry of entries.filter((item) => /LGPL/i.test(item.inventoryLicense))) {
  const family = policy.licenseFamilies.find(
    (item) => wildcardMatches(item.packagePattern, entry.package) && item.version === entry.version,
  );
  if (!family) {
    failures.push(
      `LGPL package has no release-family policy: ${entry.package}@${entry.version} (${entry.inventoryLicense})`,
    );
    continue;
  }
  if (entry.inventoryLicense !== family.inventoryLicense) {
    failures.push(
      `${entry.package}@${entry.version} license drifted from ${family.inventoryLicense} to ${entry.inventoryLicense}`,
    );
  }
  for (const required of [family.notice, family.licenseText, family.incorporatedLicenseText]) {
    if (!existsSync(path.join(root, required))) {
      failures.push(`missing LGPL compliance file for ${entry.package}: ${required}`);
    }
  }
}

for (const entry of relayLibvipsEntries) {
  const family = policy.licenseFamilies.find(
    (item) => wildcardMatches(item.packagePattern, entry.package) && item.version === entry.version,
  );
  if (!family) {
    failures.push(
      `bundled relay LGPL package has no release-family policy: ${entry.package}@${entry.version}`,
    );
    continue;
  }
  if (entry.inventoryLicense !== family.inventoryLicense) {
    failures.push(
      `bundled relay ${entry.package}@${entry.version} license drifted from ${family.inventoryLicense} to ${entry.inventoryLicense}`,
    );
  }
  for (const required of [family.notice, family.licenseText, family.incorporatedLicenseText]) {
    if (!existsSync(path.join(root, required))) {
      failures.push(`missing bundled relay LGPL compliance file for ${entry.package}: ${required}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[release-licenses] policy check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `[release-licenses] policy check passed for ${entries.length} production package versions; ` +
  `${policy.decisions.length} explicit selections/resolutions, ${policy.licenseFamilies.length} LGPL families, ` +
  `${relayLibvipsEntries.length} bundled relay LGPL package(s) reviewed`,
);
