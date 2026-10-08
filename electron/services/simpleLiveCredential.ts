import { app, safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CREDENTIAL_FILENAME = 'simple-live-key.enc';

function credentialPath(): string {
  return path.join(app.getPath('userData'), 'credentials', CREDENTIAL_FILENAME);
}

export async function readSimpleLiveApiKey(): Promise<string | null> {
  let encrypted: Buffer;
  try {
    // Read first so a new Simple-mode install with no GPT Live credential does
    // not wake macOS Keychain merely by rendering onboarding or Settings.
    encrypted = await readFile(credentialPath());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('[SimpleLive] Could not read the encrypted credential:', error instanceof Error ? error.message : error);
    }
    return null;
  }

  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const value = safeStorage.decryptString(encrypted).trim();
    return value || null;
  } catch (error) {
    console.warn('[SimpleLive] Could not decrypt the encrypted credential:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function saveSimpleLiveApiKey(apiKey: string): Promise<void> {
  const value = apiKey.trim();
  if (!value) throw new Error('Enter an OpenAI API key.');
  if (value.length > 512) throw new Error('The OpenAI API key is too long.');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this computer.');
  }
  const filePath = credentialPath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, safeStorage.encryptString(value), { mode: 0o600 });
}

export async function clearSimpleLiveApiKey(): Promise<void> {
  await rm(credentialPath(), { force: true });
}
