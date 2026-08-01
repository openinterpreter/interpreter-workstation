export interface ServerTranscriptionRequest {
  audioBase64: string;
  language?: string;
  temperature?: number;
  prompt?: string;
}

export interface ServerTranscriptionResponse {
  text: string;
}

export interface ServerSTTConfig {
  baseURL: string;
  getAccessToken: () => Promise<string> | string;
  language?: string;
  temperature?: number;
  prompt?: string;
  maxDuration?: number;
}

export interface AssemblyAIConfig {
  apiKey: string;
  baseURL?: string;
  chunkMs?: number;
  language?: 'en' | 'multi';
  endTurnConfidence?: number;
  formatTurns?: boolean;
  sampleRate?: number;
}
