import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

let getSoundSettings: typeof import('./sounds').getSoundSettings;
let setSoundSettings: typeof import('./sounds').setSoundSettings;

beforeAll(async () => {
  const globalObject = globalThis as typeof globalThis & {
    window?: { location?: URL };
    localStorage?: MemoryStorage;
  };
  globalObject.window = globalObject.window ?? {};
  globalObject.window.location = new URL('http://localhost:5173/');
  globalObject.localStorage = new MemoryStorage();

  const module = await import('./sounds');
  getSoundSettings = module.getSoundSettings;
  setSoundSettings = module.setSoundSettings;
});

beforeEach(() => {
  localStorage.clear();
});

describe('sound settings defaults', () => {
  test('defaults sounds to disabled', () => {
    expect(getSoundSettings()).toMatchObject({
      enabled: false,
      agentFinished: 'bubble',
      agentNeedsAttention: 'knock',
      voiceSent: 'chirp',
      ambientTriggerDetected: 'chirp',
    });
  });

  test('persists partial updates on top of disabled defaults', () => {
    setSoundSettings({ voiceSent: 'none' });

    expect(getSoundSettings()).toMatchObject({
      enabled: false,
      voiceSent: 'none',
      agentFinished: 'bubble',
      agentNeedsAttention: 'knock',
      ambientTriggerDetected: 'chirp',
    });
  });
});
