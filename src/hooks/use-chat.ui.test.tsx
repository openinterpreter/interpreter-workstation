import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { textContent, useChat } from './use-chat';

const telemetryMocks = vi.hoisted(() => ({
  trackMessageSent: vi.fn(),
  trackResponseReceived: vi.fn(),
  trackResponseError: vi.fn(),
  trackResponseStopped: vi.fn(),
  trackFirstSuccessfulInteraction: vi.fn(),
  trackAgentTurnCompleted: vi.fn(),
  trackToolCalled: vi.fn(),
  trackToolCompleted: vi.fn(),
  trackToolFailed: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  getApiUrl: vi.fn(async (path: string) => `http://localhost${path}`),
  runtime: {
    onRestarting: vi.fn(() => () => {}),
    onRestarted: vi.fn(() => () => {}),
  },
  telemetry: {
    track: vi.fn(async () => undefined),
    trackError: vi.fn(async () => undefined),
  },
  isAbsolutePath: (value: string) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
  pathBasename: (value: string) => {
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  },
  pathJoin: (...parts: string[]) => parts.filter(Boolean).join('/'),
  pathNormalize: (value: string) => value.replace(/\\/g, '/'),
}));

vi.mock('@/ipc', () => ipcMocks);
vi.mock('../ipc', () => ipcMocks);

vi.mock('@/utils/sounds', () => ({
  playSound: vi.fn(),
}));

vi.mock('@/utils/telemetry', () => telemetryMocks);

vi.mock('@/utils/telemetryContext', () => ({
  setActiveProfile: vi.fn(),
}));

vi.mock('@/utils/userVisibleErrorLog', () => ({
  logUserVisibleError: vi.fn(),
}));

vi.mock('../demo/marketingDemo', () => ({
  applyMarketingDemoScenario: vi.fn(),
  buildMarketingDemoAssistantReply: vi.fn(() => 'Done'),
  createMarketingDemoThread: vi.fn(() => 'marketing-thread'),
  getMarketingDemoScenario: vi.fn(() => null),
  getMarketingDemoTranscript: vi.fn(() => []),
  isMarketingDemoMode: vi.fn(() => false),
  saveMarketingDemoTranscript: vi.fn(),
}));

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(events.join('')));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function threadHistoryResponse(threadId: string): Response {
  return new Response(
    JSON.stringify({
      thread: {
        id: threadId,
        preview: 'Historical answer',
        createdAt: 1,
        updatedAt: 2,
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'user-1',
                content: [{ type: 'text', text: 'Historical question', text_elements: [] }],
              },
              {
                type: 'agentMessage',
                id: 'assistant-1',
                text: 'Historical answer',
                phase: 'final_answer',
              },
            ],
          },
        ],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function messageTexts(messages: ReturnType<typeof useChat>['messages']): string[] {
  return messages.map(textContent);
}

describe('useChat telemetry', () => {
  beforeEach(() => {
    ipcMocks.getApiUrl.mockImplementation(async (path: string) => `http://localhost${path}`);
    ipcMocks.runtime.onRestarting.mockImplementation(() => () => {});
    ipcMocks.runtime.onRestarted.mockImplementation(() => () => {});

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse([
          sse('thread', { threadId: 'thread-1' }),
          sse('tool', {
            phase: 'started',
            type: 'mcpToolCall',
            item: {
              id: 'tool-1',
              type: 'mcpToolCall',
              server: 'filesystem',
              tool: 'read_file',
              status: 'inProgress',
              arguments: { path: 'missing.txt' },
              result: null,
              error: null,
              durationMs: null,
              mcpAppResourceUri: null,
            },
          }),
          sse('tool', {
            phase: 'completed',
            type: 'mcpToolCall',
            item: {
              id: 'tool-1',
              type: 'mcpToolCall',
              server: 'filesystem',
              tool: 'read_file',
              status: 'failed',
              arguments: { path: 'missing.txt' },
              result: null,
              error: { message: 'missing.txt does not exist' },
              durationMs: 12,
              mcpAppResourceUri: null,
            },
          }),
          sse('completed', {
            turnId: 'turn-1',
            status: 'completed',
            error: null,
          }),
        ]),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('counts failed tool calls from the finalized assistant draft', async () => {
    const { result } = renderHook(() =>
      useChat('interpreter', {
        agentId: 'agent-1',
        callerToken: 'caller-token',
        model: 'interpreter-smart',
      }),
    );

    act(() => {
      result.current.sendMessage('read the file');
    });

    await waitFor(() => {
      expect(telemetryMocks.trackAgentTurnCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'natural_stop',
          toolCallCount: 1,
          toolFailCount: 1,
          threadId: 'thread-1',
        }),
      );
    });
  });

  test('accepts only one send when the composer is activated twice in one render', async () => {
    const { result } = renderHook(() =>
      useChat('interpreter', {
        agentId: 'agent-1',
        callerToken: 'caller-token',
        model: 'interpreter-smart',
      }),
    );

    act(() => {
      result.current.sendMessage('submit exactly once');
      result.current.sendMessage('submit exactly once');
    });

    expect(messageTexts(result.current.messages)).toEqual(['submit exactly once']);
    await waitFor(() => {
      const streamRequests = vi.mocked(fetch).mock.calls.filter(([input]) =>
        String(input).includes('/api/agent/chat/stream'),
      );
      expect(streamRequests).toHaveLength(1);
    });
  });

  test('keeps existing messages when stopping an active turn', async () => {
    const threadId = 'thread-1';

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);

      if (url.includes(`/api/agent/threads/${threadId}`)) {
        return threadHistoryResponse(threadId);
      }

      if (url.includes('/api/agent/chat/stream')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }

      if (url.includes('/api/agent/chat/stop')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const { result } = renderHook(() =>
      useChat('interpreter', {
        agentId: 'agent-1',
        callerToken: 'caller-token',
        model: 'interpreter-smart',
        initialThreadId: threadId,
      }),
    );

    await waitFor(() => {
      expect(result.current.historyLoaded).toBe(true);
      expect(messageTexts(result.current.messages)).toEqual([
        'Historical question',
        'Historical answer',
      ]);
      expect(result.current.error).toBeNull();
    });

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) =>
          String(input).includes(
            `/api/agent/threads/${threadId}?limit=2&bestEffort=1`,
          ),
        ),
      ).toBe(true);
    });

    act(() => {
      result.current.sendMessage('stop this request');
    });

    await waitFor(() => {
      expect(messageTexts(result.current.messages)).toEqual([
        'Historical question',
        'Historical answer',
        'stop this request',
      ]);
    });

    act(() => {
      result.current.stopGeneration();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
    expect(messageTexts(result.current.messages)).toEqual([
      'Historical question',
      'Historical answer',
      'stop this request',
    ]);
  });
});

