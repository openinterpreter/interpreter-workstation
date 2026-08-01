import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSocketIfPresent } from './interpreterCliSocketServer';

// Regression coverage for the CLI socket startup crash (#1433 / #1432):
// "ENOTDIR: not a directory, scandir '/tmp/interpreter-cli-server-<port>.sock'".
// rmSync routes through rimraf (lstat -> rmdir -> readdir); under concurrent startup
// on the shared fixed socket path that multi-syscall window can readdir a node that is
// no longer a directory, throwing ENOTDIR. unlinkSocketIfPresent removes the socket node
// in a single unlink() syscall, eliminating that window.
describe('unlinkSocketIfPresent', () => {
  test('removes an existing unix socket node without throwing', async () => {
    if (process.platform === 'win32') {
      return; // unix domain sockets are POSIX-only; the socket server early-returns on win32
    }
    const socketPath = path.join(tmpdir(), `iws-sock-test-${process.pid}.sock`);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    expect(existsSync(socketPath)).toBe(true);
    try {
      unlinkSocketIfPresent(socketPath);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('tolerates a missing path (already removed)', () => {
    const missing = path.join(tmpdir(), `iws-sock-missing-${process.pid}.sock`);
    expect(() => unlinkSocketIfPresent(missing)).not.toThrow();
  });

  test('rethrows non-ENOENT errors instead of masking them', () => {
    const dir = path.join(tmpdir(), `iws-sock-dir-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      // A directory cannot be unlinked (EPERM/EISDIR); that must surface, not be swallowed.
      expect(() => unlinkSocketIfPresent(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
