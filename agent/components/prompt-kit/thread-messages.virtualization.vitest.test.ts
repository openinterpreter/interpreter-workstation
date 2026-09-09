// Behavior tests for the changes in this branch:
//   1. The MessageBubble memo comparator skips re-renders when transient
//      thread-wide state (speaking sentence, hovered detached tool, etc.)
//      doesn't actually target this message.
//   2. Helpers used by the virtualized message list still classify and
//      group items correctly.
//
// These are pure-function tests on purpose — the full ThreadMessages tree
// is exercised by `thread-messages.test.ts` and by the headed Electron
// suite. Here we only validate the memo/grouping primitives so future
// refactors of the virtualizer don't silently regress them.

import { describe, expect, test } from 'vitest';
import {
  arePropsEqualForBubble,
  collectDetachedToolCalls,
  collectLastAssistantMessageIdsInTurns,
  groupMessageParts,
  isMountedUserMessageFullyOutOfView,
  isUserMessageFullyOutOfView,
  mountedMessageRowSelector,
  observeStickyUserMessageLayout,
  resolveMeasuredUserMessageSize,
  type MessageBubbleProps,
} from './thread-messages';
import type { ChatMessage, ToolCallInfo } from '../../../src/hooks/use-chat';

function userMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', content }],
    attachments: [],
    serverMessageId: id,
  } as ChatMessage;
}

function assistantText(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ kind: 'text', content }],
    attachments: [],
    serverMessageId: id,
  } as ChatMessage;
}

function toolCall(id: string, state: ToolCallInfo['state'] = 'complete'): ToolCallInfo {
  return {
    id,
    type: 'reasoning',
    label: id,
    state,
  } as ToolCallInfo;
}

// Non-reasoning tool calls are eligible for the "detached" rail. The
// runtime classifies background-running tools with later text content as
// detached so the user can keep chatting while the tool finishes.
function detachableToolCall(id: string, state: ToolCallInfo['state'] = 'loading'): ToolCallInfo {
  return {
    id,
    type: 'commandExecution',
    label: id,
    state,
    item: { type: 'commandExecution', command: 'sleep 30', cwd: '/tmp' },
  } as unknown as ToolCallInfo;
}

function assistantWithTool(id: string, tc: ToolCallInfo): ChatMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ kind: 'tool-call', toolCall: tc }],
    attachments: [],
    serverMessageId: id,
  } as ChatMessage;
}

function baseProps(msg: ChatMessage, overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    agentId: 'agent_test',
    msg,
    previousRole: null,
    isStreaming: false,
    activeSpeakingSentence: null,
    orphanApprovalAnchor: null,
    activeThreadId: 'thread_test',
    isWideUserLayout: false,
    activeDetachedToolCallIds: undefined,
    hoveredDetachedToolCallId: null,
    onHoverDetachedToolCallId: () => {},
    showAssistantInlineActions: false,
    ...overrides,
  };
}

describe('arePropsEqualForBubble — memo skip logic', () => {
  test('returns true when transient state changes do not target this message', () => {
    const msg = assistantText('m1', 'hello');
    const prev = baseProps(msg, {
      activeSpeakingSentence: { messageId: 'm2', sentenceIndex: 0, text: 'other' },
      hoveredDetachedToolCallId: 'unrelated_tool',
    });
    const next = baseProps(msg, {
      activeSpeakingSentence: { messageId: 'm3', sentenceIndex: 0, text: 'still other' },
      hoveredDetachedToolCallId: 'another_unrelated_tool',
    });

    expect(arePropsEqualForBubble(prev, next)).toBe(true);
  });

  test('returns false when the speaking sentence starts targeting this message', () => {
    const msg = assistantText('m1', 'hello');
    const prev = baseProps(msg, {
      activeSpeakingSentence: { messageId: 'other', sentenceIndex: 0, text: 'x' },
    });
    const next = baseProps(msg, {
      activeSpeakingSentence: { messageId: 'm1', sentenceIndex: 0, text: 'x' },
    });

    expect(arePropsEqualForBubble(prev, next)).toBe(false);
  });

  test('returns false when the speaking sentence is still on this message but the sentence reference changed', () => {
    const msg = assistantText('m1', 'hello');
    const prev = baseProps(msg, {
      activeSpeakingSentence: { messageId: 'm1', sentenceIndex: 0, text: 'first' },
    });
    const next = baseProps(msg, {
      activeSpeakingSentence: { messageId: 'm1', sentenceIndex: 1, text: 'second' },
    });

    expect(arePropsEqualForBubble(prev, next)).toBe(false);
  });

  test('returns false when the orphan approval anchor starts targeting this message', () => {
    const msg = assistantText('m1', 'hello');
    const prev = baseProps(msg, {
      orphanApprovalAnchor: { kind: 'empty', messageId: 'm2' },
    });
    const next = baseProps(msg, {
      orphanApprovalAnchor: { kind: 'empty', messageId: 'm1' },
    });

    expect(arePropsEqualForBubble(prev, next)).toBe(false);
  });

  test('returns false when hoveredDetachedToolCallId references a tool owned by this message', () => {
    const tc = toolCall('tool_x', 'loading');
    const msg = assistantWithTool('m1', tc);

    const prev = baseProps(msg, { hoveredDetachedToolCallId: null });
    const next = baseProps(msg, { hoveredDetachedToolCallId: 'tool_x' });

    expect(arePropsEqualForBubble(prev, next)).toBe(false);
  });

  test('returns true when hoveredDetachedToolCallId references a tool NOT owned by this message', () => {
    const tc = toolCall('tool_x', 'loading');
    const msg = assistantWithTool('m1', tc);

    const prev = baseProps(msg, { hoveredDetachedToolCallId: null });
    const next = baseProps(msg, { hoveredDetachedToolCallId: 'tool_y_belongs_to_someone_else' });

    expect(arePropsEqualForBubble(prev, next)).toBe(true);
  });

  test('returns false when msg identity itself changed', () => {
    const m1 = assistantText('m1', 'first');
    const m1Updated = assistantText('m1', 'first edited');

    const prev = baseProps(m1);
    const next = baseProps(m1Updated);

    expect(arePropsEqualForBubble(prev, next)).toBe(false);
  });

  test('returns false when showAssistantInlineActions flips', () => {
    const msg = assistantText('m1', 'hello');
    expect(arePropsEqualForBubble(
      baseProps(msg, { showAssistantInlineActions: false }),
      baseProps(msg, { showAssistantInlineActions: true }),
    )).toBe(false);
  });
});

