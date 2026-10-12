import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setAdvancedMode } = vi.hoisted(() => ({ setAdvancedMode: vi.fn(async () => ({ success: true })) }));
vi.mock('@/ipc', () => ({ getApiUrl: async (path: string) => path, uiSettings: { setAdvancedMode } }));
vi.mock('../../../agent/components/ThreadWakeSources', () => ({ ThreadWakeSources: ({ threadId }: { threadId: string }) => <p>Wake methods for {threadId}</p> }));
vi.mock('../simple/SimpleChannelsSettings', () => ({ SimpleChannelsSettings: ({ threadId }: { threadId: string }) => <p>Channel binding for {threadId}</p> }));
import { DurableThreadsSectionContent } from './DurableThreadsSection';

describe('Advanced durable threads settings', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('offers a deliberate way from an empty Advanced list into the durable composer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [], nextCursor: null }) })));
    render(<DurableThreadsSectionContent />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create conversation in Simple' }));
    expect(setAdvancedMode).toHaveBeenCalledWith(false);
  });

  it('selects an actual listed thread and exposes channel and wake management only for it', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'thread-one', preview: 'A useful interface' }], nextCursor: null }) }));
    vi.stubGlobal('fetch', fetcher);
    render(<DurableThreadsSectionContent />);
    expect(await screen.findByRole('button', { name: 'A useful interface' })).toBeVisible();
    expect(screen.queryByText(/Channel binding for/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'A useful interface' }));
    expect(screen.getByText('Channel binding for thread-one')).toBeVisible();
    expect(screen.getByText('Wake methods for thread-one')).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith('/api/agent/threads', { credentials: 'include' });
  });

  it('fails visibly on an incomplete response instead of offering arbitrary thread IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ nextCursor: null }) })));
    render(<DurableThreadsSectionContent />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Conversation list is unavailable.');
    expect(screen.queryByRole('button', { name: /Conversation thread/ })).toBeNull();
  });

  it('loads a complete paginated list before selecting a later conversation', async () => {
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('cursor=next')
      ? { data: [{ id: 'thread-two', preview: 'The second conversation' }], nextCursor: null }
      : { data: [{ id: 'thread-one', preview: 'The first conversation' }], nextCursor: 'next' } }));
    vi.stubGlobal('fetch', fetcher);
    render(<DurableThreadsSectionContent />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await userEvent.click(await screen.findByRole('button', { name: 'The second conversation' }));
    expect(screen.getByText('Channel binding for thread-two')).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith('/api/agent/threads?cursor=next', { credentials: 'include' });
  });
});
