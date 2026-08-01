#!/usr/bin/env node
/**
 * Build script with file locking to prevent concurrent builds.
 * Multiple `pnpm dev` instances can run simultaneously - the second one
 * will wait for the first build to complete.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.join(__dirname, '..', '.build-lock');
const LOCK_TIMEOUT = 120000; // 2 minutes max wait
const POLL_INTERVAL = 500;

function acquireLock() {
  try {
    // O_EXCL makes this atomic - fails if file exists
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      return false;
    }
    throw e;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    // Ignore - might already be deleted
  }
}

// Clean up lock on Ctrl+C or termination
let hasLock = false;
function cleanup() {
  if (hasLock) {
    releaseLock();
  }
  process.exit(1);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

function isLockStale() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    // If lock is older than 2 minutes, it's stale (build crashed)
    return Date.now() - stat.mtimeMs > LOCK_TIMEOUT;
  } catch (e) {
    return true; // File doesn't exist
  }
}

async function waitForLock() {
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT) {
    if (isLockStale()) {
      // Remove stale lock
      releaseLock();
    }

    if (acquireLock()) {
      return true;
    }

    // Wait and retry
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    process.stdout.write('.');
  }

  throw new Error('Timeout waiting for build lock');
}

async function main() {
  const buildScript = process.argv.includes('--dev') ? 'build:dev-prep' : 'build';
  const alreadyHadLock = fs.existsSync(LOCK_FILE) && !isLockStale();

  if (alreadyHadLock) {
    console.log('Another build is in progress, waiting...');
  }

  await waitForLock();
  hasLock = true;

  if (alreadyHadLock) {
    console.log('\nBuild completed by other process, continuing...');
    releaseLock();
    hasLock = false;
    return;
  }

  try {
    console.log(`Building with ${buildScript}...`);
    execSync(`pnpm run ${buildScript}`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
    });
  } finally {
    releaseLock();
    hasLock = false;
  }
}

main().catch(e => {
  console.error(e.message);
  releaseLock();
  hasLock = false;
  process.exit(1);
});
