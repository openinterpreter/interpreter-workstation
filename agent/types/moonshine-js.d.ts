declare module '@moonshine-ai/moonshine-js' {
  export interface MicrophoneTranscriberCallbacks {
    onModelLoadStarted?: () => void;
    onModelLoaded?: () => void;
    onTranscriptionUpdated?: (text: string) => void;
    onTranscriptionCommitted?: (text: string, buffer?: AudioBuffer) => void;
    onSpeechStart?: () => void;
    onSpeechEnd?: () => void;
    onError?: (error: unknown) => void;
  }

  export class MicrophoneTranscriber {
    constructor(
      modelName: string,
      callbacks?: MicrophoneTranscriberCallbacks,
      useVadMode?: boolean,
    );
    start(): Promise<void>;
    stop(): void;
  }
}
