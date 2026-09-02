import { describe, expect, test } from 'bun:test';
import {
  paginateThreadTurns,
  parseThreadHistoryLimit,
} from './threadHistoryPagination';

const turns = Array.from({ length: 8 }, (_, index) => ({ id: `turn-${index + 1}` }));

describe('thread history pagination', () => {
  test('returns the newest page and a cursor for older turns', () => {
    expect(paginateThreadTurns(turns, { limit: 3 })).toEqual({
      turns: [{ id: 'turn-6' }, { id: 'turn-7' }, { id: 'turn-8' }],
      nextCursor: 'turn-6',
      hasMore: true,
    });
  });

  test('uses the first visible turn as an exclusive cursor', () => {
    expect(paginateThreadTurns(turns, { limit: 3, before: 'turn-6' })).toEqual({
      turns: [{ id: 'turn-3' }, { id: 'turn-4' }, { id: 'turn-5' }],
      nextCursor: 'turn-3',
      hasMore: true,
    });
  });

  test('clamps malformed and excessive page sizes', () => {
    expect(parseThreadHistoryLimit(undefined)).toBeNull();
    expect(parseThreadHistoryLimit('nope')).toBe(24);
    expect(parseThreadHistoryLimit('0')).toBe(1);
    expect(parseThreadHistoryLimit('1000')).toBe(100);
  });
});
