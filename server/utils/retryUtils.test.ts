import { describe, expect, test } from 'bun:test';
import { isPermanentError, isTransientError } from './retryUtils';

describe('isTransientError', () => {
  test('returns true for UND_ERR_SOCKET error code', () => {
    expect(
      isTransientError({
        code: 'UND_ERR_SOCKET',
        message: 'terminated',
      })
    ).toBe(true);
  });

  test('returns true for undici timeout code in cause', () => {
    expect(
      isTransientError({
        message: 'fetch failed',
        cause: {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        },
      })
    ).toBe(true);
  });

  test('returns false for permanent 401 auth error', () => {
    expect(
      isTransientError({
        statusCode: 401,
        message: 'Unauthorized',
      })
    ).toBe(false);
  });
});

describe('isPermanentError', () => {
  test('returns true for 402 payment required errors', () => {
    expect(
      isPermanentError({
        statusCode: 402,
        message: 'Payment Required',
      })
    ).toBe(true);
  });

  test('returns true for wrapped not-enough-tokens messages', () => {
    expect(
      isPermanentError({
        message: '[not_enough_tokens]: Insufficient interpreter tokens. Total interpreter tokens: 0',
      })
    ).toBe(true);
  });
});
