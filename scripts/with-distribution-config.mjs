import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function mergeObjects(base, overlay) {
  if (Array.isArray(base) || Array.isArray(overlay)) {
    return overlay;
  }
  if (!base || typeof base !== 'object' || !overlay || typeof overlay !== 'object') {
    return overlay;
  }

  return Object.fromEntries(
    Array.from(new Set([...Object.keys(base), ...Object.keys(overlay)])).map((key) => [
      key,
      key in overlay ? mergeObjects(base[key], overlay[key]) : base[key],
    ]),
  );
}

const separatorIndex = process.argv.indexOf('--');
if (separatorIndex < 3 || separatorIndex === process.argv.length - 1) {
  throw new Error('Usage: node scripts/with-distribution-config.mjs <overlay.json> -- <command> [args...]');
}

const overlayPath = path.resolve(process.argv[2]);
const command = process.argv[separatorIndex + 1];
const commandArgs = process.argv.slice(separatorIndex + 2);
const productPath = path.resolve('product.json');
const lockPath = path.resolve('.distribution-build.lock');
const originalProduct = fs.readFileSync(productPath, 'utf8');
const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
const merged = mergeObjects(JSON.parse(originalProduct), overlay);

let lockHandle;
try {
  lockHandle = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(productPath, `${JSON.stringify(merged, null, 2)}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      INTERPRETER_DISTRIBUTION_ID: merged.distribution?.id ?? 'custom',
    },
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  fs.writeFileSync(productPath, originalProduct);
  if (lockHandle !== undefined) {
    fs.closeSync(lockHandle);
  }
  fs.rmSync(lockPath, { force: true });
}
