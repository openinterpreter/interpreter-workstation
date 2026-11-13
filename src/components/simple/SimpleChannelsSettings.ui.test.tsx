import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));
vi.mock('@/ipc', () => ({ apiRequest: apiRequestMock }));
vi.mock('../InboxSetupWhatsApp', () => ({ InboxSetupWhatsApp: ({ onConnected }: { onConnected: () => void }) => <button onClick={onConnected}>Complete pairing</button> }));
import { SimpleChannelsSettings } from './SimpleChannelsSettings';

describe('Simple durable conversation channels', () => {
  beforeEach(() => { vi.unstubAllGlobals(); apiRequestMock.mockReset(); });

  it('shows no thread before first message, then binds exactly that existing thread', async () => {
    let bound: string | null = null;
    apiRequestMock.mockImplementation(async (request: { method: string; body?: { threadId: string } }) => {
      if (request.method === 'PUT') {
        bound = request.body?.threadId ?? null;
        return { ok: true, status: 200, data: { threadId: bound } };
      }
      return { ok: true, status: 200, data: { threadId: bound, configured: true, connected: true, accountMatches: !!bound } };
    });
    const rendered = render(<SimpleChannelsSettings threadId={null} />);
    expect(await screen.findByText(/Send your first message/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Bind this thread' })).toBeNull();
    rendered.rerender(<SimpleChannelsSettings threadId="thread-existing" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bind this thread' }));
    await waitFor(() => expect(screen.getByText(/Connected · wakes this conversation/)).toBeVisible());
    expect(bound).toBe('thread-existing');
    expect(apiRequestMock).toHaveBeenCalledWith({ method: 'PUT', path: '/api/servers/whatsapp/thread-binding',
      body: { threadId: 'thread-existing' } });
  });

  it('retains the prior connection on failed binding and shows actionable error', async () => {
    apiRequestMock.mockImplementation(async (request: { method: string }) => request.method === 'PUT'
      ? { ok: false, status: 400, data: { error: 'Start the conversation before connecting WhatsApp.' } }
      : { ok: true, status: 200, data: { threadId: null, configured: true, connected: true, accountMatches: false } });
    render(<SimpleChannelsSettings threadId="thread-unknown" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bind this thread' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Start the conversation before connecting WhatsApp.');
    expect(screen.getByText(/choose a conversation to wake/)).toBeVisible();
  });

  it('offers reconnect for a persisted account with an interrupted socket', async () => {
    apiRequestMock.mockResolvedValue({ ok: true, status: 200,
      data: { threadId: null, configured: true, connected: false, accountMatches: false } });
    render(<SimpleChannelsSettings threadId="thread-existing" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    expect(screen.getByRole('button', { name: 'Complete pairing' })).toBeVisible();
  });
});
