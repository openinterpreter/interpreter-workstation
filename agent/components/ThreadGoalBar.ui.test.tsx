import { act, render, screen, waitFor } from '@testing-library/react';
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

  test('distinguishes an unavailable native Goal from a thread without a Goal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ goal: null, available: false })));
    vi.stubGlobal('fetch', fetchMock);

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    render(<ThreadGoalBar threadId="thread-one" />);

    expect(await screen.findByRole('status')).toHaveTextContent('Native Goal controls are unavailable on this host.');
    expect(screen.queryByRole('button', { name: /goal/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('shows a bounded unavailable state rather than interpreting a failed native read as no Goal', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('private upstream failure', { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ goal: goal() })));
    vi.stubGlobal('fetch', fetchMock);

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    render(<ThreadGoalBar threadId="thread-one" />);

    expect(await screen.findByRole('status')).toHaveTextContent('Native Goal controls are unavailable on this host.');
    expect(screen.queryByText('private upstream failure')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /goal/i })).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('thread-goal:updated', { detail: { threadId: 'thread-one' } }));
    expect(await screen.findByText('Finish the durable work')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('ignores a late Goal read from a previously selected thread', async () => {
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ goal: goal({ threadId: 'thread-two', objective: 'New owner' }) })));
    vi.stubGlobal('fetch', fetchMock);

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    const view = render(<ThreadGoalBar threadId="thread-one" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(<ThreadGoalBar threadId="thread-two" />);
    expect(await screen.findByText('New owner')).toBeVisible();

    await act(async () => resolveOld(new Response(JSON.stringify({ goal: goal({ objective: 'Old owner' }) }))));
    expect(screen.getByText('New owner')).toBeVisible();
    expect(screen.queryByText('Old owner')).not.toBeInTheDocument();
  });

  test('hides the previous thread Goal immediately while the next owner loads', async () => {
    let resolveNext!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ goal: goal({ objective: 'Previous objective' }) })))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveNext = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    const view = render(<ThreadGoalBar threadId="thread-one" />);
    expect(await screen.findByText('Previous objective')).toBeVisible();
    view.rerender(<ThreadGoalBar threadId="thread-two" />);
    expect(screen.queryByText('Previous objective')).not.toBeInTheDocument();
    expect(screen.getByText('Loading goal')).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => resolveNext(new Response(JSON.stringify({ goal: goal({ threadId: 'thread-two' }) }))));
    expect(await screen.findByText('Finish the durable work')).toBeVisible();
  });

  test('does not display a Goal whose native owner differs from the selected thread', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      goal: goal({ threadId: 'thread-two', objective: 'Another owner' }),
    }))));

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    render(<ThreadGoalBar threadId="thread-one" />);

    expect(await screen.findByRole('status')).toHaveTextContent('Native Goal controls are unavailable on this host.');
    expect(screen.queryByText('Another owner')).not.toBeInTheDocument();
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

  test('does not render private upstream error text from a rejected Goal update', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ goal: goal() })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'private native provider detail' }), { status: 503 })));

    const { ThreadGoalBar } = await import('./ThreadGoalBar');
    render(<ThreadGoalBar threadId="thread-one" />);
    const edit = await screen.findByRole('button', { name: 'Edit goal' });
    await act(async () => edit.click());
    const save = screen.getByRole('button', { name: 'Save goal' });
    await act(async () => save.click());

    expect(await screen.findByText(/Native Goal update was not accepted/)).toBeVisible();
    expect(screen.queryByText(/private native provider detail/)).not.toBeInTheDocument();
  });
});
