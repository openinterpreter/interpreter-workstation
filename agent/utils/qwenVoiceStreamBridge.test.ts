import { beforeEach, describe, expect, mock, test } from 'bun:test';

const startVoiceStreamSessionMock = mock(async () => 'session-1');
const appendVoiceStreamChunkMock = mock(async () => ({ text: '', isSpeech: false }));
const abortVoiceStreamSessionMock = mock(async () => {});
const getAdaptiveVoiceSilenceTimeoutMsMock = mock(() => 2000);
const emitVoiceLatencyEventMock = mock(() => {});

mock.module('./voiceCapture', () => ({
  abortVoiceStreamSession: abortVoiceStreamSessionMock,
  appendVoiceStreamChunk: appendVoiceStreamChunkMock,
  getAdaptiveVoiceSilenceTimeoutMs: getAdaptiveVoiceSilenceTimeoutMsMock,
  startVoiceStreamSession: startVoiceStreamSessionMock,
}));

mock.module('./voiceLatency', () => ({
  emitVoiceLatencyEvent: emitVoiceLatencyEventMock,
}));

const { QwenVoiceStreamBridge } = await import('./qwenVoiceStreamBridge');

describe('QwenVoiceStreamBridge', () => {
  beforeEach(() => {
    startVoiceStreamSessionMock.mockClear();
    appendVoiceStreamChunkMock.mockClear();
    abortVoiceStreamSessionMock.mockClear();
    getAdaptiveVoiceSilenceTimeoutMsMock.mockClear();
    emitVoiceLatencyEventMock.mockClear();
    getAdaptiveVoiceSilenceTimeoutMsMock.mockImplementation(() => 2000);
  });

  test('replaces native recognizer transcript revisions instead of re-merging them', async () => {
    const transcripts = [
      {
        isSpeech: true,
        text: "Interpreter I was just kind of interested in I don't know can you tell me what",
      },
      {
        isSpeech: true,
        text: "Interpreter, I was just kind of interested in. I don't know, can you tell me what's",
      },
    ];

    appendVoiceStreamChunkMock.mockImplementation(async () => transcripts.shift() ?? { text: '', isSpeech: false });

    const bridge = new QwenVoiceStreamBridge(undefined, { nativeRecognizer: true });
    const updates: string[] = [];

    await bridge.enqueueChunk(new Uint8Array([1]), (update) => {
      updates.push(update.transcript);
    });
    await bridge.enqueueChunk(new Uint8Array([1]), (update) => {
      updates.push(update.transcript);
    });

    expect(updates).toEqual([
      "Interpreter I was just kind of interested in I don't know can you tell me what",
      "Interpreter, I was just kind of interested in. I don't know, can you tell me what's",
    ]);
  });

  test('still merges revised qwen tail fragments', async () => {
    const transcripts = [
      {
        isSpeech: true,
        text: "Okay, I'm not sure how much you can",
      },
      {
        isSpeech: true,
        text: 'not sure how much you can hear. But what if I say',
      },
    ];

    appendVoiceStreamChunkMock.mockImplementation(async () => transcripts.shift() ?? { text: '', isSpeech: false });

    const bridge = new QwenVoiceStreamBridge();
    const updates: string[] = [];

    await bridge.enqueueChunk(new Uint8Array([1]), (update) => {
      updates.push(update.transcript);
    });
    await bridge.enqueueChunk(new Uint8Array([1]), (update) => {
      updates.push(update.transcript);
    });

    expect(updates).toEqual([
      "Okay, I'm not sure how much you can",
      "Okay, I'm not sure how much you can hear. But what if I say",
    ]);
  });

  test('waitForQueuedChunks resolves only after queued chunk uploads finish', async () => {
    let resolveChunk: ((result: { text: string; isSpeech: boolean }) => void) | null = null;
    appendVoiceStreamChunkMock.mockImplementation(() => new Promise((resolve) => {
      resolveChunk = resolve;
    }));

    const bridge = new QwenVoiceStreamBridge();
    const updates: string[] = [];

    const enqueuePromise = bridge.enqueueChunk(new Uint8Array([1]), (update) => {
      updates.push(update.transcript);
    });

    let drained = false;
    const drainPromise = bridge.waitForQueuedChunks().then(() => {
      drained = true;
    });

    for (let attempt = 0; attempt < 10 && !resolveChunk; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    expect(resolveChunk).not.toBeNull();
    expect(drained).toBe(false);

    resolveChunk?.({ text: 'Interpreter', isSpeech: true });

    await enqueuePromise;
    await drainPromise;

    expect(drained).toBe(true);
    expect(updates).toEqual(['Interpreter']);
  });
});
