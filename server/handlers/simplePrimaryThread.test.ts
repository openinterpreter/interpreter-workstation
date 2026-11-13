import { describe, expect, test } from 'bun:test';
import {
  bindSimplePrimaryThread,
  clearSimplePrimaryThread,
  getSimplePrimaryThread,
} from './simplePrimaryThread';
import type { AppConfig } from '../configStore';

describe('Simple primary conversation', () => {
  function fixture() {
    let workspace = '/Documents/Interpreter';
    let stored = { agents: {} } as AppConfig;
    return {
      deps: {
        workspace: async () => workspace,
        load: async () => structuredClone(stored),
        save: async (config: AppConfig) => { stored = structuredClone(config); },
      },
      setWorkspace: (value: string) => { workspace = value; },
    };
  }

  test('claims once and survives a fresh read without creating another conversation', async () => {
    const { deps } = fixture();
    expect(await getSimplePrimaryThread(deps)).toEqual({ threadId: null });
    await bindSimplePrimaryThread({ threadId: 'thread-12345678' }, deps);
    expect(await getSimplePrimaryThread(deps)).toEqual({ threadId: 'thread-12345678' });
    expect(await bindSimplePrimaryThread({ threadId: 'thread-12345678' }, deps)).toEqual({ threadId: 'thread-12345678' });
  });

  test('isolates workspaces and rejects cross-window overwrite', async () => {
    const { deps, setWorkspace } = fixture();
    await bindSimplePrimaryThread({ threadId: 'thread-12345678' }, deps);
    setWorkspace('/Documents/Elsewhere');
    expect(await getSimplePrimaryThread(deps)).toEqual({ threadId: null });
    await bindSimplePrimaryThread({ threadId: 'thread-98765432' }, deps);
    setWorkspace('/Documents/Interpreter');
    expect(await getSimplePrimaryThread(deps)).toEqual({ threadId: 'thread-12345678' });
    await expect(bindSimplePrimaryThread({ threadId: 'thread-conflict' }, deps)).rejects.toThrow('changed');
  });

  test('repairs stale IDs only when caller observes the current binding', async () => {
    const { deps } = fixture();
    await bindSimplePrimaryThread({ threadId: 'thread-12345678' }, deps);
    await expect(bindSimplePrimaryThread({ threadId: 'thread-98765432', expectedThreadId: 'thread-old0000' }, deps)).rejects.toThrow();
    await bindSimplePrimaryThread({ threadId: 'thread-98765432', expectedThreadId: 'thread-12345678' }, deps);
    expect(await getSimplePrimaryThread(deps)).toEqual({ threadId: 'thread-98765432' });
    await expect(bindSimplePrimaryThread({ threadId: '../../etc/passwd' }, deps)).rejects.toThrow('Invalid');
  });

  test('clears only the exact observed binding before a provider change', async () => {
    const { deps } = fixture();
    await bindSimplePrimaryThread({ threadId: 'thread-12345678' }, deps);
    await expect(clearSimplePrimaryThread({ expectedThreadId: 'thread-wrong000' }, deps)).rejects.toThrow('changed');
    expect(await clearSimplePrimaryThread({ expectedThreadId: 'thread-12345678' }, deps)).toEqual({ threadId: null });
    expect(await clearSimplePrimaryThread({ expectedThreadId: 'thread-12345678' }, deps)).toEqual({ threadId: null });
    expect(await getSimplePrimaryThread(deps)).toEqual({ threadId: null });
  });

  test('lets a remounted runtime claim a slot that was just cleared', async () => {
    const { deps } = fixture();
    await expect(bindSimplePrimaryThread({
      threadId: 'thread-new00001',
      expectedThreadId: 'thread-old00001',
    }, deps)).resolves.toEqual({ threadId: 'thread-new00001' });
  });
});
