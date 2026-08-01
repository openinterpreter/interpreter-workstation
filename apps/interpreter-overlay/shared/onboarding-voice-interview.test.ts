import { describe, expect, test } from 'bun:test';

import { parseOnboardingVoiceInterviewToolArguments } from './onboarding-voice-interview';

describe('parseOnboardingVoiceInterviewToolArguments', () => {
  test('returns the exact onboarding interview answer shape', () => {
    expect(parseOnboardingVoiceInterviewToolArguments(JSON.stringify({
      modelsUsed: 'GPT-5 and Claude',
      aiUseToday: 'coding and research',
      currentSetup: 'ChatGPT desktop and API keys',
    }))).toEqual({
      modelsUsed: 'GPT-5 and Claude',
      aiUseToday: 'coding and research',
      currentSetup: 'ChatGPT desktop and API keys',
    });
  });

  test('fails loudly when a required answer is missing or not a string', () => {
    expect(() => parseOnboardingVoiceInterviewToolArguments(JSON.stringify({
      modelsUsed: 'GPT-5',
      aiUseToday: 'coding',
    }))).toThrow('complete_onboarding_voice_interview requires string modelsUsed, aiUseToday, and currentSetup.');

    expect(() => parseOnboardingVoiceInterviewToolArguments(JSON.stringify({
      modelsUsed: 'GPT-5',
      aiUseToday: ['coding'],
      currentSetup: 'desktop',
    }))).toThrow('complete_onboarding_voice_interview requires string modelsUsed, aiUseToday, and currentSetup.');
  });
});
