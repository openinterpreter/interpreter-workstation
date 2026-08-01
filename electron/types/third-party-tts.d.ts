declare module 'unbzip2-stream' {
  import type { Transform } from 'node:stream';
  function unbzip2Stream(): Transform;
  export default unbzip2Stream;
}

declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream';

  export interface Headers {
    name: string;
    type: 'file' | 'directory' | string;
    mode?: number;
  }

  export interface Extract extends Writable {
    on(event: 'entry', listener: (header: Headers, stream: Readable, next: () => void) => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  export function extract(): Extract;

  const tar: {
    extract: typeof extract;
  };
  export default tar;
}

declare module 'sherpa-onnx' {
  export interface SherpaOfflineTtsGeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface SherpaOfflineTts {
    sampleRate: number;
    numSpeakers: number;
    generate(config: { text: string; sid: number; speed: number }): SherpaOfflineTtsGeneratedAudio;
    free(): void;
  }

  export function createOfflineTts(config: unknown): SherpaOfflineTts;
}
