export function completedHotkeyHoldAfterInputOpenMs(
  inputOpenedAt: number | null,
  controlUpAt: number | null,
): number | null {
  if (inputOpenedAt === null || controlUpAt === null || controlUpAt < inputOpenedAt) {
    return null;
  }

  return controlUpAt - inputOpenedAt;
}

export function timedVoiceHoldIsLongEnough(options: {
  inputOpenedAt: number | null;
  now: number;
  voiceDelayMs: number;
  releasedAfterInputOpen: boolean;
  activeControlHoldLongEnough: boolean;
  completedHoldWasLongEnough: boolean;
  completedHoldAfterOpenLongEnough: boolean;
}): boolean {
  const openWindowLongEnough = options.inputOpenedAt !== null
    && !options.releasedAfterInputOpen
    && Math.max(0, options.now - options.inputOpenedAt) >= options.voiceDelayMs;
  return openWindowLongEnough
    || options.activeControlHoldLongEnough
    || (options.completedHoldWasLongEnough && options.completedHoldAfterOpenLongEnough);
}

export function hotkeyHoldIsActive(options: {
  controlDownAt: number | null;
  controlUpAt: number | null;
  chordDownAt: number | null;
  chordUpAt: number | null;
}): boolean {
  const controlActive = options.controlDownAt !== null
    && (options.controlUpAt === null || options.controlUpAt < options.controlDownAt);
  const chordActive = options.chordDownAt !== null
    && (options.chordUpAt === null || options.chordUpAt < options.chordDownAt);
  return controlActive || chordActive;
}
