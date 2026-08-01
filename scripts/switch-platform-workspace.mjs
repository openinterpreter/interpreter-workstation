#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STATE_ROOT = path.join(ROOT, '.platform-workspace');
const STATE_FILE = path.join(STATE_ROOT, 'state.json');
const UNKNOWN_STATE_ROOT = path.join(STATE_ROOT, '_unknown');
const PLATFORM_LABELS = ['mac', 'windows', 'linux'];
const MANAGED_PATHS = [
  'node_modules',
  'dist',
  'dist-electron',
  '.cache',
  path.join('submodules', 'interpreter-cua', 'libs', 'cua-driver', 'rust', 'target'),
];

function detectPlatformLabel() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`Unsupported host platform for workspace switching: ${process.platform}`);
}

function usage() {
  console.log('Usage: node scripts/switch-platform-workspace.mjs <status|mac|windows|linux>');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isPlatformLabel(value) {
  return PLATFORM_LABELS.includes(value);
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { active: null };
  }

  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.active !== 'string' || parsed.active.trim().length === 0) {
    throw new Error(`Invalid workspace state file: ${STATE_FILE}`);
  }

  const active = parsed.active.trim();
  if (!isPlatformLabel(active)) {
    throw new Error(`Invalid active workspace platform in ${STATE_FILE}: ${active}`);
  }

  return { active };
}

function writeState(active) {
  if (!isPlatformLabel(active)) {
    throw new Error(`Invalid workspace platform label: ${active}`);
  }
  ensureDir(STATE_ROOT);
  fs.writeFileSync(STATE_FILE, `${JSON.stringify({ active }, null, 2)}\n`);
}

function canonicalPath(relativePath) {
  return path.join(ROOT, relativePath);
}

function storedPath(platformLabel, relativePath) {
  return path.join(STATE_ROOT, platformLabel, relativePath);
}

function unknownPath(relativePath) {
  return path.join(UNKNOWN_STATE_ROOT, relativePath);
}

function movePath(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  if (fs.existsSync(destinationPath)) {
    throw new Error(`Refusing to overwrite existing path: ${destinationPath}`);
  }

  ensureDir(path.dirname(destinationPath));
  fs.renameSync(sourcePath, destinationPath);
  return true;
}

function summarizePath(relativePath, activeLabel) {
  const canonical = canonicalPath(relativePath);
  if (fs.existsSync(canonical)) {
    return `${relativePath}: active (${activeLabel})`;
  }

  const owners = [];
  for (const platformLabel of ['mac', 'windows', 'linux']) {
    if (fs.existsSync(storedPath(platformLabel, relativePath))) {
      owners.push(platformLabel);
    }
  }
  if (fs.existsSync(unknownPath(relativePath))) {
    owners.push('unknown-prior-state');
  }

  if (owners.length === 0) {
    return `${relativePath}: empty`;
  }

  return `${relativePath}: stored for ${owners.join(', ')}`;
}

function printStatus() {
  const hostLabel = detectPlatformLabel();
  const state = readState();
  const activeLabel = state.active ?? 'unknown';
  console.log(`host=${hostLabel}`);
  console.log(`active=${activeLabel}`);
  for (const relativePath of MANAGED_PATHS) {
    console.log(summarizePath(relativePath, activeLabel));
  }
}

function switchWorkspace(targetLabel) {
  const state = readState();
  const activeLabel = state.active;

  if (activeLabel !== null && targetLabel === activeLabel) {
    let restoredAny = false;
    for (const relativePath of MANAGED_PATHS) {
      const canonical = canonicalPath(relativePath);
      const targetStored = storedPath(targetLabel, relativePath);
      if (!fs.existsSync(canonical) && fs.existsSync(targetStored)) {
        movePath(targetStored, canonical);
        restoredAny = true;
      }
    }
    writeState(targetLabel);
    console.log(restoredAny
      ? `Restored stored ${targetLabel} workspace state into canonical paths.`
      : `Workspace already active for ${targetLabel}.`);
    return;
  }

  if (activeLabel === null) {
    const quarantined = [];
    const restored = [];
    for (const relativePath of MANAGED_PATHS) {
      const canonical = canonicalPath(relativePath);
      const targetStored = storedPath(targetLabel, relativePath);

      if (movePath(canonical, unknownPath(relativePath))) {
        quarantined.push(relativePath);
      }
      if (movePath(targetStored, canonical)) {
        restored.push(relativePath);
      }
    }

    writeState(targetLabel);
    console.log(`Initialized workspace state for ${targetLabel} from unknown prior ownership.`);
    console.log(`Quarantined canonical state: ${quarantined.length > 0 ? quarantined.join(', ') : '(none)'}`);
    console.log(`Restored: ${restored.length > 0 ? restored.join(', ') : '(none)'}`);
    return;
  }

  const movedOut = [];
  const restored = [];
  for (const relativePath of MANAGED_PATHS) {
    const canonical = canonicalPath(relativePath);
    const activeStored = storedPath(activeLabel, relativePath);
    const targetStored = storedPath(targetLabel, relativePath);

    if (movePath(canonical, activeStored)) {
      movedOut.push(relativePath);
    }
    if (movePath(targetStored, canonical)) {
      restored.push(relativePath);
    }
  }

  writeState(targetLabel);
  console.log(`Switched workspace from ${activeLabel} to ${targetLabel}.`);
  console.log(`Moved out: ${movedOut.length > 0 ? movedOut.join(', ') : '(none)'}`);
  console.log(`Restored: ${restored.length > 0 ? restored.join(', ') : '(none)'}`);
}

const command = process.argv[2];
if (!command) {
  usage();
  process.exit(1);
}

if (command === 'status') {
  printStatus();
  process.exit(0);
}

if (!isPlatformLabel(command)) {
  usage();
  process.exit(1);
}

switchWorkspace(command);
