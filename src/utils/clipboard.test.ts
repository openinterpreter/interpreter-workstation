import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { copyTextToClipboard } from './clipboard';

describe('copyTextToClipboard', () => {
  test('returns true after a successful write', async () => {
    const writes: string[] = [];

    const copied = await copyTextToClipboard('tool output', {
      writeText: async (text) => {
        writes.push(text);
      },
    });

    assert.equal(copied, true);
    assert.deepEqual(writes, ['tool output']);
  });

  test('returns false when the write fails', async () => {
    const errors: unknown[] = [];

    const copied = await copyTextToClipboard('tool output', {
      writeText: async () => {
        throw new Error('clipboard unavailable');
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    assert.equal(copied, false);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'clipboard unavailable');
  });
});
