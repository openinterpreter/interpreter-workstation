import { describe, expect, test } from 'bun:test';

import { completedHotkeyHoldAfterInputOpenMs, hotkeyHoldIsActive, timedVoiceHoldIsLongEnough } from './hotkey-hold';

describe('completedHotkeyHoldAfterInputOpenMs', () => {
  test('ignores releases observed before the input-open cycle', () => {
    expect(completedHotkeyHoldAfterInputOpenMs(2000, 1500)).toBeNull();
  });

  test('measures release duration inside the input-open cycle', () => {
    expect(completedHotkeyHoldAfterInputOpenMs(2000, 4100)).toBe(2100);
  });

  test('does not infer a completed hold without both timestamps', () => {
    expect(completedHotkeyHoldAfterInputOpenMs(null, 4100)).toBeNull();
    expect(completedHotkeyHoldAfterInputOpenMs(2000, null)).toBeNull();
  });
});

describe('timedVoiceHoldIsLongEnough', () => {
  test('starts when the input-open window has exceeded the delay and no release was observed', () => {
    expect(timedVoiceHoldIsLongEnough({
      inputOpenedAt: 1000,
      now: 3100,
      voiceDelayMs: 2000,
      releasedAfterInputOpen: false,
      activeControlHoldLongEnough: false,
      completedHoldWasLongEnough: false,
      completedHoldAfterOpenLongEnough: false,
    })).toBe(true);
  });

  test('does not treat a short open window as a voice hold', () => {
    expect(timedVoiceHoldIsLongEnough({
      inputOpenedAt: 1000,
      now: 2500,
      voiceDelayMs: 2000,
      releasedAfterInputOpen: false,
      activeControlHoldLongEnough: false,
      completedHoldWasLongEnough: false,
      completedHoldAfterOpenLongEnough: false,
    })).toBe(false);
  });

  test('requires completed holds to also be long after input open', () => {
    expect(timedVoiceHoldIsLongEnough({
      inputOpenedAt: 1000,
      now: 3500,
      voiceDelayMs: 2000,
      releasedAfterInputOpen: true,
      activeControlHoldLongEnough: false,
      completedHoldWasLongEnough: true,
      completedHoldAfterOpenLongEnough: false,
    })).toBe(false);
    expect(timedVoiceHoldIsLongEnough({
      inputOpenedAt: 1000,
      now: 3500,
      voiceDelayMs: 2000,
      releasedAfterInputOpen: true,
      activeControlHoldLongEnough: false,
      completedHoldWasLongEnough: true,
      completedHoldAfterOpenLongEnough: true,
    })).toBe(true);
  });
});

describe('hotkeyHoldIsActive', () => {
  test('requires a real active key-down state', () => {
    expect(hotkeyHoldIsActive({
      controlDownAt: null,
      controlUpAt: null,
      chordDownAt: null,
      chordUpAt: null,
    })).toBe(false);

    expect(hotkeyHoldIsActive({
      controlDownAt: 1000,
      controlUpAt: 1100,
      chordDownAt: null,
      chordUpAt: null,
    })).toBe(false);

    expect(hotkeyHoldIsActive({
      controlDownAt: 1000,
      controlUpAt: null,
      chordDownAt: null,
      chordUpAt: null,
    })).toBe(true);

    expect(hotkeyHoldIsActive({
      controlDownAt: null,
      controlUpAt: null,
      chordDownAt: 1000,
      chordUpAt: 900,
    })).toBe(true);
  });
});
