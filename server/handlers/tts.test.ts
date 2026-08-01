import { describe, expect, test } from 'bun:test';
import { TTS_MODELS } from '../../shared/types/tts';
import { formatInstalledTtsModelsForError } from './tts';
import type { listTtsModels } from '../services/ttsService';

type TtsModelStatus = Awaited<ReturnType<typeof listTtsModels>>[number];

function modelStatus(
  id: TtsModelStatus['id'],
  installed: boolean,
): TtsModelStatus {
  const definition = TTS_MODELS.find((model) => model.id === id);
  if (!definition) {
    throw new Error(`Unknown test model: ${id}`);
  }

  return {
    id,
    size: definition.size,
    label: definition.label,
    description: definition.description,
    installed,
    installPath: `/tmp/interpreter-test-tts/${id}`,
  };
}

describe('formatInstalledTtsModelsForError', () => {
  test('lists exact installed modelId values for agent retries', () => {
    const message = formatInstalledTtsModelsForError([
      modelStatus('kitten-nano-en-v0_2-fp16', true),
      modelStatus('kokoro-en-v0_19', false),
      modelStatus('vits-piper-en_US-libritts_r-medium', true),
    ]);

    expect(message).toBe(
      'Installed modelId values: kitten-nano-en-v0_2-fp16, vits-piper-en_US-libritts_r-medium.',
    );
  });

  test('reports none concisely when no TTS models are installed', () => {
    const message = formatInstalledTtsModelsForError([
      modelStatus('kitten-nano-en-v0_2-fp16', false),
    ]);

    expect(message).toBe('Installed modelId values: none. Download a TTS model from Settings > Voice.');
  });
});
