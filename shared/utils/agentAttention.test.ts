import { describe, expect, test } from 'bun:test';
import { computeUnreadCount, getAgentIndicatorTone } from './agentAttention';

describe('getAgentIndicatorTone', () => {
  test('prioritizes pending approvals over all other states', () => {
    expect(getAgentIndicatorTone({
      hasPendingApproval: true,
      isRunning: true,
      unreadCount: 3,
    })).toBe('attention');
  });

  test('returns running when agent is active without pending approvals', () => {
    expect(getAgentIndicatorTone({
      hasPendingApproval: false,
      isRunning: true,
      unreadCount: 0,
    })).toBe('running');
  });

  test('returns unread when hidden messages are waiting', () => {
    expect(getAgentIndicatorTone({
      hasPendingApproval: false,
      isRunning: false,
      unreadCount: 2,
    })).toBe('unread');
  });

  test('falls back to idle when there is no attention state', () => {
    expect(getAgentIndicatorTone({
      hasPendingApproval: false,
      isRunning: false,
      unreadCount: 0,
    })).toBe('idle');
  });
});

describe('computeUnreadCount', () => {
  test('does not mark initial history load as unread', () => {
    expect(computeUnreadCount({
      hasInitialized: false,
      previousMessageCount: 0,
      nextMessageCount: 12,
      previousUnreadCount: 0,
      isVisible: false,
    })).toBe(0);
  });

  test('increments unread count when hidden thread receives new messages', () => {
    expect(computeUnreadCount({
      hasInitialized: true,
      previousMessageCount: 4,
      nextMessageCount: 6,
      previousUnreadCount: 1,
      isVisible: false,
    })).toBe(3);
  });

  test('clears unread count when thread is visible', () => {
    expect(computeUnreadCount({
      hasInitialized: true,
      previousMessageCount: 4,
      nextMessageCount: 5,
      previousUnreadCount: 2,
      isVisible: true,
    })).toBe(0);
  });

  test('resets unread count when message history shrinks', () => {
    expect(computeUnreadCount({
      hasInitialized: true,
      previousMessageCount: 5,
      nextMessageCount: 1,
      previousUnreadCount: 4,
      isVisible: false,
    })).toBe(0);
  });
});
