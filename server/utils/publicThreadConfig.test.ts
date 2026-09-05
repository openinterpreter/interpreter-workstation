import { describe, expect, test } from 'bun:test';

import { resolvePublicThreadId } from './publicThreadConfig';

describe('public thread configuration', () => {
  test('prefers a directly configured thread id', () => {
    expect(resolvePublicThreadId({
      INTERPRETER_PUBLIC_THREAD_ID: 'thread-direct',
      INTERPRETER_PUBLIC_THREAD_ID_FILE: '/state/thread-id',
    }, () => 'thread-file')).toBe('thread-direct');
  });

  test('loads a thread id file for services that bootstrap after startup', () => {
    expect(resolvePublicThreadId({
      INTERPRETER_PUBLIC_THREAD_ID_FILE: '/state/thread-id',
    }, (path, encoding) => {
      expect(path).toBe('/state/thread-id');
      expect(encoding).toBe('utf8');
      return 'thread-live\n';
    })).toBe('thread-live');
  });

  test('fails closed for missing or malformed state', () => {
    expect(resolvePublicThreadId({}, () => 'ignored')).toBeUndefined();
    expect(resolvePublicThreadId({
      INTERPRETER_PUBLIC_THREAD_ID_FILE: '/state/thread-id',
    }, () => {
      throw new Error('missing');
    })).toBeUndefined();
    expect(resolvePublicThreadId({
      INTERPRETER_PUBLIC_THREAD_ID: 'thread id with spaces',
    }, () => 'ignored')).toBeUndefined();
  });
});
