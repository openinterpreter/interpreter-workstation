import { describe, expect, test } from 'bun:test';

import { applyChatEvent, createInitialChatState } from '../../src/hooks/use-chat-reducer';
import {
  createAgentStreamErrorPayload,
  getProgrammaticTaskHttpError,
  parseProgrammaticTaskBody,
  resolveTestModelRuntime,
  toProgrammaticTaskProgressSseEvents,
} from './agent';

describe('programmatic task HTTP transport', () => {
  test('keeps whole-task and turn-idle timeouts separate', () => {
    const parsed = parseProgrammaticTaskBody({
      message: 'Keep going.',
      timeoutMs: 86_400_000,
      idleTimeoutMs: 0,
      workspace: '/tmp/science',
    });

    expect(parsed.timeoutMs).toBe(86_400_000);
    expect(parsed.idleTimeoutMs).toBe(0);
  });

  test('rejects all programmatic task HTTP inside Electron', () => {
    expect(
      getProgrammaticTaskHttpError({
        isElectronRuntime: true,
        mode: 'headless',
      }),
    ).toContain('disabled in the Electron app');

    expect(
      getProgrammaticTaskHttpError({
        isElectronRuntime: true,
        mode: 'headed',
      }),
    ).toContain('disabled in the Electron app');
  });

  test('rejects headed HTTP outside Electron', () => {
    expect(
      getProgrammaticTaskHttpError({
        isElectronRuntime: false,
        mode: 'headed',
      }),
    ).toContain('only available via IPC');
  });

  test('allows headless HTTP outside Electron', () => {
    expect(
      getProgrammaticTaskHttpError({
        isElectronRuntime: false,
        mode: 'headless',
      }),
    ).toBeNull();
  });
});

describe('programmatic task SSE progress mapping', () => {
  test('maps thread and turn progress to stable SSE events', () => {
    expect(
      toProgrammaticTaskProgressSseEvents({
        kind: 'thread',
        threadId: 'thr_123',
      }),
    ).toEqual([
      {
        event: 'thread',
        payload: { threadId: 'thr_123' },
      },
    ]);

    expect(
      toProgrammaticTaskProgressSseEvents({
        kind: 'turn',
        threadId: 'thr_123',
        turnId: 'turn_456',
        status: 'running',
      }),
    ).toEqual([
      {
        event: 'turn',
        payload: {
          threadId: 'thr_123',
          turnId: 'turn_456',
          status: 'running',
        },
      },
    ]);
  });

  test('passes UI stream events through unchanged', () => {
    expect(
      toProgrammaticTaskProgressSseEvents({
        kind: 'ui',
        event: {
          event: 'delta',
          payload: { text: 'working...' },
        },
      }),
    ).toEqual([
      {
        event: 'delta',
        payload: { text: 'working...' },
      },
    ]);
  });
});

describe('agent stream errors', () => {
  test('emits reducer-compatible top-level errors', () => {
    const payload = createAgentStreamErrorPayload(
      "codex app-server exited (1): stderr: /opt/Interpreter/resources/interpreter-app-server: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.38' not found",
      'turn_error trace',
    );

    expect(payload).toEqual({
      errorInfo: {
        kind: 'raw',
        text: "codex app-server exited (1): stderr: /opt/Interpreter/resources/interpreter-app-server: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.38' not found",
      },
      additionalDetails: 'turn_error trace',
    });

    const result = applyChatEvent(createInitialChatState(), {
      event: 'error',
      payload,
    });

    expect(result.state.error).toContain('GLIBC_2.38');
    expect(result.state.errorDetails).toBe('turn_error trace');
  });
});

describe('test model runtime resolution', () => {
  test('normalizes local model IDs before testing an Ollama-backed local model', () => {
    const result = resolveTestModelRuntime({
      provider: 'local',
      modelId: 'qwen3.5-0.8b',
      baseURL: 'http://localhost:11434/v1',
    });

    expect(result.modelId).toBe('qwen3.5:0.8b');
    expect(result.profile.modelProvider).toMatch(/^ollama-/);
    expect(result.profile.model).toBe('qwen3.5:0.8b');
  });
});
