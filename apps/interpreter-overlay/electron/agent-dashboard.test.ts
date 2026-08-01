import { describe, expect, test } from 'bun:test';
import type { AgentWindowBindingSnapshot } from '../../../server/agentTabManager';
import { buildOverlayRunningAgents } from './agent-dashboard';

function binding(overrides: Partial<AgentWindowBindingSnapshot> = {}): AgentWindowBindingSnapshot {
  return {
    agentId: 'agent-1',
    threadId: 'thread-1',
    windowSessionKey: 'window-1',
    workspacePath: '/workspace',
    activity: {
      label: 'Reading form',
      isRunning: true,
      messageCount: 4,
      unreadCount: 1,
      lastMessagePreview: 'Checking fields',
      updatedAt: '2026-06-21T10:00:00.000Z',
    },
    ...overrides,
  };
}

describe('buildOverlayRunningAgents', () => {
  test('projects only safe running-agent dashboard fields', () => {
    const agents = buildOverlayRunningAgents([
      binding(),
      binding({
        agentId: 'agent-idle',
        activity: {
          label: 'Idle agent',
          isRunning: false,
          messageCount: 1,
          unreadCount: 0,
          lastMessagePreview: 'Done',
          updatedAt: '2026-06-21T09:00:00.000Z',
        },
      }),
    ]);

    expect(agents).toEqual([{
      agentId: 'agent-1',
      threadId: 'thread-1',
      windowSessionKey: 'window-1',
      workspacePath: '/workspace',
      label: 'Reading form',
      latestAction: 'Checking fields',
      unreadCount: 1,
      updatedAt: '2026-06-21T10:00:00.000Z',
    }]);
    expect(JSON.stringify(agents)).not.toContain('callerToken');
    expect(JSON.stringify(agents)).not.toContain('systemPrompt');
  });

  test('sorts newest running agents first and falls back to the agent id label', () => {
    const agents = buildOverlayRunningAgents([
      binding({
        agentId: 'agent-old',
        activity: {
          label: '',
          isRunning: true,
          messageCount: 1,
          unreadCount: 0,
          lastMessagePreview: '',
          updatedAt: '2026-06-21T09:00:00.000Z',
        },
      }),
      binding({
        agentId: 'agent-new',
        activity: {
          label: 'Writing tests',
          isRunning: true,
          messageCount: 2,
          unreadCount: 0,
          lastMessagePreview: 'Running vitest',
          updatedAt: '2026-06-21T11:00:00.000Z',
        },
      }),
    ]);

    expect(agents.map((agent) => agent.agentId)).toEqual(['agent-new', 'agent-old']);
    expect(agents[1]?.label).toBe('agent-old');
    expect(agents[1]?.latestAction).toBeNull();
  });
});
