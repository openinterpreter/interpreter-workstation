import { describe, expect, test } from 'bun:test';
import { JSONRPCErrorCode, JSONRPCErrorException } from 'json-rpc-2.0';

import type { v2 } from '../../server/handlers/codex-generated-types/index';
import { isThreadUnavailableError, requiresFreshThread } from './codexThreadRecovery';

function createThread(overrides: Partial<v2.Thread> = {}): v2.Thread {
  return {
    id: 'thread-1',
    preview: '',
    ephemeral: false,
    modelProvider: 'interpreter',
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    path: null,
    cwd: '/workspace',
    cliVersion: 'test',
    source: 'vscode',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function createTurn(overrides: Partial<v2.Turn> = {}): v2.Turn {
  return {
    id: 'turn-1',
    items: [],
    status: 'completed',
    error: null,
    ...overrides,
  };
}

describe('requiresFreshThread', () => {
  test('returns true when the last turn failed with array_above_max_length', () => {
    const thread = createThread({
      turns: [
        createTurn({
          status: 'failed',
          error: {
            message: 'request failed with code array_above_max_length',
            codexErrorInfo: 'other',
            additionalDetails: null,
          },
        }),
      ],
    });

    expect(requiresFreshThread(thread)).toBe(true);
  });

  test('returns false for healthy threads', () => {
    expect(requiresFreshThread(createThread())).toBe(false);
  });
});

describe('isThreadUnavailableError', () => {
  test('returns true for invalid-request JSON-RPC stale-thread errors', () => {
    expect(
      isThreadUnavailableError(
        new JSONRPCErrorException('thread not loaded: abc', JSONRPCErrorCode.InvalidRequest),
      ),
    ).toBe(true);
    expect(
      isThreadUnavailableError(
        new JSONRPCErrorException('thread not found: abc', JSONRPCErrorCode.InvalidRequest),
      ),
    ).toBe(true);
    expect(
      isThreadUnavailableError(
        new JSONRPCErrorException('invalid thread id: abc', JSONRPCErrorCode.InvalidRequest),
      ),
    ).toBe(true);
  });

  test('returns false for non-JSON-RPC or non-invalid-request errors', () => {
    expect(
      isThreadUnavailableError(
        new JSONRPCErrorException('thread not loaded: abc', JSONRPCErrorCode.InternalError),
      ),
    ).toBe(false);
    expect(isThreadUnavailableError(new Error('thread not loaded: abc'))).toBe(false);
    expect(isThreadUnavailableError('thread not loaded: abc')).toBe(false);
  });
});