describe('grouping helpers used by the virtualized list', () => {
  test('groupMessageParts collapses consecutive tool-call parts into one activity-group', () => {
    const groups = groupMessageParts([
      { kind: 'text', content: 'intro' },
      { kind: 'tool-call', toolCall: toolCall('a', 'complete') },
      { kind: 'tool-call', toolCall: toolCall('b', 'complete') },
      { kind: 'tool-call', toolCall: toolCall('c', 'complete') },
      { kind: 'text', content: 'wrap up' },
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual({ type: 'text', content: 'intro' });
    expect(groups[1]).toMatchObject({ type: 'activity-group' });
    if (groups[1]?.type === 'activity-group') {
      expect(groups[1].toolCalls).toHaveLength(3);
    }
    expect(groups[2]).toEqual({ type: 'text', content: 'wrap up' });
  });

  test('collectLastAssistantMessageIdsInTurns marks only the last assistant message in each turn', () => {
    const messages: ChatMessage[] = [
      userMessage('u1', 'q1'),
      assistantText('a1', 'partial'),
      assistantText('a2', 'final'), // last in turn 1
      userMessage('u2', 'q2'),
      assistantText('a3', 'final'), // last in turn 2
    ];

    const ids = collectLastAssistantMessageIdsInTurns(messages, null);
    expect(ids.has('a1')).toBe(false);
    expect(ids.has('a2')).toBe(true);
    expect(ids.has('a3')).toBe(true);
  });

  test('collectDetachedToolCalls picks loading tools that have later text content', () => {
    const stillRunning = detachableToolCall('bg', 'loading');
    const messages: ChatMessage[] = [
      assistantWithTool('a1', stillRunning),
      assistantText('a2', 'follow-up text'),
    ];

    const detached = collectDetachedToolCalls(messages, null);
    expect(detached).toHaveLength(1);
    expect(detached[0]?.toolCallId).toBe('bg');
  });

  test('collectDetachedToolCalls excludes reasoning items even when they are loading', () => {
    const reasoning = toolCall('rz', 'loading');
    const messages: ChatMessage[] = [
      assistantWithTool('a1', reasoning),
      assistantText('a2', 'follow-up text'),
    ];

    const detached = collectDetachedToolCalls(messages, null);
    expect(detached).toHaveLength(0);
  });
});

describe('sticky user-message visibility', () => {
  test('recomputes sticky state when a mounted message row changes size', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalMutationObserver = globalThis.MutationObserver;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let resizeCallback: (() => void) | null = null;
    let disconnected = 0;

    class TestResizeObserver {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() { disconnected += 1; }
    }
    class TestMutationObserver {
      observe() {}
      disconnect() { disconnected += 1; }
    }

    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = TestMutationObserver as unknown as typeof MutationObserver;
    let nextFrameId = 0;
    const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frameTimers.set(id, setTimeout(() => {
        frameTimers.delete(id);
        callback(0);
      }, 0));
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      const timer = frameTimers.get(id);
      if (timer) clearTimeout(timer);
      frameTimers.delete(id);
    }) as typeof cancelAnimationFrame;

    const row = document.createElement('div');
    row.dataset.index = '0';
    const container = document.createElement('div');
    container.appendChild(row);
    let recomputes = 0;

    try {
      const cleanup = observeStickyUserMessageLayout({
        scrollContainer: container,
        onLayoutChange: () => { recomputes += 1; },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(recomputes).toBe(1);
      resizeCallback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(recomputes).toBe(2);
      cleanup();
      expect(disconnected).toBe(2);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      globalThis.MutationObserver = originalMutationObserver;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  test('does not treat the virtualizer estimate as a measured long bubble', () => {
    expect(resolveMeasuredUserMessageSize({
      cachedSize: 240,
      estimateSize: 240,
    })).toBeUndefined();
    expect(resolveMeasuredUserMessageSize({
      mountedSize: 900,
      cachedSize: 240,
      estimateSize: 240,
    })).toBe(900);
    expect(resolveMeasuredUserMessageSize({
      mountedSize: 0,
      cachedSize: 900,
      estimateSize: 240,
    })).toBe(900);
  });

  test('waits until a long user bubble is fully above the viewport', () => {
    expect(isUserMessageFullyOutOfView({
      itemTop: 0,
      itemHeight: 900,
      scrollTop: 899,
    })).toBe(false);

    expect(isUserMessageFullyOutOfView({
      itemTop: 0,
      itemHeight: 900,
      scrollTop: 900,
    })).toBe(true);
  });

  test('uses the mounted row position instead of a stale virtual offset', () => {
    expect(isMountedUserMessageFullyOutOfView({
      itemBottom: 420,
      viewportTop: 120,
    })).toBe(false);

    expect(isMountedUserMessageFullyOutOfView({
      itemBottom: 120,
      viewportTop: 120,
    })).toBe(true);
  });

  test('selects the mounted row by its stable virtual index', () => {
    expect(mountedMessageRowSelector(7)).toBe('[data-index="7"]');
  });
});
