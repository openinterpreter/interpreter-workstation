import { describe, expect, test } from 'bun:test';

import { applyChatEvent, createInitialChatState } from '../../src/hooks/use-chat-reducer';
import { createdTurnOutcome } from '../utils/outcomeReturnsRuntime';
import {
  createAgentStreamErrorPayload,
  createdTurnMissingIdError,
  getAgentServiceTierConfig,
  getProgrammaticTaskHttpError,
  getProgrammaticClientIdError,
  getProgrammaticSenderError,
  getUnacknowledgedTaskError,
  parseProgrammaticTaskBody,
  shouldWatchFirstCreatedTurn,
  resolveTestModelRuntime,
  toProgrammaticTaskProgressSseEvents,
  withSenderHeader,
} from './agent';

describe('Simple mode service tier', () => {
  test('uses the actual OpenAI fast tier only for the Simple primary agent', () => {
    expect(getAgentServiceTierConfig('simple-primary-agent')).toEqual({
      service_tier: 'fast',
    });
    expect(getAgentServiceTierConfig('advanced-agent')).toBeUndefined();
  });
});

describe('programmatic task HTTP transport', () => {
  test('only the first native turn of a create receives the outcome watch', () => {
    let first: string | null = null;
    const watched: string[] = [];
    for (const turnId of ['first', 'second', 'second']) {
      const event = { kind: 'turn' as const, threadId: 'created_thread', turnId, status: 'inProgress' };
      if (shouldWatchFirstCreatedTurn(event, first)) {
        first = `${event.threadId}:${event.turnId}`;
        watched.push(first);
      }
    }
    expect(watched).toEqual(['created_thread:first']);
  });
  test('an unacknowledged create reports unknown, never completed', () => {
    expect(createdTurnMissingIdError(true)).toEqual({ success: false, outcome: 'unknown',
      error: 'Created task ended without a native turn ID.' });
    expect(createdTurnMissingIdError(false).outcome).toBe('unknown');
  });
  test('recognizes usage limits only from structured failed-turn errors', () => {
    expect(createdTurnOutcome('failed', { codexErrorInfo: 'usageLimitExceeded' })).toBe('usageLimited');
    expect(createdTurnOutcome('failed', { codexErrorInfo: { usageLimitReached: {} } })).toBe('usageLimited');
    expect(createdTurnOutcome('failed', { message: 'usageLimitExceeded' })).toBe('failed');
    expect(createdTurnOutcome('completed', { codexErrorInfo: 'usageLimitExceeded' })).toBe('completed');
  });
  test('accepts a native client ID in the wake event ID alphabet and rejects malformed values before admission', () => {
    expect(parseProgrammaticTaskBody({ message: 'task', clientUserMessageId: 'origin_01' }).clientUserMessageId)
      .toBe('origin_01');
    expect(getProgrammaticClientIdError(undefined)).toBe(false);
    expect(getProgrammaticClientIdError('origin_01')).toBe(false);
    for (const invalid of ['', 'a b', '../bad', 'x'.repeat(161), 1, null]) {
      expect(getProgrammaticClientIdError(invalid)).toBe(true);
    }
  });
  test('accepts an exact sender for existing-thread work and prefixes one header line', () => {
    const thread = '00000000-0000-4000-8000-000000000001';
    const body = { message: 'Run the report.', threadId: thread, clientUserMessageId: 'handoff_1',
      sender: { computer: 'build-host-2', thread: 'origin_thread-7' } };
    expect(getProgrammaticSenderError(body)).toBeNull();
    const parsed = parseProgrammaticTaskBody(body);
    expect(parsed.sender).toEqual({ computer: 'build-host-2', thread: 'origin_thread-7' });
    expect(withSenderHeader(parsed.sender, parsed.message))
      .toBe('[Sender: build-host-2 thread origin_thread-7]\nRun the report.');
    const hostOnly = parseProgrammaticTaskBody({ ...body, sender: { computer: 'build-host-2' } });
    expect(withSenderHeader(hostOnly.sender, 'line one\nline two'))
      .toBe('[Sender: build-host-2]\nline one\nline two');
  });
  test('rejects malformed or unattached senders before admission', () => {
    const base = { message: 'task', threadId: '00000000-0000-4000-8000-000000000001',
      clientUserMessageId: 'handoff_2' };
    for (const sender of [null, 'host', [], {}, { computer: 'A-host' }, { computer: '1host' },
      { computer: 'h' }, { computer: `h${'a'.repeat(63)}` }, { computer: 'host_name' },
      { computer: 'host', thread: '' }, { computer: 'host', thread: 'a b' },
      { computer: 'host', thread: 'x'.repeat(161) }, { computer: 'host', thread: 7 },
      { computer: 'host', extra: true }]) {
      expect(getProgrammaticSenderError({ ...base, sender })).toBe('Invalid sender.');
      expect(parseProgrammaticTaskBody({ ...base, sender }).sender).toBeUndefined();
    }
    const sender = { computer: 'host' };
    expect(getProgrammaticSenderError({ message: 'task', clientUserMessageId: 'c1', sender }))
      .toBe('sender requires a source thread for created tasks.');
    expect(getProgrammaticSenderError({ message: 'task', threadId: '  ', clientUserMessageId: 'c1', sender }))
      .toBe('sender requires a source thread for created tasks.');
    expect(getProgrammaticSenderError({ message: 'task', clientUserMessageId: 'c1',
      sender: { computer: 'host', thread: 'source_1' } })).toBeNull();
    expect(getProgrammaticSenderError({ message: 'task',
      sender: { computer: 'host', thread: 'source_1' } }))
      .toBe('clientUserMessageId is required for sender-attributed create.');
    // The sender check covers only the sender; the task routes require a
    // client ID for any input to an existing thread.
    expect(getProgrammaticSenderError({ message: 'task', threadId: base.threadId, sender })).toBeNull();
  });
  test('a request without sender is unchanged', () => {
    const body = { message: 'Plain task.', threadId: '00000000-0000-4000-8000-000000000001' };
    expect(getProgrammaticSenderError(body)).toBeNull();
    const parsed = parseProgrammaticTaskBody(body);
    expect(parsed.sender).toBeUndefined();
    expect(withSenderHeader(parsed.sender, parsed.message)).toBe('Plain task.');
  });
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

  test('parses provider-preserving model overrides for the host default profile', () => {
    const parsed = parseProgrammaticTaskBody({
      message: 'Start work.',
      workspace: '/tmp/science',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    });

    expect(parsed.model).toBe('gpt-5.6-sol');
    expect(parsed.reasoningEffort).toBe('low');
    expect(parsed.modelConfig).toBeUndefined();
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
  test('reports a terminal pre-ack failure instead of an unexplained no-ack', () => {
    const failed = {
      mode: 'headless' as const,
      completed: false,
      timestamp: '2026-10-31T00:00:00Z',
      messageCount: 0,
      messages: [],
      error: 'Existing thread could not resume',
    };
    expect(getUnacknowledgedTaskError(failed, false)).toEqual({
      code: 'turn_not_acknowledged',
      message: 'Existing thread could not resume',
    });
    expect(getUnacknowledgedTaskError(failed, true)).toBeNull();
    expect(getUnacknowledgedTaskError({ ...failed, error: undefined }, false)).toEqual({
      code: 'turn_not_acknowledged',
      message: 'Agent task ended without a native turn acknowledgement.',
    });
  });

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
