import type { BuiltinServerDefinition } from '../../builtinTools';
import {
  downloadTranscriptionModelTool,
  listTranscriptionModelsTool,
  transcribeAudioTool,
} from './transcribeTools';

export const transcribeServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-transcribe',
  name: 'Local Transcription',
  description: 'Download local Whisper transcription models and transcribe audio files on device',
  isBuiltin: true,
  tools: [
    listTranscriptionModelsTool,
    downloadTranscriptionModelTool,
    transcribeAudioTool,
  ],
  resources: [],
  prompts: [],
};
