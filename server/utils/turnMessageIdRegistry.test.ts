import { describe, expect, test, beforeEach } from 'bun:test';
import {
  setCurrentTurnMessageId,
  getCurrentTurnMessageId,
  runInTurnContext,
  exitTurnContext,
} from './turnMessageIdRegistry';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('turnMessageIdRegistry', () => {
  beforeEach(() => {
    setCurrentTurnMessageId(null);
  });

  test('should_return_null_by_default', () => {
    expect(getCurrentTurnMessageId()).toBeNull();
  });

  test('should_return_value_after_set', () => {
    setCurrentTurnMessageId('turn-abc-123');
    expect(getCurrentTurnMessageId()).toBe('turn-abc-123');
  });

  test('should_clear_when_set_to_null', () => {
    setCurrentTurnMessageId('turn-xyz');
    setCurrentTurnMessageId(null);
    expect(getCurrentTurnMessageId()).toBeNull();
  });

  test('should_overwrite_previous_value', () => {
    setCurrentTurnMessageId('turn-first');
    setCurrentTurnMessageId('turn-second');
    expect(getCurrentTurnMessageId()).toBe('turn-second');
  });

  // ---------------------------------------------------------------------------
  // Request isolation tests
  //
  // These test the contract that concurrent requests must each see their own
  // turn message ID, not a shared global. They model the real concurrency
  // scenarios found in the codebase:
  //
  // CITATION: agent.ts:612 -- setCurrentTurnMessageId(turnMessageId) called
  //   inside /chat/stream's onEvent callback when event.kind === 'turn'.
  // CITATION: agent.ts:646 -- setCurrentTurnMessageId(null) in finally block.
  // CITATION: toolManager.ts:406 -- getCurrentTurnMessageId() read during
  //   callTool to associate file-write tool execution with the active turn.
  //
  // Each Express request handler runs in a separate async context.
  // runInTurnContext simulates this by creating an isolated context per request.
  // ---------------------------------------------------------------------------

  describe('request isolation', () => {
    // Models: Two /chat/stream requests from separate agent tabs.
    // Tab A starts streaming, sets turn-A. Tab B starts streaming, sets turn-B.
    // A's tool calls (toolManager.ts:406) must still read turn-A.
    test('should_isolate_concurrent_requests', async () => {
      const requestA = runInTurnContext(null, async () => {
        setCurrentTurnMessageId('turn-A');
        await delay(10);
        return getCurrentTurnMessageId();
      });

      const requestB = runInTurnContext(null, async () => {
        setCurrentTurnMessageId('turn-B');
        await delay(5);
        return getCurrentTurnMessageId();
      });

      const [resultA, resultB] = await Promise.all([requestA, requestB]);
      expect(resultA).toBe('turn-A');
      expect(resultB).toBe('turn-B');
    });

    // Models: Request A's finally block (agent.ts:646) clears the ID while
    // request B is still streaming. B's tool calls must still read turn-B.
    test('should_not_null_other_context_on_cleanup', async () => {
      let resultB: string | null = null;

      const requestA = runInTurnContext(null, async () => {
        setCurrentTurnMessageId('turn-A');
        await delay(5);
        setCurrentTurnMessageId(null);
      });

      const requestB = runInTurnContext(null, async () => {
        setCurrentTurnMessageId('turn-B');
        await delay(15);
        resultB = getCurrentTurnMessageId();
      });

      await Promise.all([requestA, requestB]);
      expect(resultB).toBe('turn-B');
    });

    // Models: An independent async request with no current turn. The request
    // must not inherit the main agent's turn ID from another context.
    test('should_not_leak_turn_id_to_independent_context', async () => {
      let subagentResult: string | null = 'should-be-null';

      const mainAgent = runInTurnContext(null, async () => {
        setCurrentTurnMessageId('main-turn-123');
        await delay(5);
        return getCurrentTurnMessageId();
      });

      const subagentRequest = runInTurnContext(null, async () => {
        await delay(3);
        subagentResult = getCurrentTurnMessageId();
      });

      await Promise.all([mainAgent, subagentRequest]);
      expect(await mainAgent).toBe('main-turn-123');
      expect(subagentResult).toBeNull();
    });

    // Models: Codex MCP tool call path. The /chat/stream handler sets the
    // turn ID (agent.ts:612), then the Codex subprocess makes a tool call
    // via MCP JSON-RPC. The MCP tools/call handler runs in a DIFFERENT async
    // context (it's a separate incoming message on the transport). The
    // toolManager.callTool() at line 406 must still read the turn ID so
    // the work is attributed to the correct turn.
    //
    // CITATION: MCP tools/call handler is NOT wrapped in runInTurnContext --
    //   it's a separate JSON-RPC message handler on the MCP transport.
    // CITATION: toolManager.ts:406 -- getCurrentTurnMessageId() is called
    //   inside callTool, which runs in the MCP handler's async context.
    test('should_read_turn_id_from_cross_context_mcp_handler', async () => {
      let mcpHandlerResult: string | null = null;

      const streamHandler = runInTurnContext(null, async () => {
        setCurrentTurnMessageId('turn-from-stream');
        await delay(10);
        return getCurrentTurnMessageId();
      });

      // NOTE(victor): MCP handler runs outside any ALS context -- exitTurnContext
      // simulates a fresh async context with no ALS store, just like a real MCP
      // tools/call message handler arriving on the transport would be.
      const mcpToolHandler = exitTurnContext(async () => {
        await delay(5);
        mcpHandlerResult = getCurrentTurnMessageId();
      });

      await Promise.all([streamHandler, mcpToolHandler]);
      expect(await streamHandler).toBe('turn-from-stream');
      expect(mcpHandlerResult).toBe('turn-from-stream');
    });
  });
});
