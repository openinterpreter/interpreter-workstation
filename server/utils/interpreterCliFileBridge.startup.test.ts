import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startInterpreterCliFileBridge } from './interpreterCliFileBridge';
import { getInterpreterCliBridgeDir } from './interpreterCliRuntime';

// Regression coverage for #1434: startup crashed with
// "EACCES: permission denied, rmdir '/tmp/interpreter-cli-bridge-<port>/requests'".
// A stale bridge dir left by another uid on a shared /tmp cannot be removed; the
// best-effort pre-clean must not crash startup when the request/response tree already exists.
const PORT = 54_179;

afterEach(() => {
  const dir = getInterpreterCliBridgeDir(PORT);
  try {
    chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('startInterpreterCliFileBridge stale-dir cleanup', () => {
  test('survives an unremovable stale bridge dir (EACCES) instead of crashing', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return; // permission-denial requires a non-root POSIX host
    }
    const bridgeDir = getInterpreterCliBridgeDir(PORT);
    const requestsDir = path.join(bridgeDir, 'requests');
    const responsesDir = path.join(bridgeDir, 'responses');
    mkdirSync(requestsDir, { recursive: true });
    mkdirSync(responsesDir, { recursive: true });
    // Deny removal of the children: rmdir of a child needs write on the parent.
    chmodSync(bridgeDir, 0o500);

    const handle = await startInterpreterCliFileBridge(PORT);
    try {
      expect(existsSync(requestsDir)).toBe(true);
      expect(existsSync(responsesDir)).toBe(true);
    } finally {
      chmodSync(bridgeDir, 0o700); // restore so close()'s own rmSync can run
      await handle.close();
    }
  });
});
