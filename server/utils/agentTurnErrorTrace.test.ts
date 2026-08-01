import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { buildAgentTurnErrorTrace } from './agentTurnErrorTrace';

describe('buildAgentTurnErrorTrace', () => {
  test('serializes error stack, cause, and turn context into one JSON string', () => {
    const rootCause = new Error('stream died');
    const error = new Error('turn watchdog fired', { cause: rootCause });
    error.name = 'TurnIdleError';
    error.stack = 'TurnIdleError: turn watchdog fired\n    at stream';
    rootCause.stack = 'Error: stream died\n    at relay';

    const trace = JSON.parse(
      buildAgentTurnErrorTrace(error, {
        agentId: 'agent_123',
        durationMs: 180000,
        model: 'gpt-5.4',
        profileId: 'hosted-profile',
        provider: 'hosted',
        requestThreadId: 'thr_requested',
        resolvedThreadId: 'thr_resolved',
        selection: 'stored-profile',
        turnId: 'turn_123',
      }),
    ) as Record<string, unknown>;

    assert.deepEqual(trace, {
      agentId: 'agent_123',
      durationMs: 180000,
      error: {
        cause: {
          message: 'stream died',
          name: 'Error',
          stack: 'Error: stream died\n    at relay',
        },
        message: 'turn watchdog fired',
        name: 'TurnIdleError',
        stack: 'TurnIdleError: turn watchdog fired\n    at stream',
      },
      model: 'gpt-5.4',
      profileId: 'hosted-profile',
      provider: 'hosted',
      requestThreadId: 'thr_requested',
      resolvedThreadId: 'thr_resolved',
      selection: 'stored-profile',
      turnId: 'turn_123',
    });
  });

  test('falls back to string-safe serialization for non-error payloads', () => {
    const trace = JSON.parse(
      buildAgentTurnErrorTrace(
        { code: 'EPIPE', nested: { status: 502 } },
        { durationMs: 42 },
      ),
    ) as Record<string, unknown>;

    assert.deepEqual(trace, {
      agentId: null,
      durationMs: 42,
      error: {
        code: 'EPIPE',
        nested: {
          status: 502,
        },
      },
      model: null,
      profileId: null,
      provider: null,
      requestThreadId: null,
      resolvedThreadId: null,
      selection: null,
      turnId: null,
    });
  });
});
