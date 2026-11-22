import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getEnvApiKey, getEnvApiKeys } from './providers';

describe('voice-only GPT Live key', () => {
  let originalOpenAI: string | undefined;
  let originalLive: string | undefined;

  beforeEach(() => {
    originalOpenAI = process.env.OPENAI_API_KEY;
    originalLive = process.env.INTERPRETER_LIVE_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.INTERPRETER_LIVE_OPENAI_API_KEY = 'sk-live-voice-only-key';
  });

  afterEach(() => {
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalLive === undefined) delete process.env.INTERPRETER_LIVE_OPENAI_API_KEY;
    else process.env.INTERPRETER_LIVE_OPENAI_API_KEY = originalLive;
  });

  test('does not make an OpenAI model provider appear configured', () => {
    expect(getEnvApiKeys().openai).toEqual({ found: false, masked: undefined });
    expect(getEnvApiKey('openai')).toBeNull();
  });
});
