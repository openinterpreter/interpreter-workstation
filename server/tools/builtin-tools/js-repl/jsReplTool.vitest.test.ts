// Runs in the vitest (Node) lane (see kernelManager.vitest.test.ts for why).
// Covers the model-facing handler layer on top of real kernels: input
// validation, output/placeholder formatting, error mapping, image content-item
// transport, and per-thread reset semantics.
import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { jsReplTool } from './jsReplTool';
import { jsReplResetTool } from './jsReplResetTool';
import { shutdownAllJsReplKernelsForTest } from './kernelManager';

const workspace = os.tmpdir();

afterAll(() => {
  shutdownAllJsReplKernelsForTest();
});

describe('js_repl tool handler', () => {
  test('should reject empty code with a dedicated error', async () => {
    const result = await jsReplTool.handler({ code: '   ' }, { workspace, threadId: `t-empty-${Date.now()}` });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('js_repl expects non-empty JavaScript source in the `code` argument.');
  }, 30_000);

  test('should reject calls without an active workspace', async () => {
    const result = await jsReplTool.handler({ code: 'console.log(1);' }, { threadId: `t-nows-${Date.now()}` });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('js_repl requires an active workspace; no workspace is set for this agent.');
  }, 30_000);

  test('should return the no-output placeholder for silent cells', async () => {
    const threadId = `t-silent-${Date.now()}`;
    const result = await jsReplTool.handler({ code: '1 + 1;' }, { workspace, threadId });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('(js_repl finished with no console output)');
    await jsReplResetTool.handler({}, { workspace, threadId });
  }, 30_000);

  test('should map a throwing cell to an isError result with the message', async () => {
    const threadId = `t-throw-${Date.now()}`;
    const result = await jsReplTool.handler({ code: 'throw new Error("boom-handler");' }, { workspace, threadId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom-handler');
    await jsReplResetTool.handler({}, { workspace, threadId });
  }, 30_000);

  test('should persist bindings per threadId and isolate other threads', async () => {
    const threadA = `t-scope-a-${Date.now()}`;
    const threadB = `t-scope-b-${Date.now()}`;
    await jsReplTool.handler({ code: 'let scoped = "thread-a";' }, { workspace, threadId: threadA });
    const fromB = await jsReplTool.handler({ code: 'console.log(typeof scoped);' }, { workspace, threadId: threadB });
    expect(fromB.content[0].text).toBe('undefined');
    const fromA = await jsReplTool.handler({ code: 'console.log(scoped);' }, { workspace, threadId: threadA });
    expect(fromA.content[0].text).toBe('thread-a');
    await jsReplResetTool.handler({}, { workspace, threadId: threadA });
    await jsReplResetTool.handler({}, { workspace, threadId: threadB });
  }, 30_000);

  test('should return emitted images as image content items plus imagePaths', async () => {
    const threadId = `t-image-${Date.now()}`;
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const result = await jsReplTool.handler({
      code: `await interpreter.emitImage("data:image/png;base64,${onePixelPng}"); console.log("emitted");`,
    }, { workspace, threadId });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('emitted');
    expect(result.content[1].type).toBe('image');
    expect(result.content[1].mimeType).toBe('image/png');
    expect(result.content[1].data).toBe(onePixelPng);
    expect(result.imagePaths).toHaveLength(1);
    fs.rmSync(result.imagePaths![0], { force: true });
    await jsReplResetTool.handler({}, { workspace, threadId });
  }, 30_000);
});

describe('js_repl_reset tool handler', () => {
  test('should report when there is no kernel to reset', async () => {
    const result = await jsReplResetTool.handler({}, { workspace, threadId: `t-reset-missing-${Date.now()}` });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('No running js_repl kernel for this thread; nothing to reset.');
  }, 30_000);

  test('should reset a running kernel and clear its bindings', async () => {
    const threadId = `t-reset-live-${Date.now()}`;
    await jsReplTool.handler({ code: 'let gone = 1;' }, { workspace, threadId });
    const reset = await jsReplResetTool.handler({}, { workspace, threadId });
    expect(reset.content[0].text).toBe('js_repl kernel reset; all top-level bindings were cleared.');
    const after = await jsReplTool.handler({ code: 'console.log(gone);' }, { workspace, threadId });
    expect(after.isError).toBe(true);
    expect(after.content[0].text).toContain('gone is not defined');
    await jsReplResetTool.handler({}, { workspace, threadId });
  }, 30_000);
});
