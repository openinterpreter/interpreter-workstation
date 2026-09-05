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
            `/api/agent/threads/${threadId}?limit=24&bestEffort=1`,
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
