import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userDataPath = await mkdtemp(join(tmpdir(), 'simple-live-credential-'));
const isEncryptionAvailable = mock(() => true);
const decryptString = mock(() => 'unused');

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`Unexpected Electron path: ${name}`);
      return userDataPath;
    },
  },
  safeStorage: {
    isEncryptionAvailable,
    decryptString,
    encryptString: (value: string) => Buffer.from(value),
  },
}));

const { readSimpleLiveApiKey } = await import('./simpleLiveCredential');

afterAll(async () => {
  await rm(userDataPath, { recursive: true, force: true });
});

describe('Simple GPT Live credential startup', () => {
  test('does not touch secure storage when no credential was saved', async () => {
    expect(await readSimpleLiveApiKey()).toBeNull();
    expect(isEncryptionAvailable).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
  });
});
