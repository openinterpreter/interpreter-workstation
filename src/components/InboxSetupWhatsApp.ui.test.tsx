import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { InboxSetupWhatsApp } from './InboxSetupWhatsApp';

const ipcMocks = vi.hoisted(() => ({
  getAppServerOrigin: vi.fn(async () => 'http://127.0.0.1:5177'),
  isBrowserDevMode: vi.fn(() => false),
}));

const telemetryMocks = vi.hoisted(() => ({
  trackInboxSetupCancelled: vi.fn(),
  trackInboxSetupCompleted: vi.fn(),
  trackInboxSetupFailed: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  getAppServerOrigin: ipcMocks.getAppServerOrigin,
  isBrowserDevMode: ipcMocks.isBrowserDevMode,
}));

vi.mock('../utils/telemetry', () => telemetryMocks);

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = MockEventSource.OPEN;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  dispatch(type: string, data: unknown = {}) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('InboxSetupWhatsApp', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('renders the streamed QR code after setup starts', async () => {
    render(<InboxSetupWhatsApp onConnected={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5177/api/servers/whatsapp/setup',
      { method: 'POST' },
    );
    expect(MockEventSource.instances[0].url).toBe('http://127.0.0.1:5177/api/servers/whatsapp/setup/qr-stream');

    act(() => {
      MockEventSource.instances[0].dispatch('qr', { qrCode: 'data:image/png;base64,qr' });
    });

    const qrCode = await screen.findByRole('img', { name: 'WhatsApp QR Code' });
    expect(qrCode).toHaveAttribute('src', 'data:image/png;base64,qr');
    expect(screen.queryByText(/WhatsApp connection failed/i)).not.toBeInTheDocument();
  });

  test('shows non-retryable disconnect messages from the QR stream', async () => {
    render(<InboxSetupWhatsApp onConnected={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    act(() => {
      MockEventSource.instances[0].dispatch('disconnected', {
        configured: false,
        status: 408,
        isLoggedOut: false,
        message: 'WhatsApp connection failed: Opening handshake has timed out',
      });
    });

    expect(await screen.findByText('WhatsApp connection failed: Opening handshake has timed out')).toBeInTheDocument();
    expect(screen.queryByText('Generating QR code')).not.toBeInTheDocument();
    expect(telemetryMocks.trackInboxSetupFailed).toHaveBeenCalledWith({
      channel: 'whatsapp',
      error: 'WhatsApp connection failed: Opening handshake has timed out',
      stage: 'disconnected',
    });
  });
});
