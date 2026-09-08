import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { v2 } from '../../server/handlers/codex-generated-types';

vi.mock('../../src/ipc', () => ({
  getApiUrl: vi.fn(async (path: string) => path),
}));

function goal(overrides: Partial<v2.ThreadGoal> = {}): v2.ThreadGoal {
  return {
    threadId: 'thread-one',
    objective: 'Finish the durable work',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('ThreadGoalBar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('does not render a top-level create-goal prompt when no goal exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ goal: null })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    render(<ThreadGoalBar threadId="thread-one" />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Set a goal for this thread' })).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/threads/thread-one/goal',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  test('shows Goal state without mutation controls in read-only mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ goal: goal({ status: 'paused' }) })),
    ));

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    render(<ThreadGoalBar threadId="thread-one" readOnly />);

    expect(await screen.findByText('Finish the durable work')).toBeVisible();
    expect(screen.getByLabelText('Goal paused')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Resume goal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit goal' })).not.toBeInTheDocument();
  });
});
