import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ipc', () => ({ getAppServerOrigin: async () => 'http://127.0.0.1:5177', isBrowserDevMode: () => false }));
vi.mock('../InboxSetupWhatsApp', () => ({ InboxSetupWhatsApp: ({ onConnected }: { onConnected: () => void }) => <button onClick={onConnected}>Complete pairing</button> }));
import { SimpleChannelsSettings } from './SimpleChannelsSettings';

describe('Simple durable conversation channels', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('shows no thread before first message, then binds exactly that existing thread', async () => {
    let bound: string | null = null;
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === 'PUT') {
        bound = JSON.parse(String(options.body)).threadId;
        return { ok: true, json: async () => ({ threadId: bound }) };
      }
      return { ok: true, json: async () => ({ threadId: bound, configured: true, connected: true, accountMatches: !!bound }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const rendered = render(<SimpleChannelsSettings threadId={null} />);
    expect(await screen.findByText(/Send your first message/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Bind this thread' })).toBeNull();
    rendered.rerender(<SimpleChannelsSettings threadId="thread-existing" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bind this thread' }));
    await waitFor(() => expect(screen.getByText(/Connected · wakes this conversation/)).toBeVisible());
    expect(bound).toBe('thread-existing');
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:5177/api/servers/whatsapp/thread-binding',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }));
  });

  it('retains the prior connection on failed binding and shows actionable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => options.method === 'PUT'
      ? { ok: false, json: async () => ({ error: 'Start the conversation before connecting WhatsApp.' }) }
      : { ok: true, json: async () => ({ threadId: null, configured: true, connected: true, accountMatches: false }) }));
    render(<SimpleChannelsSettings threadId="thread-unknown" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bind this thread' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Start the conversation before connecting WhatsApp.');
    expect(screen.getByText(/choose a conversation to wake/)).toBeVisible();
  });

  it('offers reconnect for a persisted account with an interrupted socket', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ threadId: null, configured: true, connected: false, accountMatches: false }) })));
    render(<SimpleChannelsSettings threadId="thread-existing" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect(screen.getByRole('button', { name: 'Complete pairing' })).toBeVisible();
  });
});
