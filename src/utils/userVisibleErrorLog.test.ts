import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { buildUserVisibleErrorLogLine } from './userVisibleErrorLog';

describe('buildUserVisibleErrorLogLine', () => {
  test('serializes multiline UI errors onto one grep-friendly line', () => {
    const line = buildUserVisibleErrorLogLine('chat', {
      message: 'Windows sandbox failed to start this command.',
      details: 'Open Settings -> Native Tools and run Windows sandbox setup, then retry.',
      endpointBaseUrl: 'http://127.0.0.1:5177',
      threadId: 'thr_123',
      turnId: 'turn_456',
    });

    assert.equal(
      line,
      '[UI_ERROR] kind=chat message="Windows sandbox failed to start this command." details="Open Settings -> Native Tools and run Windows sandbox setup, then retry." endpointBaseUrl="http://127.0.0.1:5177" threadId="thr_123" turnId="turn_456"',
    );
  });

  test('omits undefined fields but preserves nulls for explicit absence', () => {
    const line = buildUserVisibleErrorLogLine('toast', {
      message: 'Windows sandbox setup failed.',
      details: undefined,
      actions: null,
    });

    assert.equal(
      line,
      '[UI_ERROR] kind=toast message="Windows sandbox setup failed." actions=null',
    );
  });
});
