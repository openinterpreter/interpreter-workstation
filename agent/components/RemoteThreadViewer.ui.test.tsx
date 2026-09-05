import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PublicThreadSnapshot } from '../../shared/types/publicThread';

vi.mock('./prompt-kit/thread-messages', () => ({
  ThreadMessages: ({ hasOlderHistory }: { hasOlderHistory: boolean }) => (
    <div
      data-testid="chat-scroll"
      data-chat-scroll-container="true"
      data-generic-history-loader={String(hasOlderHistory)}
    />
  ),
}));

function snapshot(nextCursor: string | null): PublicThreadSnapshot {
  return {
    schemaVersion: 1,
    threadId: 'thread-one',
    title: 'Remote conversation',
    status: 'working',
    goal: null,
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
});
