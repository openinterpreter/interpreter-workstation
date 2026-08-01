// Runs in the vitest (Node) lane, not the bun unit lane. Production hosts the
// kernel manager in the Express backend under Node, and bun 1.3.14 on Windows
// stalls child stdout/stderr pipe reads mid-stream (buffered data is only
// released when the pipe closes), which deterministically hangs the
// failed-cell test under `bun test` on Windows CI.
import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeInJsReplKernel,
  resetJsReplKernel,
  shutdownAllJsReplKernelsForTest,
} from './kernelManager';

const cwd = os.tmpdir();

afterAll(() => {
  shutdownAllJsReplKernelsForTest();
});

describe('js_repl kernel manager', () => {
  test('should persist top-level bindings across calls in the same kernel', async () => {
    const key = `test-persist-${Date.now()}`;
    await executeInJsReplKernel({ key, cwd, code: 'let counter = 5;' });
    const result = await executeInJsReplKernel({ key, cwd, code: 'console.log(counter + 1);' });
    expect(result.output).toBe('6');
    resetJsReplKernel(key);
  }, 30_000);

  test('should keep prior bindings available after a failed cell', async () => {
    const key = `test-recover-${Date.now()}`;
    await executeInJsReplKernel({ key, cwd, code: 'let stable = "ok";' });
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'throw new Error("boom");' }),
    ).rejects.toThrow('boom');
    const result = await executeInJsReplKernel({ key, cwd, code: 'console.log(stable);' });
    expect(result.output).toBe('ok');
    resetJsReplKernel(key);
  }, 30_000);

  test('should save emitted images to disk and report their paths', async () => {
    const key = `test-image-${Date.now()}`;
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const result = await executeInJsReplKernel({
      key,
      cwd,
      code: `await interpreter.emitImage("data:image/png;base64,${onePixelPng}"); console.log("emitted");`,
    });
    expect(result.output).toBe('emitted');
    expect(result.imagePaths).toHaveLength(1);
    const saved = fs.readFileSync(result.imagePaths[0]);
    expect(saved.equals(Buffer.from(onePixelPng, 'base64'))).toBe(true);
    fs.rmSync(result.imagePaths[0], { force: true });
    resetJsReplKernel(key);
  }, 30_000);

  test('should clear bindings when the kernel is reset', async () => {
    const key = `test-reset-${Date.now()}`;
    await executeInJsReplKernel({ key, cwd, code: 'let gone = 1;' });
    expect(resetJsReplKernel(key)).toBe(true);
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'console.log(gone);' }),
    ).rejects.toThrow('gone is not defined');
    resetJsReplKernel(key);
  }, 30_000);

  test('should keep the kernel and prior bindings when an exec times out', async () => {
    const key = `test-timeout-${Date.now()}`;
    await executeInJsReplKernel({ key, cwd, code: 'let kept = "still here";' });
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'await new Promise(() => {});', timeoutMs: 500 }),
    ).rejects.toThrow('timed out after 500ms');
    const result = await executeInJsReplKernel({ key, cwd, code: 'console.log(kept);' });
    expect(result.output).toBe('still here');
    resetJsReplKernel(key);
  }, 30_000);

  test('should let a timed-out cell finish its async work in the background', async () => {
    const key = `test-timeout-bg-${Date.now()}`;
    await expect(
      executeInJsReplKernel({
        key,
        cwd,
        code: 'globalThis.late = "pending"; setTimeout(() => { globalThis.late = "done"; }, 1_000); await new Promise(() => {});',
        timeoutMs: 300,
      }),
    ).rejects.toThrow('timed out');
    const output = await vi.waitFor(async () => {
      const result = await executeInJsReplKernel({ key, cwd, code: 'console.log(globalThis.late);' });
      expect(result.output).toBe('done');
      return result.output;
    }, { timeout: 10_000, interval: 200 });
    expect(output).toBe('done');
    resetJsReplKernel(key);
  }, 30_000);

  test('should survive a timed-out cell that settles late and keep capturing output', async () => {
    const key = `test-timeout-late-settle-${Date.now()}`;
    // The abandoned cell rejects 1s after the soft timeout; the race keeps
    // observing it, so the late rejection must not crash the kernel, and its
    // console restore must not steal the next cell's capture.
    await expect(
      executeInJsReplKernel({
        key,
        cwd,
        code: 'await new Promise((_, reject) => setTimeout(() => reject(new Error("late-reject")), 1_300));',
        timeoutMs: 300,
      }),
    ).rejects.toThrow('timed out');
    const during = await executeInJsReplKernel({ key, cwd, code: 'console.log("captured during");' });
    expect(during.output).toBe('captured during');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await executeInJsReplKernel({ key, cwd, code: 'console.log("captured after");' });
    expect(after.output).toBe('captured after');
    resetJsReplKernel(key);
  }, 30_000);

  test('should kill and reset an unresponsive kernel after the backstop grace', async () => {
    const key = `test-timeout-wedged-${Date.now()}`;
    await executeInJsReplKernel({ key, cwd, code: 'let wedgedMarker = 1;' });
    // A CPU-bound loop blocks the kernel event loop, so the kernel-side soft
    // timeout can never answer and only the host backstop can recover.
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'for (;;) {}', timeoutMs: 500 }),
    ).rejects.toThrow('unresponsive');
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'console.log(wedgedMarker);' }),
    ).rejects.toThrow('wedgedMarker is not defined');
    resetJsReplKernel(key);
  }, 30_000);

  test('should report nested tool calls as unsupported', async () => {
    const key = `test-runtool-${Date.now()}`;
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'await interpreter.tool("read_file", { path: "x" });' }),
    ).rejects.toThrow('not available');
    resetJsReplKernel(key);
  }, 30_000);

  test('should return false when resetting a kernel that never started', async () => {
    expect(resetJsReplKernel(`test-missing-${Date.now()}`)).toBe(false);
  }, 30_000);

  test('should isolate bindings between kernel keys and survive a foreign reset', async () => {
    const keyA = `test-isolate-a-${Date.now()}`;
    const keyB = `test-isolate-b-${Date.now()}`;
    await executeInJsReplKernel({ key: keyA, cwd, code: 'let isolated = "alpha";' });
    const fromB = await executeInJsReplKernel({ key: keyB, cwd, code: 'console.log(typeof isolated);' });
    expect(fromB.output).toBe('undefined');
    expect(resetJsReplKernel(keyB)).toBe(true);
    const fromA = await executeInJsReplKernel({ key: keyA, cwd, code: 'console.log(isolated);' });
    expect(fromA.output).toBe('alpha');
    resetJsReplKernel(keyA);
  }, 30_000);

  test('should resolve playwright-core through the bundled module search path', async () => {
    const key = `test-resolver-${Date.now()}`;
    const result = await executeInJsReplKernel({
      key,
      cwd,
      code: 'const pw = await import("playwright-core"); const chromium = pw.chromium ?? pw.default?.chromium; console.log(typeof chromium?.launch);',
    });
    expect(result.output).toBe('function');
    resetJsReplKernel(key);
  }, 30_000);

  test('should deny importing sandboxed builtins like child_process', async () => {
    const key = `test-denied-${Date.now()}`;
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'await import("node:child_process");' }),
    ).rejects.toThrow('not allowed in js_repl');
    resetJsReplKernel(key);
  }, 30_000);

  test('should reject static top-level imports with await-import guidance', async () => {
    const key = `test-static-import-${Date.now()}`;
    await expect(
      executeInJsReplKernel({ key, cwd, code: 'import fsMod from "node:fs";\nconsole.log(typeof fsMod);' }),
    ).rejects.toThrow('Use await import("node:fs") instead');
    resetJsReplKernel(key);
  }, 30_000);

  test('should re-import edited local files fresh on the next exec', async () => {
    const key = `test-local-import-${Date.now()}`;
    const localCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'js-repl-local-import-'));
    const modPath = path.join(localCwd, 'fresh-mod.mjs');
    try {
      fs.writeFileSync(modPath, 'export const value = 1;\n');
      const first = await executeInJsReplKernel({
        key,
        cwd: localCwd,
        code: 'const mod = await import("./fresh-mod.mjs"); console.log(mod.value);',
      });
      expect(first.output).toBe('1');
      fs.writeFileSync(modPath, 'export const value = 2;\n');
      // Bindings persist across cells, so the re-import must use a new name.
      const second = await executeInJsReplKernel({
        key,
        cwd: localCwd,
        code: 'const modAgain = await import("./fresh-mod.mjs"); console.log(modAgain.value);',
      });
      expect(second.output).toBe('2');
    } finally {
      resetJsReplKernel(key);
      // The SIGKILLed kernel child has localCwd as its working directory and
      // releases the handle asynchronously on Windows. This must be the async
      // rm: rmSync only retries notEmptyErrorCodes (ENOTEMPTY/EEXIST/EPERM)
      // and throws a bare EBUSY immediately, while async rm retries EBUSY
      // with real backoff (internal/fs/rimraf.js).
      await fs.promises.rm(localCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  }, 30_000);

  test('should surface uncaught async errors as a clean failure and restart fresh', async () => {
    const key = `test-async-crash-${Date.now()}`;
    await executeInJsReplKernel({ key, cwd, code: 'let doomed = "set";' });
    await expect(
      executeInJsReplKernel({
        key,
        cwd,
        code: 'setTimeout(() => { throw new Error("async-boom"); }, 10); await new Promise((resolve) => setTimeout(resolve, 5_000));',
      }),
    ).rejects.toThrow('Catch or handle async errors');
    // The kernel exits one tick after sending the fatal exec_result, so the
    // first follow-up exec can race the dying child; retry until the fresh
    // kernel answers.
    const output = await vi.waitFor(async () => {
      const result = await executeInJsReplKernel({ key, cwd, code: 'console.log(typeof doomed);' });
      return result.output;
    }, { timeout: 10_000, interval: 100 });
    expect(output).toBe('undefined');
    resetJsReplKernel(key);
  }, 30_000);

  test('should fail an in-flight exec with an unexpected-exit error when the kernel dies', async () => {
    const key = `test-killed-${Date.now()}`;
    const logSpy = vi.spyOn(console, 'log');
    const inFlight = executeInJsReplKernel({
      key,
      cwd,
      code: 'await new Promise(() => {});',
      timeoutMs: 20_000,
    });
    const inFlightFailure = inFlight.catch((error: Error) => error);
    const pid = await vi.waitFor(() => {
      const startLine = logSpy.mock.calls
        .map((call) => call.join(' '))
        .find((line) => line.includes(`kernel started key=${key} `));
      expect(startLine).toBeDefined();
      const match = /pid=(\d+)/.exec(startLine!);
      expect(match).not.toBeNull();
      return Number(match![1]);
    }, { timeout: 10_000, interval: 50 });
    process.kill(pid, 'SIGKILL');
    const error = await inFlightFailure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('js_repl kernel exited unexpectedly');
    const revived = await executeInJsReplKernel({ key, cwd, code: 'console.log("revived");' });
    expect(revived.output).toBe('revived');
    resetJsReplKernel(key);
  }, 30_000);
});
