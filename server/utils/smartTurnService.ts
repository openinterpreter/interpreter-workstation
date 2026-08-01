/**
 * Smart Turn v3.2 end-of-turn detection service.
 *
 * Uses the Pipecat Smart Turn ONNX model (BSD-2 license, 8MB) to determine
 * whether a user has finished speaking. The model takes Whisper-style 80-bin
 * log mel spectrogram features and outputs a single logit indicating
 * turn completeness.
 *
 * Input: last 8 seconds of 16kHz mono Float32 PCM audio.
 * Output: { done: boolean, confidence: number }
 */

import path from 'path';
import fs from 'fs';

// Lazy-loaded onnxruntime-node
let ort: typeof import('onnxruntime-node') | null = null;
let session: import('onnxruntime-node').InferenceSession | null = null;
let loadPromise: Promise<void> | null = null;

// Whisper feature extractor constants
const SAMPLE_RATE = 16000;
const N_FFT = 400;       // 25ms window
const HOP_LENGTH = 160;  // 10ms hop → 100 frames/sec
const N_MELS = 80;
const MAX_DURATION_S = 8;
const MAX_SAMPLES = SAMPLE_RATE * MAX_DURATION_S; // 128,000
const MAX_FRAMES = Math.floor(MAX_SAMPLES / HOP_LENGTH); // 800

// Confidence threshold for "done" classification
const DONE_THRESHOLD = 0.5;

function resolveModelPath(): string {
  // In development: resources/smart-turn/
  const devPath = path.join(process.cwd(), 'resources', 'smart-turn', 'smart-turn-v3.2-cpu.onnx');
  if (fs.existsSync(devPath)) return devPath;

  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null;
  const packagedResourcePath = resourcesPath
    ? path.join(resourcesPath, 'smart-turn', 'smart-turn-v3.2-cpu.onnx')
    : null;
  if (packagedResourcePath && fs.existsSync(packagedResourcePath)) return packagedResourcePath;

  // In packaged app: look relative to __dirname
  const prodPath = path.join(__dirname, '..', '..', 'resources', 'smart-turn', 'smart-turn-v3.2-cpu.onnx');
  if (fs.existsSync(prodPath)) return prodPath;

  throw new Error(`Smart Turn model not found at ${[devPath, packagedResourcePath, prodPath].filter(Boolean).join(' or ')}`);
}

async function ensureLoaded(): Promise<void> {
  if (session) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      ort = await import('onnxruntime-node');
      const modelPath = resolveModelPath();
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      console.log('[SmartTurn] Model loaded from', modelPath);
    } catch (error) {
      console.error('[SmartTurn] Failed to load model:', error);
      loadPromise = null;
      throw error;
    }
  })();

  return loadPromise;
}

/**
 * Precompute mel filter bank matrix (N_MELS x (N_FFT/2 + 1)).
 * Maps FFT bins to mel-scale filter banks.
 */
function createMelFilterBank(): Float32Array[] {
  const nFreqs = Math.floor(N_FFT / 2) + 1; // 201

  const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

  const melLow = hzToMel(0);
  const melHigh = hzToMel(SAMPLE_RATE / 2);

  // N_MELS + 2 equally spaced mel points
  const melPoints = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    melPoints[i] = melLow + (i / (N_MELS + 1)) * (melHigh - melLow);
  }

  // Convert mel points to FFT bin indices
  const fftBins = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    fftBins[i] = Math.floor((N_FFT + 1) * melToHz(melPoints[i]) / SAMPLE_RATE);
  }

  // Create triangular filters
  const filters: Float32Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const filter = new Float32Array(nFreqs);
    const left = fftBins[m];
    const center = fftBins[m + 1];
    const right = fftBins[m + 2];

    for (let k = 0; k < nFreqs; k++) {
      if (k >= left && k <= center && center > left) {
        filter[k] = (k - left) / (center - left);
      } else if (k > center && k <= right && right > center) {
        filter[k] = (right - k) / (right - center);
      }
    }
    filters.push(filter);
  }

  return filters;
}

// Cache the filter bank
let melFilters: Float32Array[] | null = null;

function getMelFilters(): Float32Array[] {
  if (!melFilters) {
    melFilters = createMelFilterBank();
  }
  return melFilters;
}

/**
 * Compute Hann window of given size.
 */
function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}

// Cache hann window
let cachedHann: Float32Array | null = null;
function getHannWindow(): Float32Array {
  if (!cachedHann) {
    cachedHann = hannWindow(N_FFT);
  }
  return cachedHann;
}

/**
 * Simple real-valued FFT using the Cooley-Tukey radix-2 algorithm.
 * Returns magnitude spectrum (first N/2 + 1 bins).
 */
function realFftMagnitude(signal: Float32Array, n: number): Float32Array {
  // Zero-pad to next power of 2
  const p = Math.ceil(Math.log2(n));
  const N = 1 << p;

  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let i = 0; i < n && i < signal.length; i++) {
    real[i] = signal[i];
  }

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  // FFT butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let i = 0; i < N; i += len) {
      let curReal = 1;
      let curImag = 0;

      for (let j = 0; j < halfLen; j++) {
        const evenIdx = i + j;
        const oddIdx = i + j + halfLen;

        const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
        const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];

        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;

        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }

  // Compute magnitude for first N/2 + 1 bins
  const nFreqs = Math.floor(N_FFT / 2) + 1;
  const mag = new Float32Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) {
    mag[i] = real[i] * real[i] + imag[i] * imag[i];
  }
  return mag;
}

