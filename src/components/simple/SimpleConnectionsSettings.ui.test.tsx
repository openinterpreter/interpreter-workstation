import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  configure: vi.fn(),
  clearCredential: vi.fn(),
  workstationFetch: vi.fn(),
  saveWorkstationAccessToken: vi.fn(),
  createWindow: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  simpleLive: mocks,
}));
vi.mock('../settings/InboxSection', () => ({
  InboxSectionContent: () => <div>WhatsApp account setup</div>,
}));
vi.mock('@/remote/workstationConnection', () => ({
  workstationFetch: mocks.workstationFetch,
  saveWorkstationAccessToken: mocks.saveWorkstationAccessToken,
}));

import { SimpleConnectionsSettings } from './SimpleConnectionsSettings';

describe('Simple connections settings', () => {
  beforeEach(() => {
    mocks.status.mockReset().mockResolvedValue({ configured: false, source: 'none' });
    mocks.configure.mockReset().mockResolvedValue({ configured: true, source: 'secure' });
    mocks.clearCredential.mockReset().mockResolvedValue({ configured: false, source: 'none' });
    mocks.saveWorkstationAccessToken.mockReset();
    mocks.createWindow.mockReset().mockResolvedValue({ success: true, windowId: 2, sessionKey: 'remote' });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { window: { create: mocks.createWindow } },
    });
    mocks.workstationFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({
      installed: true,
      running: true,
      online: true,
      backendState: 'Running',
      hostName: 'studio',
      dnsName: 'studio.example.ts.net',
      endpoint: 'https://studio.example.ts.net',
      ips: ['100.64.0.1'],
      error: null,
      enabled: false,
    }), { status: 200 }));
  });

  test('saves a GPT Live key without rendering it back and keeps WhatsApp setup available', async () => {
    const user = userEvent.setup();
    render(<SimpleConnectionsSettings />);

    const input = await screen.findByLabelText('OpenAI API key');
    await user.type(input, 'sk-private');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.configure).toHaveBeenCalledWith({ apiKey: 'sk-private' });
    expect(await screen.findByText('WhatsApp account setup')).toBeVisible();
    expect(screen.queryByText('sk-private')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Open another Workstation')).toBeVisible();
  });

  test('redeems a pairing code and opens the remote project in its own window', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      endpoint: 'https://studio.example.ts.net',
      accessToken: 'paired-session',
      expiresAt: '2026-10-02T00:00:00.000Z',
      access: 'read-write',
    }), { status: 200 }));
    render(<SimpleConnectionsSettings />);

    fireEvent.change(screen.getByLabelText('Open another Workstation'), { target: { value: JSON.stringify({
      schemaVersion: 1,
      endpoint: 'https://studio.example.ts.net',
      pairingToken: 'one-time-token',
    }) } });
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(mocks.saveWorkstationAccessToken).toHaveBeenCalledWith(
      'https://studio.example.ts.net',
      'read-write',
      'paired-session',
    );
    expect(mocks.createWindow).toHaveBeenCalledWith({
      remoteConnection: {
        endpoint: 'https://studio.example.ts.net',
        access: 'read-write',
        authentication: 'pairing',
      },
    });
  });
});
