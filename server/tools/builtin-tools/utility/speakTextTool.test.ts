import { describe, expect, test } from 'bun:test';
import { speakTextTool } from './speakTextTool';

describe('speakTextTool validation', () => {
  test('returns installed TTS model options when modelId is unknown', async () => {
    const result = await speakTextTool.handler({
      text: 'Hello.',
      modelId: 'not-a-real-model',
      play: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown TTS model: not-a-real-model');
    expect(result.content[0].text).toContain('Known modelId values:');
    expect(result.content[0].text).toContain('Installed modelId values:');
  });

  test('returns available providers when provider is unknown', async () => {
    const result = await speakTextTool.handler({
      text: 'Hello.',
      provider: 'not-a-real-provider',
      play: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'Error: Unknown TTS provider: not-a-real-provider. Available provider values: cpu, xnnpack, coreml, cuda.',
    );
  });
});