/**
 * Compute 80-bin log mel spectrogram from 16kHz PCM audio.
 * Returns Float32Array of shape [N_MELS, nFrames] in row-major order.
 */
function computeLogMelSpectrogram(pcm: Float32Array): { features: Float32Array; nFrames: number } {
  const nFrames = Math.max(1, Math.floor((pcm.length - N_FFT) / HOP_LENGTH) + 1);
  const hann = getHannWindow();
  const filters = getMelFilters();
  const nFreqs = Math.floor(N_FFT / 2) + 1;

  const melSpec = new Float32Array(N_MELS * nFrames);
  const windowed = new Float32Array(N_FFT);

  for (let frame = 0; frame < nFrames; frame++) {
    const start = frame * HOP_LENGTH;

    // Apply Hann window
    for (let i = 0; i < N_FFT; i++) {
      const idx = start + i;
      windowed[i] = idx < pcm.length ? pcm[idx] * hann[i] : 0;
    }

    // FFT magnitude squared
    const powerSpec = realFftMagnitude(windowed, N_FFT);

    // Apply mel filter banks
    for (let m = 0; m < N_MELS; m++) {
      let energy = 0;
      const filter = filters[m];
      for (let k = 0; k < nFreqs; k++) {
        energy += filter[k] * powerSpec[k];
      }
      // Log mel (with floor to avoid log(0))
      melSpec[m * nFrames + frame] = Math.log(Math.max(energy, 1e-10));
    }
  }

  return { features: melSpec, nFrames };
}

/**
 * Run Smart Turn inference on the last 8 seconds of audio.
 *
 * @param pcm16kHz Float32 PCM audio at 16kHz, mono. Can be any length;
 *                 only the last 8 seconds are used. If shorter, zero-padded
 *                 at the BEGINNING (per Smart Turn spec).
 * @returns { done: boolean, confidence: number }
 */
export async function inferSmartTurn(pcm16kHz: Float32Array): Promise<{ done: boolean; confidence: number }> {
  await ensureLoaded();
  if (!session || !ort) {
    throw new Error('Smart Turn model not loaded');
  }

  // Take last 8 seconds
  let audio: Float32Array;
  if (pcm16kHz.length > MAX_SAMPLES) {
    audio = pcm16kHz.slice(pcm16kHz.length - MAX_SAMPLES);
  } else if (pcm16kHz.length < MAX_SAMPLES) {
    // Pad at BEGINNING with zeros
    audio = new Float32Array(MAX_SAMPLES);
    audio.set(pcm16kHz, MAX_SAMPLES - pcm16kHz.length);
  } else {
    audio = pcm16kHz;
  }

  // Compute log mel spectrogram
  const { features, nFrames } = computeLogMelSpectrogram(audio);

  // Reshape to [1, N_MELS, nFrames] — already in row-major [mel, frame] order
  // Pad or trim to MAX_FRAMES
  let inputData: Float32Array;
  if (nFrames === MAX_FRAMES) {
    inputData = features;
  } else if (nFrames < MAX_FRAMES) {
    // Pad frames at the beginning (corresponding to zero-padded audio)
    inputData = new Float32Array(N_MELS * MAX_FRAMES);
    const frameOffset = MAX_FRAMES - nFrames;
    for (let m = 0; m < N_MELS; m++) {
      for (let f = 0; f < nFrames; f++) {
        inputData[m * MAX_FRAMES + frameOffset + f] = features[m * nFrames + f];
      }
    }
  } else {
    // Trim to last MAX_FRAMES
    inputData = new Float32Array(N_MELS * MAX_FRAMES);
    const frameOffset = nFrames - MAX_FRAMES;
    for (let m = 0; m < N_MELS; m++) {
      for (let f = 0; f < MAX_FRAMES; f++) {
        inputData[m * MAX_FRAMES + f] = features[m * nFrames + frameOffset + f];
      }
    }
  }

  const inputTensor = new ort.Tensor('float32', inputData, [1, N_MELS, MAX_FRAMES]);
  const result = await session.run({ input_features: inputTensor });
  const logit = (result.logits as import('onnxruntime-node').Tensor).data[0] as number;
  const confidence = 1 / (1 + Math.exp(-logit)); // sigmoid

  return {
    done: confidence >= DONE_THRESHOLD,
    confidence,
  };
}

export const smartTurnServiceTestUtils = {
  resolveModelPath,
};

/**
 * Extract Float32 PCM from the ring buffer in a StreamSession.
 * Converts Int16 ring buffer to Float32 for Smart Turn inference.
 */
export function ringBufferToFloat32(ringBuffer: Float32Array, writePos: number, totalWritten: number): Float32Array {
  const capacity = ringBuffer.length;
  const samplesAvailable = Math.min(totalWritten, capacity);

  if (samplesAvailable === 0) {
    return new Float32Array(0);
  }

  const result = new Float32Array(samplesAvailable);
  const readStart = writePos >= samplesAvailable
    ? writePos - samplesAvailable
    : capacity - (samplesAvailable - writePos);

  for (let i = 0; i < samplesAvailable; i++) {
    result[i] = ringBuffer[(readStart + i) % capacity];
  }

  return result;
}
