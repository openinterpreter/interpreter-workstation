// Runs in the vitest (Node) lane because it spawns real js_repl kernels (see
// kernelManager.vitest.test.ts for why bun cannot host these on Windows).
// Pins the full builtin dispatch chain the CLI relies on: builtin-js-repl
// registration -> ToolManager.callTool -> handler context threadId binding ->
// persistent kernel, including the remembered tool-call-metadata fallback.
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import os from 'node:os';

vi.mock('../utils/mcpServiceBridge', () => ({
  getMcpService: () => ({
    listServers: async () => ({ data: [], nextCursor: null }),
    listServersForDisplay: async () => ({ data: [], nextCursor: null }),
    listAuthStatusesViaCli: async () => new Map(),
    getServerStatus: async () => null,
    getDisplayServerStatus: async () => null,
  }),
  McpService: {
    toToolServerStatus: (s: any) => ({ id: s.name, name: s.name, state: { status: 'connected', tools: [], resources: [], prompts: [] } }),
    toToolConnectionState: () => ({ status: 'connected', tools: [], resources: [], prompts: [] }),
  },
}));

import { clearConfigCache, setConfigOverride } from '../configStore';
import { setCurrentWorkspace } from '../utils/workspace';
import {
  rememberToolCallMetadata,
  _setResolvedToolCallMetadataTtlMsForTest,
} from '../utils/codexMcpBridge';
import { shutdownAllJsReplKernelsForTest } from './builtin-tools/js-repl/kernelManager';
import { ToolManager } from './toolManager';

const workspace = os.tmpdir();

beforeEach(() => {
  clearConfigCache();
  setConfigOverride({ agents: {}, mcpServers: {} });
  setCurrentWorkspace(workspace);
});

afterEach(() => {
  setCurrentWorkspace(null);
  setConfigOverride(null);
  clearConfigCache();
});

afterAll(() => {
  shutdownAllJsReplKernelsForTest();
});

describe('ToolManager builtin-js-repl dispatch', () => {
  test('should run js_repl through builtin registration against a real kernel', async () => {
    const manager = new ToolManager();
    const threadId = `thr-dispatch-${Date.now()}`;
    const result = await manager.callTool(
      'builtin-js-repl',
      'js_repl',
      { code: 'console.log(6 * 7);' },
      undefined,
      undefined,
      { threadId, workspace },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('42');
    await manager.callTool('builtin-js-repl', 'js_repl_reset', {}, undefined, undefined, { threadId, workspace });
  }, 30_000);

  test('should scope kernels by toolContext threadId across calls', async () => {
    const manager = new ToolManager();
    const threadA = `thr-scope-a-${Date.now()}`;
    const threadB = `thr-scope-b-${Date.now()}`;
    await manager.callTool(
      'builtin-js-repl',
      'js_repl',
      { code: 'let perThread = "from-a";' },
      undefined,
      undefined,
      { threadId: threadA, workspace },
    );
    const fromB = await manager.callTool(
      'builtin-js-repl',
      'js_repl',
      { code: 'console.log(typeof perThread);' },
      undefined,
      undefined,
      { threadId: threadB, workspace },
    );
    expect(fromB.content[0].text).toBe('undefined');
    const fromA = await manager.callTool(
      'builtin-js-repl',
      'js_repl',
      { code: 'console.log(perThread);' },
      undefined,
      undefined,
      { threadId: threadA, workspace },
    );
    expect(fromA.content[0].text).toBe('from-a');
    const reset = await manager.callTool(
      'builtin-js-repl',
      'js_repl_reset',
      {},
      undefined,
      undefined,
      { threadId: threadA, workspace },
    );
    expect(reset.content[0].text).toBe('js_repl kernel reset; all top-level bindings were cleared.');
    await manager.callTool('builtin-js-repl', 'js_repl_reset', {}, undefined, undefined, { threadId: threadB, workspace });
  }, 30_000);

  test('should fall back to remembered tool-call metadata for the kernel threadId', async () => {
    const manager = new ToolManager();
    const threadId = `thr-meta-${Date.now()}`;
    const externalToolCallId = `etc-jsrepl-${Date.now()}`;
    // Short TTL so the cleanup timer does not hold the worker open.
    _setResolvedToolCallMetadataTtlMsForTest(2_000);
    rememberToolCallMetadata(externalToolCallId, { threadId });
    await manager.callTool(
      'builtin-js-repl',
      'js_repl',
      { code: 'let viaMetadata = "resolved";' },
      undefined,
      undefined,
      { workspace },
      externalToolCallId,
    );
    const result = await manager.callTool(
      'builtin-js-repl',
      'js_repl',
      { code: 'console.log(viaMetadata);' },
      undefined,
      undefined,
      { threadId, workspace },
    );
    expect(result.content[0].text).toBe('resolved');
    await manager.callTool('builtin-js-repl', 'js_repl_reset', {}, undefined, undefined, { threadId, workspace });
  }, 30_000);
});