describe('useChat history refresh', () => {
  beforeEach(() => {
    ipcMocks.getApiUrl.mockImplementation(async (path: string) => `http://localhost${path}`);
    ipcMocks.runtime.onRestarting.mockImplementation(() => () => {});
    ipcMocks.runtime.onRestarted.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('skips refresh ticks while a slow refresh is still in flight and aborts it on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const threadId = 'thread-slow';
    const refreshSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('bestEffort=1')) {
        refreshSignals.push(init!.signal!);
        return new Promise<Response>(() => {});
      }
      if (url.includes(`/api/agent/threads/${threadId}?limit=24`)) {
        return threadHistoryResponse(threadId);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { result, unmount } = renderHook(() =>
      useChat('interpreter', {
        agentId: 'agent-1',
        callerToken: 'caller-token',
        model: 'interpreter-smart',
        initialThreadId: threadId,
      }),
    );

    await waitFor(() => {
      expect(result.current.historyLoaded).toBe(true);
      expect(refreshSignals).toHaveLength(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(refreshSignals).toHaveLength(1);
    expect(refreshSignals[0]!.aborted).toBe(false);

    unmount();
    expect(refreshSignals[0]!.aborted).toBe(true);
  });

  test('records the in-progress turn of an active thread for steering', async () => {
    const threadId = 'thread-active';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('bestEffort=1')) {
        return new Response(JSON.stringify({
          thread: {
            id: threadId,
            preview: 'Historical question',
            createdAt: 1,
            updatedAt: 3,
            status: { type: 'active', activeFlags: [] },
            // The newest two turns: the one already shown and the new one.
            turns: [{
              id: 'turn-1',
              status: 'completed',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'Historical question', text_elements: [] }],
                },
                { type: 'agentMessage', id: 'assistant-1', text: 'Historical answer', phase: 'final_answer' },
              ],
            }, {
              id: 'turn-2',
              status: 'inProgress',
              items: [{
                type: 'userMessage',
                id: 'user-2',
                content: [{ type: 'text', text: 'Started elsewhere', text_elements: [] }],
              }],
            }],
          },
          historyPage: { nextCursor: 'older', hasMore: true },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(`/api/agent/threads/${threadId}?limit=24`)) {
        return threadHistoryResponse(threadId);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { result } = renderHook(() =>
      useChat('interpreter', {
        agentId: 'agent-1',
        callerToken: 'caller-token',
        model: 'interpreter-smart',
        initialThreadId: threadId,
      }),
    );

    await waitFor(() => {
      expect(result.current.observedActiveTurnId).toBe('turn-2');
      expect(result.current.isStreaming).toBe(true);
      expect(messageTexts(result.current.messages)).toEqual([
        'Historical question',
        'Historical answer',
        'Started elsewhere',
      ]);
    });
  });
});

function qaTurn(n: number) {
  return {
    id: `turn-${n}`,
    status: 'completed',
    items: [
      { type: 'userMessage', id: `user-${n}`, content: [{ type: 'text', text: `Q${n}`, text_elements: [] }] },
      { type: 'agentMessage', id: `assistant-${n}`, text: `A${n}`, phase: 'final_answer' },
    ],
  };
}

function pageResponse(threadId: string, turnNumbers: number[], nextCursor: string | null): Response {
  return new Response(JSON.stringify({
    thread: {
      id: threadId,
      preview: 'Q1',
      createdAt: 1,
      updatedAt: 2,
      turns: turnNumbers.map(qaTurn),
    },
    historyPage: { nextCursor, hasMore: nextCursor !== null },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function qaTexts(...turnNumbers: number[]): string[] {
  return turnNumbers.flatMap((n) => [`Q${n}`, `A${n}`]);
}

describe('useChat refresh gap reconciliation', () => {
  beforeEach(() => {
    ipcMocks.getApiUrl.mockImplementation(async (path: string) => `http://localhost${path}`);
    ipcMocks.runtime.onRestarting.mockImplementation(() => () => {});
    ipcMocks.runtime.onRestarted.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const urls = () => vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  const newestReads = () => urls().filter((url) => url.includes('limit=2&bestEffort=1'));
  const gapReads = () => urls().filter((url) => url.includes('before=') && url.includes('bestEffort=1'));

  function renderChat(threadId: string) {
    return renderHook(() =>
      useChat('interpreter', {
        agentId: 'agent-1',
        callerToken: 'caller-token',
        model: 'interpreter-smart',
        initialThreadId: threadId,
      }),
    );
  }

  test('shows every turn finished between refreshes, in order and once', async () => {
    const threadId = 'thread-gap';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=2&bestEffort=1')) return pageResponse(threadId, [4, 5], 'c-before-4');
      if (url.includes('before=c-before-4')) return pageResponse(threadId, [1, 2, 3], null);
      if (url.endsWith(`/api/agent/threads/${threadId}?limit=24`)) return pageResponse(threadId, [1], null);
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { result } = renderChat(threadId);

    await waitFor(() => {
      expect(messageTexts(result.current.messages)).toEqual(qaTexts(1, 2, 3, 4, 5));
    });
    expect(gapReads()).toHaveLength(1);
    expect(gapReads()[0]).toContain(`limit=24&before=c-before-4`);
    const ids = result.current.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a refresh that reaches a shown turn makes no extra request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const threadId = 'thread-connected';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=2&bestEffort=1')) return pageResponse(threadId, [1, 2], 'c-before-1');
      if (url.endsWith(`/api/agent/threads/${threadId}?limit=24`)) return pageResponse(threadId, [1], null);
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { result } = renderChat(threadId);
    await waitFor(() => {
      expect(messageTexts(result.current.messages)).toEqual(qaTexts(1, 2));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(newestReads().length).toBeGreaterThanOrEqual(2);
    expect(gapReads()).toHaveLength(0);
    expect(messageTexts(result.current.messages)).toEqual(qaTexts(1, 2));
  });

  test('stops at the page cap and exposes the gap through older history', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const threadId = 'thread-capped';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('limit=2&bestEffort=1')) return pageResponse(threadId, [9, 10], 'p1');
      if (url.includes('before=p1&bestEffort=1')) return pageResponse(threadId, [7, 8], 'p2');
      if (url.includes('before=p2&bestEffort=1')) return pageResponse(threadId, [5, 6], 'p3');
      if (url.includes('before=p3&bestEffort=1')) return pageResponse(threadId, [3, 4], 'p4');
      if (url.includes('before=p4&bestEffort=1')) return pageResponse(threadId, [2], 'p5');
      if (url.endsWith('limit=24&before=p5')) return pageResponse(threadId, [1], null);
      if (url.endsWith(`/api/agent/threads/${threadId}?limit=24`)) return pageResponse(threadId, [1], null);
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { result } = renderChat(threadId);
    await waitFor(() => {
      expect(messageTexts(result.current.messages)).toEqual(qaTexts(2, 3, 4, 5, 6, 7, 8, 9, 10));
    });
    expect(gapReads()).toHaveLength(4);
    expect(urls().some((url) => url.includes('before=p5&bestEffort=1'))).toBe(false);
    expect(result.current.hasOlderHistory).toBe(true);

    // Later refreshes connect to the new window and read nothing further back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(gapReads()).toHaveLength(4);

    // "Load older" continues from the gap and restores the full order.
    await act(async () => {
      await result.current.loadOlderHistory();
    });
    expect(messageTexts(result.current.messages)).toEqual(qaTexts(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    expect(result.current.hasOlderHistory).toBe(false);
  });

  test('a reconciliation in progress blocks the next refresh tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const threadId = 'thread-reconciling';
    const gapSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('limit=2&bestEffort=1')) return pageResponse(threadId, [4, 5], 'c-before-4');
      if (url.includes('before=c-before-4')) {
        gapSignals.push(init!.signal!);
        return new Promise<Response>(() => {});
      }
      if (url.endsWith(`/api/agent/threads/${threadId}?limit=24`)) return pageResponse(threadId, [1], null);
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const { result, unmount } = renderChat(threadId);
    await waitFor(() => {
      expect(result.current.historyLoaded).toBe(true);
      expect(gapSignals).toHaveLength(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(newestReads()).toHaveLength(1);
    expect(gapSignals).toHaveLength(1);
    expect(messageTexts(result.current.messages)).toEqual(qaTexts(1));

    unmount();
    expect(gapSignals[0]!.aborted).toBe(true);
  });
});
