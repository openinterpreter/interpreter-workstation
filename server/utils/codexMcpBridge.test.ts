import { describe, test, expect, beforeEach } from 'bun:test';
import {
  registerPendingToolCall,
  consumePendingToolCall,
  awaitPendingToolCall,
  clearPendingToolCalls,
  getToolCallMetadata,
  resolveAndExecuteCodexTool,
  _setTtlForTest,
  _setWaitForRegistrationMsForTest,
  _setLateRegistrationGraceMsForTest,
  _setResolvedToolCallMetadataTtlMsForTest,
} from './codexMcpBridge';
import { parseToolName } from '../../shared/utils/mcpToolName';
import { getCurrentWindowSessionKey } from './windowSessions';
import { getCurrentWorkspace } from './workspace';
import type { AgentModelConfig } from '../../shared/types/model';
import type { ToolManager } from '../tools/toolManager';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
type ToolManagerCallArgs = Parameters<ToolManager['callTool']>;
type MockToolManager = Pick<ToolManager, 'callTool'> & {
  calls: ToolManagerCallArgs[];
};

beforeEach(() => {
  clearPendingToolCalls();
  _setTtlForTest(60_000);
  _setWaitForRegistrationMsForTest(100);
  _setLateRegistrationGraceMsForTest(100);
  _setResolvedToolCallMetadataTtlMsForTest(60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// FIFO Registry
//
// These tests verify the core invariant: item IDs pushed via registerPendingToolCall
// are consumed in FIFO order by consumePendingToolCall, isolated per (server, tool)
// key. This ordering guarantee is what allows the sidebar ToolCallCard to match
// approvals to Codex stream items.
// ---------------------------------------------------------------------------

describe('FIFO registry', () => {
  test('should_push_and_pop_in_fifo_order', () => {
    registerPendingToolCall('builtin-fs', 'delete_file', 'item_A');
    registerPendingToolCall('builtin-fs', 'delete_file', 'item_B');

    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBe('item_A');
    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBe('item_B');
  });

  test('should_return_undefined_when_queue_empty', () => {
    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBeUndefined();
  });

  test('should_wait_for_late_registration_until_item_arrives', async () => {
    const pending = awaitPendingToolCall('builtin-fs', 'delete_file', { path: '/tmp/x' });

    setTimeout(() => {
      registerPendingToolCall('builtin-fs', 'delete_file', 'late_item', { path: '/tmp/x' });
    }, 10);

    await expect(pending).resolves.toBe('late_item');
  });

  test('should_reject_waiting_consumer_when_aborted', async () => {
    const controller = new AbortController();
    const pending = awaitPendingToolCall('builtin-fs', 'delete_file', { path: '/tmp/x' }, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('should_return_undefined_after_wait_timeout_when_no_item_arrives', async () => {
    _setWaitForRegistrationMsForTest(5);

    await expect(awaitPendingToolCall('builtin-fs', 'delete_file', { path: '/tmp/x' })).resolves.toBeUndefined();
  });

  test('should_isolate_queues_by_server_and_tool', () => {
    registerPendingToolCall('builtin-fs', 'delete_file', 'item_fs');
    registerPendingToolCall('builtin-shell', 'run_command', 'item_shell');

    expect(consumePendingToolCall('builtin-shell', 'run_command')).toBe('item_shell');
    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBe('item_fs');
  });

  test('should_handle_concurrent_same_tool_calls', () => {
    registerPendingToolCall('s', 't', 'item_1');
    registerPendingToolCall('s', 't', 'item_2');
    registerPendingToolCall('s', 't', 'item_3');

    expect(consumePendingToolCall('s', 't')).toBe('item_1');
    expect(consumePendingToolCall('s', 't')).toBe('item_2');
    expect(consumePendingToolCall('s', 't')).toBe('item_3');
    expect(consumePendingToolCall('s', 't')).toBeUndefined();
  });

  test('should_cleanup_stale_entries_after_ttl', async () => {
    _setTtlForTest(50);
    registerPendingToolCall('builtin-fs', 'delete_file', 'stale_item');

    await delay(100);

    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBeUndefined();
  });

  test('should_not_cleanup_entries_before_ttl', async () => {
    _setTtlForTest(200);
    registerPendingToolCall('builtin-fs', 'delete_file', 'fresh_item');

    await delay(50);

    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBe('fresh_item');
  });

  test('should_clear_all_pending_calls', () => {
    registerPendingToolCall('a', 'b', 'item_1');
    registerPendingToolCall('c', 'd', 'item_2');

    clearPendingToolCalls();

    expect(consumePendingToolCall('a', 'b')).toBeUndefined();
    expect(consumePendingToolCall('c', 'd')).toBeUndefined();
  });

  test('should_not_cross_contaminate_same_server_different_tools', () => {
    registerPendingToolCall('builtin-fs', 'delete_file', 'item_delete');
    registerPendingToolCall('builtin-fs', 'write_file', 'item_write');

    expect(consumePendingToolCall('builtin-fs', 'write_file')).toBe('item_write');
    expect(consumePendingToolCall('builtin-fs', 'delete_file')).toBe('item_delete');
  });

  test('should_not_cross_contaminate_same_tool_different_servers', () => {
    registerPendingToolCall('server-a', 'run', 'item_a');
    registerPendingToolCall('server-b', 'run', 'item_b');

    expect(consumePendingToolCall('server-b', 'run')).toBe('item_b');
    expect(consumePendingToolCall('server-a', 'run')).toBe('item_a');
  });
});

// ---------------------------------------------------------------------------
// Middleware: resolveAndExecuteCodexTool
//
// Tests verify the middleware correctly bridges the FIFO registry to
// toolManager.callTool, passing the Codex item ID as externalToolCallId
// (7th argument). Uses dependency injection via the `deps` parameter to
// avoid module mocking -- consistent with this codebase's test style.
// ---------------------------------------------------------------------------

describe('resolveAndExecuteCodexTool', () => {
  function makeMockToolManager(): MockToolManager {
    const calls: ToolManagerCallArgs[] = [];
    return {
      calls,
      callTool: async (...args: ToolManagerCallArgs) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
  }

  test('should_forward_non_builtin_server_calls_to_tool_manager', async () => {
    const mock = makeMockToolManager();
    registerPendingToolCall(
      'custom-mcp',
      'some_tool',
      'item_custom',
      { key: 'val' },
      { threadId: 'thr-custom' },
    );

    const result = await resolveAndExecuteCodexTool(
      { serverId: 'custom-mcp', toolName: 'some_tool', args: { key: 'val' } },
      { getToolManager: () => mock as any },
    );

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0][0]).toBe('custom-mcp');
    expect(mock.calls[0][1]).toBe('some_tool');
    expect(mock.calls[0][2]).toEqual({ key: 'val' });
    expect(mock.calls[0][6]).toBe('item_custom');
    expect(getToolCallMetadata('item_custom')).toEqual({ threadId: 'thr-custom' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  test('should_preserve_structured_image_content_for_direct_tool_calls', async () => {
    const calls: ToolManagerCallArgs[] = [];
    const mock = {
      calls,
      callTool: async (...args: ToolManagerCallArgs) => {
        calls.push(args);
        return {
          content: [
            { type: 'text', text: 'Computer Use state' },
            {
              type: 'image',
              image: {
                data: 'aW1hZ2UtYnl0ZXM=',
                mimeType: 'image/jpeg',
              },
            },
          ],
          imagePaths: ['/tmp/interpreter-desktop-driver-state.jpg'],
          isError: false,
        };
      },
    } satisfies MockToolManager;
    registerPendingToolCall(
      'builtin-cua-driver',
      'get_app_state',
      'item_cua_state',
      { app: 'Slack' },
      { threadId: 'thr-cua' },
    );

    const result = await resolveAndExecuteCodexTool(
      { serverId: 'builtin-cua-driver', toolName: 'get_app_state', args: { app: 'Slack' } },
      { getToolManager: () => mock as any },
    );

    expect(mock.calls).toHaveLength(1);
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Computer Use state' },
        {
          type: 'image',
          image: {
            data: 'aW1hZ2UtYnl0ZXM=',
            mimeType: 'image/jpeg',
          },
        },
      ],
      imagePaths: ['/tmp/interpreter-desktop-driver-state.jpg'],
      isError: false,
    });
  });

  test('should_pass_codex_item_id_as_external_tool_call_id', async () => {
    const mock = makeMockToolManager();
    registerPendingToolCall(
      'builtin-fs',
      'delete_file',
      'item_abc',
      { path: '/tmp/x' },
      { threadId: 'thr-123' },
    );

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/x' } },
      { getToolManager: () => mock as any },
    );

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0][6]).toBe('item_abc');
    expect(getToolCallMetadata('item_abc')).toEqual({ threadId: 'thr-123' });
  });

  test('should_reject_when_correlation_is_aborted_before_item_started', async () => {
    const mock = makeMockToolManager();
    const controller = new AbortController();

    const pending = resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/x' }, signal: controller.signal },
      { getToolManager: () => mock as any },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.calls).toHaveLength(0);
  });

  test('should_pass_undefined_when_no_pending_item_arrives_before_timeout', async () => {
    _setWaitForRegistrationMsForTest(5);
    const mock = makeMockToolManager();

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/x' } },
      { getToolManager: () => mock as any },
    );

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0][6]).toBeUndefined();
  });

  test('should_forward_all_params_to_tool_manager', async () => {
    const mock = makeMockToolManager();
    registerPendingToolCall('builtin-test', 'my-tool', 'item_xyz', { key: 'value' });

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-test', toolName: 'my-tool', args: { key: 'value' }, callerTabId: 'tab-1' },
      { getToolManager: () => mock as any },
    );

    expect(mock.calls).toHaveLength(1);
    const [serverId, toolName, args, saveToDisk, callerTabId, toolContext, externalId] = mock.calls[0];
    expect(serverId).toBe('builtin-test');
    expect(toolName).toBe('my-tool');
    expect(args).toEqual({ key: 'value' });
    expect(saveToDisk).toBeUndefined();
    expect(callerTabId).toBe('tab-1');
    expect(toolContext).toBeUndefined();
    expect(externalId).toBe('item_xyz');
  });

  test('should_forward_agent_workspace_for_direct_main_agent_mcp_calls', async () => {
    const mock = makeMockToolManager();
    registerPendingToolCall('builtin-fs', 'delete_file', 'item_xyz', { path: '/tmp/x' });

    await resolveAndExecuteCodexTool(
      {
        serverId: 'builtin-fs',
        toolName: 'delete_file',
        args: { path: '/tmp/x' },
        callerTabId: 'agent-123',
        profileId: 'benchmark:run-main',
      },
      {
        getToolManager: () => mock,
        getAgentBindingForAgentId: () => ({
          agentId: 'agent-123',
          callerToken: 'agtok_test',
          threadId: 'thr-agent-workspace',
          workspacePath: '/tmp/agent-workspace',
        }),
      },
    );

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0][5]).toEqual({
      profileId: 'benchmark:run-main',
      threadId: 'thr-agent-workspace',
      workspace: '/tmp/agent-workspace',
    });
  });

  test('should_consume_items_in_fifo_order_across_middleware_calls', async () => {
    const mock = makeMockToolManager();
    registerPendingToolCall('builtin-s', 't', 'first');
    registerPendingToolCall('builtin-s', 't', 'second');

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-s', toolName: 't', args: {} },
      { getToolManager: () => mock as any },
    );
    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-s', toolName: 't', args: {} },
      { getToolManager: () => mock as any },
    );

    expect(mock.calls[0][6]).toBe('first');
    expect(mock.calls[1][6]).toBe('second');
  });

  test('should_wait_for_item_started_before_calling_tool_manager', async () => {
    const mock = makeMockToolManager();

    const execution = resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'list_directory', args: { path: '/Applications' } },
      { getToolManager: () => mock as any },
    );

    setTimeout(() => {
      registerPendingToolCall('builtin-fs', 'list_directory', 'call_late', { path: '/Applications' });
    }, 10);

    await execution;

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0][6]).toBe('call_late');
  });

  test('should_wait_longer_for_main_agent_calls_before_giving_up_on_correlation', async () => {
    _setWaitForRegistrationMsForTest(5);
    const mock = makeMockToolManager();

    const execution = resolveAndExecuteCodexTool(
      {
        serverId: 'builtin-fs',
        toolName: 'delete_file',
        args: { path: '/tmp/x' },
        profileId: 'main-agent',
      },
      { getToolManager: () => mock as any },
    );

    setTimeout(() => {
      registerPendingToolCall(
        'builtin-fs',
        'delete_file',
        'main_agent_item',
        { path: '/tmp/x' },
        { threadId: 'thr-main-agent' },
      );
    }, 150);

    await execution;

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0][6]).toBe('main_agent_item');
    expect(getToolCallMetadata('main_agent_item')).toEqual({ threadId: 'thr-main-agent' });
  });

  test('should_drop_late_registration_after_timeout_instead_of_reusing_it_for_next_call', async () => {
    _setWaitForRegistrationMsForTest(5);

    let releaseFirstCall!: () => void;
    let signalFirstCallStarted!: () => void;
    const firstCallStarted = new Promise<void>((resolve) => {
      signalFirstCallStarted = resolve;
    });
    const firstCallResult = new Promise((resolve) => {
      releaseFirstCall = () => resolve({ content: [{ type: 'text', text: 'first' }] });
    });

    const calls: any[][] = [];
    const mock = {
      callTool: async (...args: any[]) => {
        calls.push(args);
        if (calls.length === 1) {
          signalFirstCallStarted();
          return await firstCallResult;
        }
        return { content: [{ type: 'text', text: 'second' }] };
      },
    };

    const firstExecution = resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/first' } },
      { getToolManager: () => mock as any },
    );

    await firstCallStarted;
    expect(calls).toHaveLength(1);
    expect(calls[0][6]).toBeUndefined();

    registerPendingToolCall('builtin-fs', 'delete_file', 'stale_item', { path: '/tmp/first' });
    expect(consumePendingToolCall('builtin-fs', 'delete_file', { path: '/tmp/first' })).toBeUndefined();

    releaseFirstCall();
    await firstExecution;

    registerPendingToolCall('builtin-fs', 'delete_file', 'fresh_item', { path: '/tmp/second' });

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/second' } },
      { getToolManager: () => mock as any },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1][6]).toBe('fresh_item');
  });

  test('should_drop_late_registration_that_arrives_after_a_fast_timed_out_call_completes', async () => {
    _setWaitForRegistrationMsForTest(5);
    _setLateRegistrationGraceMsForTest(50);

    const calls: any[][] = [];
    const mock = {
      callTool: async (...args: any[]) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/first' } },
      { getToolManager: () => mock as any },
    );

    await delay(10);
    registerPendingToolCall('builtin-fs', 'delete_file', 'late_item', { path: '/tmp/first' });

    await resolveAndExecuteCodexTool(
      { serverId: 'builtin-fs', toolName: 'delete_file', args: { path: '/tmp/second' } },
      { getToolManager: () => mock as any },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0][6]).toBeUndefined();
    expect(calls[1][6]).toBeUndefined();
    expect(consumePendingToolCall('builtin-fs', 'delete_file', { path: '/tmp/first' })).toBeUndefined();
  });

  test('should_return_tool_manager_result', async () => {
    const expected = { content: [{ type: 'text', text: 'result data' }], isError: false };
    const mock = {
      callTool: async () => expected,
    };
    registerPendingToolCall('builtin-s', 't', 'item_result');

    const result = await resolveAndExecuteCodexTool(
      { serverId: 'builtin-s', toolName: 't', args: {} },
      { getToolManager: () => mock as any },
    );

    expect(result).toBe(expected);
  });

  test('passes full bound tab context into ToolManager for scoped /mcp MCP calls', async () => {
    const modelConfig = {
      provider: 'hosted',
      modelId: 'interpreter-smart',
      profileId: 'profile-1',
    } satisfies AgentModelConfig;
    const calls: ToolManagerCallArgs[] = [];
    const ownerContexts: Array<{ windowSessionKey: string | null; workspace: string | null }> = [];
    const mock: Pick<ToolManager, 'callTool'> = {
      callTool: async (...args: ToolManagerCallArgs) => {
        calls.push(args);
        ownerContexts.push({
          windowSessionKey: getCurrentWindowSessionKey(),
          workspace: getCurrentWorkspace(),
        });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };

    await resolveAndExecuteCodexTool(
      {
        serverId: 'custom-mcp',
        toolName: 'lookup',
        args: { q: 'x' },
        callerTabId: 'agent-123',
        profileId: 'main-agent',
      },
      {
        getToolManager: () => mock,
        getAgentBindingForAgentId: () => ({
          agentId: 'agent-123',
          callerToken: 'agtok_test',
          threadId: 'thread-123',
          windowSessionKey: 'window-123',
          workspacePath: '/tmp/ws',
          modelConfig,
          toolProfileId: 'profile-1',
        }),
      },
    );

    expect(calls).toHaveLength(1);
    const [_serverId, _toolName, _args, _saveToDisk, callerTabId, toolContext] = calls[0];
    expect(callerTabId).toBe('agent-123');
    expect(toolContext).toEqual({
      profileId: 'profile-1',
      modelConfig,
      threadId: 'thread-123',
      workspace: '/tmp/ws',
    });
    expect(ownerContexts).toEqual([{
      windowSessionKey: 'window-123',
      workspace: '/tmp/ws',
    }]);
  });

  test('returns an MCP error when a non-builtin scoped /mcp call has no thread owner', async () => {
    const mock = makeMockToolManager();

    const result = await resolveAndExecuteCodexTool(
      {
        serverId: 'custom-mcp',
        toolName: 'lookup',
        args: { q: 'x' },
        callerTabId: 'agent-123',
        profileId: 'main-agent',
      },
      {
        getToolManager: () => mock,
        getAgentBindingForAgentId: () => ({
          agentId: 'agent-123',
          callerToken: 'agtok_test',
          workspacePath: '/tmp/ws',
          toolProfileId: 'profile-1',
        }),
      },
    );

    expect(mock.calls).toHaveLength(0);
    expect(result).toEqual({
      content: [{
        type: 'text',
        text: 'MCP tool calls require an active Interpreter thread before approval can be shown.',
      }],
      isError: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: Codex stream -> FIFO -> MCP tools/call
//
// These tests use realistic Codex stream payloads to verify that the FIFO keys
// match between the registration side (agent.ts, which sees MCP-prefixed tool
// names like "builtin-docx__read_word") and the consumption side
// (mcp.ts, which uses parseToolName to split into serverId + toolName).
//
// This is the contract that must hold:
//   parseToolName(codexItem.tool) => { serverId, toolName }
//   registerPendingToolCall(serverId, toolName, codexItem.id)
//   consumePendingToolCall(serverId, toolName) => codexItem.id
//
// Without these tests, a naming convention mismatch between the two sides
// would only surface at runtime (as it did in the initial implementation).
// ---------------------------------------------------------------------------

describe('Codex stream to MCP tools/call key agreement', () => {
  // These payloads are taken from real Codex server logs.
  // item/started emits item.tool as the MCP-prefixed name and item.server
  // as the proxy server (e.g. "workstation"). The MCP tools/call handler
  // receives the same prefixed name and splits it with parseToolName().
  const REALISTIC_ITEMS = [
    { tool: 'builtin-docx__read_word', id: 'call_InwS9NCVC9Q3R1lommX2JMU6' },
    { tool: 'builtin-docx__read_docx', id: 'call_abc123' },
    { tool: 'builtin-browser__navigate', id: 'call_def456' },
    { tool: 'custom-server__my_tool', id: 'call_ghi789' },
  ];

  for (const item of REALISTIC_ITEMS) {
    test(`should_correlate_codex_item_with_mcp_call_for_${item.tool}`, () => {
      const parsed = parseToolName(item.tool);
      expect(parsed).not.toBeNull();

      // Simulate agent.ts: register using parsed names from Codex stream
      registerPendingToolCall(parsed!.serverId, parsed!.toolName, item.id, { path: '/tmp/test' });

      // Simulate mcp.ts: consume using the same parsed names
      const recovered = consumePendingToolCall(parsed!.serverId, parsed!.toolName, { path: '/tmp/test' });
      expect(recovered).toBe(item.id);
    });
  }

  test('should_correlate_full_flow_with_middleware', async () => {
    const calls: any[][] = [];
    const mockToolManager = {
      callTool: async (...args: any[]) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };

    const codexItem = { tool: 'builtin-docx__read_word', id: 'call_realXYZ' };
    const parsed = parseToolName(codexItem.tool)!;

    // Simulate agent.ts onEvent: parse and register
    registerPendingToolCall(parsed.serverId, parsed.toolName, codexItem.id, { path: '/tmp/test' });

    // Simulate mcp.ts tools/call: middleware consumes and forwards
    await resolveAndExecuteCodexTool(
      { serverId: parsed.serverId, toolName: parsed.toolName, args: { path: '/tmp/test' }, callerTabId: 'tab-42' },
      { getToolManager: () => mockToolManager as any },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][6]).toBe('call_realXYZ');
  });
});
