/**
 * Server-side Silero VAD service using sherpa-onnx.
 *
 * Each streaming session gets its own Vad instance so speech detection
 * state is isolated. The underlying ONNX model is shared via sherpa-onnx's
 * WASM module (loaded once on first use).
 *
 * Input: Int16 PCM at 16 kHz mono (same format qwen_asr receives).
 * Output: boolean isSpeech (whether speech is currently detected).
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

export interface SileroVadInstance {
  /** Feed Int16 PCM chunk. Returns true if speech is currently detected. */
  feedPcm(pcm16Buffer: Buffer): boolean;
  /** Destroy the instance and free WASM memory. */
  free(): void;
}

let sherpaOnnxModule: any = null;
let sileroModelPath: string | null = null;

function resolveSileroModelPath(): string {
  if (sileroModelPath) return sileroModelPath;

  // Look in several places for silero_vad_v5.onnx
  const candidates = [
    // Bundled in app resources (electron build)
    path.join(process.resourcesPath ?? '', 'silero', 'silero_vad_v5.onnx'),
    // In node_modules (dev mode)
    path.join(__dirname, '../../node_modules/.pnpm/@ricky0123+vad-web@0.0.30/node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
    path.join(__dirname, '../../node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      sileroModelPath = candidate;
      return candidate;
    }
  }

  throw new Error(
    'Silero VAD model (silero_vad_v5.onnx) not found. Checked: ' +
    candidates.join(', ')
  );
}

function getSherpaOnnx(): any {
  if (!sherpaOnnxModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sherpaOnnxModule = require('sherpa-onnx');
  }
  return sherpaOnnxModule;
}

/**
 * Create a new Silero VAD instance for a streaming session.
 *
 * Each instance maintains its own speech detection state.
 * Call free() when the session ends.
 */
export function createSileroVadInstance(): SileroVadInstance {
  const sherpaOnnx = getSherpaOnnx();
  const modelPath = resolveSileroModelPath();

  const vad = sherpaOnnx.createVad({
    sileroVad: {
      model: modelPath,
      threshold: 0.5,
      minSilenceDuration: 0.3,   // 300ms silence to mark end of speech
      minSpeechDuration: 0.1,    // 100ms minimum speech to trigger detection
      windowSize: 512,           // Silero requires exactly 512 samples per frame
      maxSpeechDuration: 600,    // 10 minutes max continuous speech
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 60,
  });

  return {
    feedPcm(pcm16Buffer: Buffer): boolean {
      // Convert Int16 PCM to Float32 (sherpa-onnx VAD expects Float32Array)
      const sampleCount = pcm16Buffer.length / 2;
      const float32 = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        float32[i] = pcm16Buffer.readInt16LE(i * 2) / 32768.0;
      }

      // Feed in windowSize-sized frames (512 samples)
      const WINDOW = 512;
      for (let offset = 0; offset + WINDOW <= float32.length; offset += WINDOW) {
        const frame = float32.subarray(offset, offset + WINDOW);
        vad.acceptWaveform(frame);
      }

      return vad.isDetected();
    },

    free() {
      try {
        vad.free();
      } catch {
        // Ignore errors during cleanup
      }
    },
  };
}
