/**
 * Telegram credential management.
 * Stores credentials at ~/.interpreter/telegram-credentials.json
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import type { TelegramCredentials } from './types';

const CONFIG_DIR = join(os.homedir(), '.interpreter');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'telegram-credentials.json');

export async function loadCredentials(): Promise<TelegramCredentials | null> {
  try {
    const data = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: TelegramCredentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

export async function deleteCredentials(): Promise<void> {
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      await rm(CREDENTIALS_PATH);
    }
  } catch (err) {
    console.error('[Telegram] Failed to delete credentials:', err);
  }
}

export function isConfigured(): boolean {
  return existsSync(CREDENTIALS_PATH);
}
