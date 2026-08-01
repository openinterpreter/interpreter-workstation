import { describe, test, expect, beforeEach } from 'bun:test';
import { messageQueueStore } from './messageQueueStore';

beforeEach(() => {
  messageQueueStore.clear('a1');
  messageQueueStore.clear('a2');
});

describe('messageQueueStore', () => {
  test('add stores first message', () => {
    messageQueueStore.add('a1', 'hello');

    expect(messageQueueStore.peek('a1')).toBe('hello');
  });

  test('add appends subsequent messages with newline', () => {
    messageQueueStore.add('a1', 'first');
    messageQueueStore.add('a1', 'second');

    expect(messageQueueStore.peek('a1')).toBe('first\nsecond');
  });

  test('getAndClear returns text and clears', () => {
    messageQueueStore.add('a1', 'msg');

    const result = messageQueueStore.getAndClear('a1');

    expect(result).toBe('msg');
    expect(messageQueueStore.hasQueue('a1')).toBe(false);
  });

  test('getAndClear returns null for empty queue', () => {
    expect(messageQueueStore.getAndClear('a1')).toBeNull();
  });

  test('peek returns without clearing', () => {
    messageQueueStore.add('a1', 'sticky');

    const peeked = messageQueueStore.peek('a1');

    expect(peeked).toBe('sticky');
    expect(messageQueueStore.hasQueue('a1')).toBe(true);
  });

  test('clear removes queue', () => {
    messageQueueStore.add('a1', 'doomed');

    messageQueueStore.clear('a1');

    expect(messageQueueStore.hasQueue('a1')).toBe(false);
  });

  test('hasQueue returns correct boolean', () => {
    expect(messageQueueStore.hasQueue('a1')).toBe(false);

    messageQueueStore.add('a1', 'x');

    expect(messageQueueStore.hasQueue('a1')).toBe(true);
  });

  test('agents have independent queues', () => {
    messageQueueStore.add('a1', 'for-a1');
    messageQueueStore.add('a2', 'for-a2');

    messageQueueStore.clear('a1');

    expect(messageQueueStore.hasQueue('a1')).toBe(false);
    expect(messageQueueStore.peek('a2')).toBe('for-a2');
  });
});
