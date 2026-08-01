/**
 * Audio Capture for Node.js
 *
 * Captures PCM audio from the system default microphone.
 * Outputs PCM s16le mono format suitable for AssemblyAI streaming.
 *
 * Uses node-record-lpcm16 for cross-platform microphone access.
 */

import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';

export interface AudioCaptureConfig {
  sampleRate?: number; // Sample rate in Hz (default: 16000)
  chunkMs?: number; // Chunk duration in ms (default: 200)
}

/**
 * Audio capture handle
 */
export interface AudioCapture {
  /**
   * Stream of PCM audio chunks (Buffer objects)
   */
  stream: Readable;

  /**
   * Stop capturing and close the stream
   */
  stop(): void;
}

/**
 * Start capturing audio from the default microphone
 *
 * Returns a readable stream of PCM s16le mono audio chunks.
 * Each chunk is approximately chunkMs milliseconds of audio.
 *
 * @param config - Audio capture configuration
 * @returns AudioCapture handle with stream and stop method
 * @throws Error if microphone access fails
 */
export function startCapture(config: AudioCaptureConfig = {}): AudioCapture {
  const sampleRate = config.sampleRate || 16000;
  const chunkMs = config.chunkMs || 200;

  // Calculate chunk size in bytes
  // PCM s16le = 2 bytes per sample, mono = 1 channel
  const samplesPerChunk = Math.floor((sampleRate * chunkMs) / 1000);
  const chunkSize = samplesPerChunk * 2; // 2 bytes per sample

  let childProcess: ChildProcess | null = null;
  let stream: Readable | null = null;

  try {
    // Use node-record-lpcm16 via sox/arecord/rec depending on platform
    // This is a simplified implementation - in production, import the actual library
    // For now, we'll use a direct sox/arecord approach

    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    let command: string;
    let args: string[];

    if (isMac) {
      // macOS: use sox with default audio device
      command = 'sox';
      args = [
        '-d', // Default audio device (input)
        '-t', 'raw', // Output format: raw PCM
        '-r', String(sampleRate), // Output sample rate (force resample)
        '-e', 'signed-integer', // Output encoding: signed integer
        '-b', '16', // Output bit depth: 16-bit
        '-c', '1', // Output channels: mono
        '-', // Output to stdout
      ];
    } else if (isLinux) {
      // Linux: use arecord (ALSA)
      command = 'arecord';
      args = [
        '-f', 'S16_LE', // Signed 16-bit little-endian
        '-r', String(sampleRate), // Sample rate
        '-c', '1', // Mono
        '-t', 'raw', // Raw PCM
        '-', // Output to stdout
      ];
    } else if (isWindows) {
      // Windows: use sox
      command = 'sox';
      args = [
        '-d', // Default audio device
        '-t', 'raw', // Raw PCM output
        '-r', String(sampleRate), // Sample rate
        '-e', 'signed-integer', // Signed integer encoding
        '-b', '16', // 16-bit
        '-c', '1', // Mono
        '-', // Output to stdout
      ];
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }

    // Spawn the audio capture process
    const proc = spawn(command, args);

    if (!proc.stdout) {
      throw new Error('Failed to get stdout from audio capture process');
    }

    // Store process reference
    childProcess = proc;

    // Create chunked stream
    const chunkedStream = new Readable({
      read() {
        // Passive stream - data is pushed from proc.stdout
      },
    });

    // Buffer for accumulating audio data
    let buffer = Buffer.alloc(0);

    // Pipe stdout data through chunker
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Emit chunks of the target size
      while (buffer.length >= chunkSize) {
        const audioChunk = buffer.subarray(0, chunkSize);
        buffer = buffer.subarray(chunkSize);
        chunkedStream.push(audioChunk);
      }
    });

    proc.stdout.on('end', () => {
      // Emit any remaining data
      if (buffer.length > 0) {
        chunkedStream.push(buffer);
      }
      chunkedStream.push(null); // End stream
    });

    proc.on('error', (error) => {
      chunkedStream.destroy(error);
    });

    proc.stderr?.on('data', (data) => {
      // Log stderr but don't treat as error (sox outputs info to stderr)
      console.warn('[AudioCapture] stderr:', data.toString());
    });

    stream = chunkedStream;

    // Return capture handle
    return {
      stream: chunkedStream,
      stop() {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM');
          childProcess = null;
        }
        if (stream && !stream.destroyed) {
          stream.destroy();
          stream = null;
        }
      },
    };
  } catch (error) {
    // Cleanup on error
    if (childProcess && !childProcess.killed) {
      childProcess.kill('SIGTERM');
    }
    if (stream && !stream.destroyed) {
      stream.destroy();
    }

    if (error instanceof Error) {
      throw new Error(`Failed to start audio capture: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Convert Float32Array PCM to Int16 PCM (little-endian)
 *
 * Utility function for converting browser AudioWorklet output
 * to the format expected by AssemblyAI.
 *
 * @param float32 - Float32Array with samples in range [-1, 1]
 * @returns Buffer containing PCM s16le data
 */
export function float32ToPCM16LE(float32: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(float32.length * 2);

  for (let i = 0; i < float32.length; i++) {
    // Clamp to [-1, 1]
    const sample = Math.max(-1, Math.min(1, float32[i]));
    // Convert to int16 range [-32768, 32767]
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    // Write as little-endian int16
    buffer.writeInt16LE(Math.round(int16), i * 2);
  }

  return buffer;
}
