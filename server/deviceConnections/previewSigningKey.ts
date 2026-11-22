/**
 * Signing key for short-lived Simple preview tickets and preview cookies.
 *
 * INTERPRETER_WORKSTATION_SESSION_SECRET is used when an operator configures
 * it. Otherwise a random key is created once and kept in the app data
 * directory, readable only by its owner, so signed cookies survive a restart.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'preview-signing-key';
let cachedKey: string | null = null;

export function readOrCreatePreviewSigningKey(directory: string): string {
  const file = path.join(directory, KEY_FILE);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

export async function getPreviewSigningKey(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configured = environment.INTERPRETER_WORKSTATION_SESSION_SECRET?.trim();
  if (configured) return configured;
  if (cachedKey) return cachedKey;
  const { getInterpreterAppDataDir } = await import('../configStore');
  cachedKey = readOrCreatePreviewSigningKey(getInterpreterAppDataDir());
  return cachedKey;
}
