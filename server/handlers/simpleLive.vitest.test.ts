import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { getDefaultProfile, getAllProviders } = vi.hoisted(() => ({
  getDefaultProfile: vi.fn(),
  getAllProviders: vi.fn(),
}));

vi.mock('../configStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../configStore')>(),
  getDefaultProfile,
  getAllProviders,
}));

import { createSimpleLiveSession, getSimpleLiveStatus } from './simpleLive';

describe('Simple GPT Live', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    getDefaultProfile.mockReset().mockResolvedValue(null);
    getAllProviders.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  test('reports configuration without exposing the key', async () => {
    process.env.OPENAI_API_KEY = 'secret';
    await expect(getSimpleLiveStatus()).resolves.toEqual({ configured: true, source: 'environment' });
  });

  test('prefers the encrypted desktop credential without returning it', async () => {
    process.env.OPENAI_API_KEY = 'environment-secret';
    await expect(getSimpleLiveStatus({ secureApiKey: 'desktop-secret' }))
      .resolves.toEqual({ configured: true, source: 'secure' });
  });

  test('creates a client-delegated gpt-live-1 WebRTC session', async () => {
    process.env.OPENAI_API_KEY = 'secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'live-session' },
      transport: { type: 'webrtc', sdp: 'answer-sdp' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const history = [{
      type: 'message' as const,
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text: 'Continue the durable task.' }],
    }];
    await expect(createSimpleLiveSession(
      { offerSdp: 'v=0\r\na=offer-with-enough-content' },
      { history },
    ))
      .resolves.toEqual({ answerSdp: 'answer-sdp', sessionId: 'live-session' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      session: { model: 'gpt-live-1', delegation: { type: 'client' }, input: history },
      transport: { type: 'webrtc' },
    });
  });

  test('uses the encrypted desktop credential only on the server request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      session: { id: 'secure-live-session' },
      transport: { type: 'webrtc', sdp: 'secure-answer' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await createSimpleLiveSession(
      { offerSdp: 'v=0\r\na=offer-with-enough-content' },
      { secureApiKey: 'desktop-secret', history: [] },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer desktop-secret' });
    expect(String(init?.body)).not.toContain('desktop-secret');
  });

  test('fails closed when no OpenAI key is configured', async () => {
    await expect(createSimpleLiveSession({ offerSdp: 'v=0\r\na=offer-with-enough-content' }, { history: [] }))
      .rejects.toThrow('needs an OpenAI API key');
  });

  test('explains when the configured key has no available quota', async () => {
    process.env.OPENAI_API_KEY = 'secret';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

    await expect(createSimpleLiveSession({ offerSdp: 'v=0\r\na=offer-with-enough-content' }, { history: [] }))
      .rejects.toThrow('no available quota (429)');
  });
});
