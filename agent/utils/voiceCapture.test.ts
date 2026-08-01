import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { QwenStreamingCaptureSession, VoiceCaptureSession } from './voiceCapture';

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 0;
  smoothingTimeConstant = 0;

  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(0);
  }
}

class FakeAudioContext {
  readonly destination = {};
  readonly sampleRate = 48000;

  async resume(): Promise<void> {}
  createMediaStreamSource(): FakeAudioNode { return new FakeAudioNode(); }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
  createScriptProcessor(): FakeAudioNode & { onaudioprocess: ((event: AudioProcessingEvent) => void) | null } {
    return {
      onaudioprocess: null,
      connect(): void {},
      disconnect(): void {},
    };
  }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  async close(): Promise<void> {}
}

const getUserMediaMock = mock(async () => ({
  getTracks: () => [{ stop() {} }],
}) as unknown as MediaStream);

describe('voice capture microphone startup', () => {
  beforeEach(() => {
    getUserMediaMock.mockClear();
    globalThis.navigator = {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    } as Navigator;
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
  });

  test('starts conversational capture with an unconstrained audio request', async () => {
    const session = new VoiceCaptureSession({
      onUtterance: () => {},
    });

    await session.start();
    session.stop();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
  });

  test('starts streaming capture with an unconstrained audio request', async () => {
    const session = new QwenStreamingCaptureSession({
      onPcmChunk: () => {},
    });

    await session.start();
    session.stop();

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
  });
});
