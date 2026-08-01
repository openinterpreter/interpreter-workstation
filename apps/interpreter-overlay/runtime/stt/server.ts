import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import type { STTPort } from '../../shared/ports.js';
import type { ServerSTTConfig } from './types.js';
import { startCapture, type AudioCapture } from './audio-capture.js';

const DEFAULT_MAX_DURATION = 60000;
const SAMPLE_RATE = 16000;

function calculateAmplitude(buffer: Buffer): number {
  const samples = buffer.length / 2;
  let sumSquares = 0;

  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumSquares / samples);
  return Math.min(1, rms * 15);
}

export interface ExtendedSTTPort extends STTPort {
  onAmplitude?(callback: (amplitude: number) => void): void;
}

export function createServerSTT(config: ServerSTTConfig): ExtendedSTTPort {
  let capture: AudioCapture | null = null;
  let ws: any = null;
  let recordingStartTime = 0;
  let latestTranscript = '';
  let partialCallback: ((text: string) => void) | null = null;
  let amplitudeCallback: ((amplitude: number) => void) | null = null;
  let finalTranscriptResolve: ((text: string) => void) | null = null;

  return {
    startRecording(): void {
      latestTranscript = '';
      recordingStartTime = Date.now();
      finalTranscriptResolve = null;

      const accessToken = config.getAccessToken();
      Promise.resolve(accessToken)
        .then((token) => {
          const wsUrl = config.baseURL.replace(/^http/, 'ws') + '/transcribe/stream';
          ws = new WebSocket(wsUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          ws.on('open', () => {
            capture = startCapture({
              sampleRate: SAMPLE_RATE,
              chunkMs: 50,
            });

            capture.stream.on('data', (chunk: Buffer) => {
              const elapsed = Date.now() - recordingStartTime;
              if (elapsed > (config.maxDuration ?? DEFAULT_MAX_DURATION)) {
                capture?.stop();
                return;
              }

              amplitudeCallback?.(calculateAmplitude(chunk));

              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(chunk);
              }
            });

            capture.stream.on('error', (error) => {
              console.error('[InterpreterOverlay][STT] Audio capture error:', error);
            });
          });

          ws.on('message', (data: unknown) => {
            const message = JSON.parse(String(data)) as {
              type: 'partial' | 'final' | 'error';
              text?: string;
              message?: string;
            };

            if (message.type === 'partial') {
              if (message.text) {
                latestTranscript = message.text;
              }
              partialCallback?.(message.text ?? '');
              return;
            }

            if (message.type === 'final') {
              latestTranscript = message.text ?? '';
              finalTranscriptResolve?.(latestTranscript);
              finalTranscriptResolve = null;
              partialCallback?.(latestTranscript);
              ws?.close();
              ws = null;
              return;
            }

            console.error('[InterpreterOverlay][STT] Server error:', message.message);
          });

          ws.on('error', (error: unknown) => {
            console.error('[InterpreterOverlay][STT] WebSocket error:', error);
          });

          ws.on('unexpected-response', (_request: ClientRequest, response: IncomingMessage) => {
            let body = '';
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            response.on('end', () => {
              console.error('[InterpreterOverlay][STT] Unexpected server response:', {
                status: response.statusCode,
                body,
              });
            });
          });
        })
        .catch((error) => {
          console.error('[InterpreterOverlay][STT] Failed to start streaming:', error);
          throw error;
        });
    },

    async stopRecording(): Promise<{ text: string }> {
      return new Promise((resolve, reject) => {
        try {
          if (capture) {
            capture.stop();
            capture = null;
          }

          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'close' }));
          }

          finalTranscriptResolve = (text: string) => {
            resolve({ text });
          };

          setTimeout(() => {
            if (!finalTranscriptResolve) {
              return;
            }
            resolve({ text: latestTranscript || '' });
            finalTranscriptResolve = null;
          }, 1500);
        } catch (error) {
          finalTranscriptResolve = null;
          if (error instanceof Error) {
            reject(new Error(`Server STT failed: ${error.message}`));
            return;
          }
          reject(error);
        }
      });
    },

    abortRecording(): void {
      capture?.stop();
      capture = null;
      ws?.close();
      ws = null;
      latestTranscript = '';
      finalTranscriptResolve = null;
    },

    onPartialTranscript(callback: (text: string) => void): void {
      partialCallback = callback;
    },

    onAmplitude(callback: (amplitude: number) => void): void {
      amplitudeCallback = callback;
    },
  };
}
