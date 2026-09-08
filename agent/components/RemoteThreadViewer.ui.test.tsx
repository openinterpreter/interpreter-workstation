import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PublicThreadSnapshot } from '../../shared/types/publicThread';
import { resolvePublicArtifactLinks } from './RemoteThreadViewer';

vi.mock('./prompt-kit/thread-messages', () => ({
  ThreadMessages: ({ hasOlderHistory }: { hasOlderHistory: boolean }) => (
    <div
      data-testid="chat-scroll"
      data-chat-scroll-container="true"
      data-generic-history-loader={String(hasOlderHistory)}
    />
  ),
}));

function snapshot(
  nextCursor: string | null,
  goal: PublicThreadSnapshot['goal'] = null,
): PublicThreadSnapshot {
  return {
    schemaVersion: 1,
    threadId: 'thread-one',
    title: 'Remote conversation',
    status: 'working',
    goal,
    messages: [],
    page: {
      hasMore: Boolean(nextCursor),
      nextCursor,
    },
    eventCursor: null,
    updatedAt: Date.now(),
  };
}

describe('RemoteThreadViewer history gestures', () => {
  test('resolves public file links into the remote workspace namespace', () => {
    expect(resolvePublicArtifactLinks(
      '[English PDF](file?path=papers%2F00295%2Fenglish.pdf)',
    )).toBe('[English PDF](/workspace/papers/00295/english.pdf)');
  });

  test('does not turn traversal paths into workspace links', () => {
    expect(resolvePublicArtifactLinks(
      '[Private file](file?path=..%2Fprivate.txt)',
    )).toBe('[Private file]()');
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot('cursor-two'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot('cursor-one'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot(null)))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('each upward gesture can fetch another page while history is shorter than the viewport', async () => {
    const { RemoteThreadViewer } = await import('./RemoteThreadViewer');
    const onTitleChange = vi.fn();
    render(
      <RemoteThreadViewer
        endpoint="https://example.test/api/connection"
        embedded
        onTitleChange={onTitleChange}
      />,
    );

    await screen.findByTestId('chat-scroll');
    await waitFor(() => expect(screen.getByTestId('chat-scroll').parentElement).toBeVisible());
    expect(onTitleChange).toHaveBeenCalledWith('Remote conversation');
    expect(screen.getByTestId('chat-scroll')).toHaveAttribute('data-generic-history-loader', 'false');

    fireEvent.wheel(screen.getByTestId('chat-scroll'), { deltaY: -500 });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain('before=cursor-two');

    fireEvent.wheel(screen.getByTestId('chat-scroll'), { deltaY: -500 });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    expect(String(vi.mocked(fetch).mock.calls[2]?.[0])).toContain('before=cursor-one');
    expect(screen.getByTestId('chat-scroll')).toHaveAttribute('data-generic-history-loader', 'false');
  });

  test('places a read-only Goal card at the bottom accessory edge', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(snapshot(null, {
      objective: 'Keep the published transcript tidy',
      status: 'active',
      updatedAt: Date.now(),
    }))));

    const { RemoteThreadViewer } = await import('./RemoteThreadViewer');
    render(
      <RemoteThreadViewer
        endpoint="https://example.test/api/connection"
        embedded
      />,
    );

    const goal = await screen.findByText('Keep the published transcript tidy');
    expect(goal.closest('[data-thread-accessory-stack-host]')).not.toBeNull();
    expect(document.querySelector('[data-thread-accessory-stack]')).toContainElement(goal);
    expect(screen.queryByText('Set a goal for this thread')).not.toBeInTheDocument();
  });
});
