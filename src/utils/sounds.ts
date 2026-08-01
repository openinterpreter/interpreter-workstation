function resolveSoundUrl(filename: string): string {
  if (typeof window === 'undefined' || !window.location) {
    return `sounds/${filename}`;
  }

  return new URL(`sounds/${filename}`, window.location.href).toString();
}

export const SOUND_FILES = {
  knock: resolveSoundUrl('knock.wav'),
  chirp: resolveSoundUrl('chirp.wav'),
  bubble: resolveSoundUrl('bubble.wav'),
} as const;

export type SoundFileId = keyof typeof SOUND_FILES;
export type SoundId = SoundFileId | 'none';
export const SOUND_IDS: SoundId[] = ['none', ...Object.keys(SOUND_FILES) as SoundFileId[]];

export type SoundEvent = 'agentFinished' | 'agentNeedsAttention' | 'voiceSent' | 'ambientTriggerDetected';

const STORAGE_KEY = 'oi-sound-settings';

interface SoundSettings {
  enabled: boolean;
  agentFinished: SoundId;
  agentNeedsAttention: SoundId;
  voiceSent: SoundId;
  ambientTriggerDetected: SoundId;
}

const DEFAULTS: SoundSettings = {
  enabled: false,
  agentFinished: 'bubble',
  agentNeedsAttention: 'knock',
  voiceSent: 'chirp',
  ambientTriggerDetected: 'chirp',
};

export function getSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function setSoundSettings(settings: Partial<SoundSettings>) {
  try {
    const current = getSoundSettings();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...settings }));
  } catch { /* ignore */ }
}

function play(soundId: SoundId) {
  const settings = getSoundSettings();
  if (!settings.enabled) return;
  if (soundId === 'none') return;
  try {
    const audio = new Audio(SOUND_FILES[soundId]);
    audio.volume = 0.4;
    audio.play().catch(() => {});
  } catch { /* ignore */ }
}

export function playSound(event: SoundEvent) {
  const settings = getSoundSettings();
  play(settings[event]);
}

export function previewSound(soundId: SoundId) {
  if (soundId === 'none') return;
  try {
    const audio = new Audio(SOUND_FILES[soundId]);
    audio.volume = 0.4;
    audio.play().catch(() => {});
  } catch { /* ignore */ }
}
