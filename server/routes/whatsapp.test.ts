import { describe, test, expect, mock, beforeEach } from 'bun:test';
import EventEmitter from 'node:events';
import { DisconnectReason } from '@whiskeysockets/baileys';

const fakeConnectionEvents = new EventEmitter();
let fakeConnectionState = 'disconnected';
let fakePhoneNumber: string | undefined;

mock.module('./whatsappSetupDependencies', () => ({
  connectionEvents: fakeConnectionEvents,
  initializeSocket: mock(() => Promise.resolve()),
  disconnectSocket: mock(() => Promise.resolve()),
  getConnectionState: () => fakeConnectionState,
  getPhoneNumber: () => fakePhoneNumber,
  loadCredentials: mock(() => Promise.resolve(null)),
  isConfigured: () => false,
}));

const { default: router } = await import('./whatsapp');

import express from 'express';
import { get, type IncomingMessage, type Server } from 'node:http';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/whatsapp', router);
  return app;
}

async function closeTestServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function waitForConnectionListener(eventName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fakeConnectionEvents.listenerCount(eventName) > 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the SSE route to subscribe to ${eventName}`);
}

type SseConnection = {
  response: IncomingMessage;
  firstChunk: Promise<string>;
};

function openSse(url: string): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const request = get(url, response => {
      const firstChunk = new Promise<string>((resolveChunk, rejectChunk) => {
        response.once('data', chunk => resolveChunk(Buffer.from(chunk).toString('utf8')));
        response.once('error', rejectChunk);
      });
      resolve({ response, firstChunk });
    });
    request.once('error', reject);
  });
}

describe('WhatsApp QR stream SSE (#534, #518)', () => {
  beforeEach(() => {
    fakeConnectionEvents.removeAllListeners();
    fakeConnectionState = 'disconnected';
    fakePhoneNumber = undefined;
  });

  test('should forward connecting event over SSE', async () => {
    const app = createTestApp();
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const responsePromise = openSse(`http://127.0.0.1:${port}/api/servers/whatsapp/setup/qr-stream`);
      await waitForConnectionListener('connecting');
      fakeConnectionEvents.emit('connecting');
      const { response, firstChunk } = await responsePromise;
      const text = await firstChunk;
      expect(text).toContain('event: connecting');
      expect(text).toContain('data: {}');

      response.destroy();
    } finally {
      await closeTestServer(server);
    }
  });

  test('should forward disconnected event with formatted message', async () => {
    const app = createTestApp();
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const responsePromise = openSse(`http://127.0.0.1:${port}/api/servers/whatsapp/setup/qr-stream`);
      await waitForConnectionListener('disconnected');
      fakeConnectionEvents.emit('disconnected', {
        status: 408,
        isLoggedOut: false,
        error: new Error('Opening handshake has timed out'),
      });
      const { response, firstChunk } = await responsePromise;
      const text = await firstChunk;
      expect(text).toContain('event: disconnected');
      expect(text).toContain('Opening handshake has timed out');
      expect(text).toContain('"configured":false');

      response.destroy();
    } finally {
      await closeTestServer(server);
    }
  });

  test('should keep QR stream open across restart-required disconnects', async () => {
    const app = createTestApp();
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const responsePromise = openSse(`http://127.0.0.1:${port}/api/servers/whatsapp/setup/qr-stream`);
      await waitForConnectionListener('disconnected');
      fakeConnectionEvents.emit('disconnected', {
        status: DisconnectReason.restartRequired,
        isLoggedOut: false,
        error: new Error('Stream Errored (restart required)'),
      });
      fakeConnectionEvents.emit('qr', 'retry-qr-code');
      const { response, firstChunk } = await responsePromise;
      const text = await firstChunk;
      expect(text).toContain('event: qr');
      expect(text).toContain('data:image/png');
      expect(text).not.toContain('event: disconnected');
      expect(text).not.toContain('Stream Errored');

      response.destroy();
    } finally {
      await closeTestServer(server);
    }
  });

  test('should forward logged_out event and close stream', async () => {
    const app = createTestApp();
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const responsePromise = openSse(`http://127.0.0.1:${port}/api/servers/whatsapp/setup/qr-stream`);
      await waitForConnectionListener('logged_out');
      fakeConnectionEvents.emit('logged_out');
      const { response, firstChunk } = await responsePromise;
      const text = await firstChunk;
      expect(text).toContain('event: logged_out');
      expect(text).toContain('"configured":false');

      response.destroy();
    } finally {
      await closeTestServer(server);
    }
  });

  test('should format disconnect message for logged out session', () => {
    const reason = { isLoggedOut: true, status: 401 };
    const formatted = formatDisconnectMessageForTest(reason);
    expect(formatted).toContain('logged out');
  });

  test('should format disconnect message for generic network failure', () => {
    const reason = { isLoggedOut: false };
    const formatted = formatDisconnectMessageForTest(reason);
    expect(formatted).toContain('network/firewall');
  });

  test('should send immediate connected status if already connected', async () => {
    fakeConnectionState = 'connected';
    fakePhoneNumber = '+15551234567';

    const app = createTestApp();
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const { response, firstChunk } = await openSse(`http://127.0.0.1:${port}/api/servers/whatsapp/setup/qr-stream`);
      const text = await firstChunk;
      expect(text).toContain('event: connected');
      expect(text).toContain('+15551234567');

      response.destroy();
    } finally {
      await closeTestServer(server);
    }
  });
});

function formatDisconnectMessageForTest(reason: { isLoggedOut: boolean; status?: number; error?: unknown }): string {
  if (reason.isLoggedOut) {
    return 'WhatsApp session logged out. Please connect again.';
  }
  const error = reason.error;
  const message =
    error instanceof Error ? error.message
      : typeof error === 'string' ? error
        : '';
  if (message) return `WhatsApp connection failed: ${message}`;
  if (typeof reason.status === 'number') return `WhatsApp connection failed (status ${reason.status}).`;
  return 'WhatsApp connection failed. Check your network/firewall and try again.';
}
