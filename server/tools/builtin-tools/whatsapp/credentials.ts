/**
 * WhatsApp credential management.
 * Ported from Open Claw's auth-store.ts patterns:
 * - Credential backup before every save (prevents corruption from abrupt restarts)
 * - Automatic restore from backup if creds.json is corrupted/truncated
 * - Safe serialized save queue to prevent concurrent writes
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import type { WhatsAppCredentials } from './types';

const CONFIG_DIR = join(os.homedir(), '.interpreter');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'whatsapp-credentials.json');
export const AUTH_DIR = join(CONFIG_DIR, 'whatsapp-auth');

function resolveCredsPath(): string {
  return join(AUTH_DIR, 'creds.json');
}

function resolveCredsBackupPath(): string {
  return join(AUTH_DIR, 'creds.json.bak');
}

/**
 * Read raw creds.json content synchronously, returning null if missing/empty/unreadable.
 * Ported from Open Claw auth-store.ts.
 */
function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * If creds.json is corrupted/missing but a valid backup exists, restore it.
 * Called before socket initialization to recover from abrupt shutdowns.
 * Ported from Open Claw auth-store.ts.
 */
export function maybeRestoreCredsFromBackup(): void {
  try {
    const credsPath = resolveCredsPath();
    const backupPath = resolveCredsBackupPath();

    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      JSON.parse(raw); // validate parseable
      return; // creds.json is fine
    }

    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) return;

    JSON.parse(backupRaw); // validate backup is parseable
    copyFileSync(backupPath, credsPath);
    console.log('[WhatsApp] Restored corrupted creds.json from backup');
  } catch {
    // ignore - best effort
  }
}

/**
 * Backup current creds.json before saving new credentials.
 * Only overwrites backup if current creds.json is valid JSON.
 * Ported from Open Claw session.ts safeSaveCreds.
 */
export function backupCredsBeforeSave(): void {
  try {
    const credsPath = resolveCredsPath();
    const backupPath = resolveCredsBackupPath();
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      JSON.parse(raw); // only backup if current is valid
      copyFileSync(credsPath, backupPath);
    }
  } catch {
    // keep existing backup if anything fails
  }
}

/**
 * Serialized credential save queue.
 * Prevents concurrent writes that could corrupt creds.json.
 * Ported from Open Claw session.ts enqueueSaveCreds.
 */
let credsSaveQueue: Promise<void> = Promise.resolve();

export function enqueueSaveCreds(saveCreds: () => Promise<void> | void): void {
  credsSaveQueue = credsSaveQueue
    .then(async () => {
      backupCredsBeforeSave();
      try {
        await Promise.resolve(saveCreds());
      } catch (err) {
        console.error('[WhatsApp] Failed saving creds:', err);
      }
    })
    .catch((err) => {
      console.error('[WhatsApp] Creds save queue error:', err);
    });
}

/**
 * Check if Baileys auth state exists on disk (has valid creds.json).
 */
export function hasAuthState(): boolean {
  try {
    const credsPath = resolveCredsPath();
    const stats = statSync(credsPath);
    if (!stats.isFile() || stats.size <= 1) return false;
    const raw = readFileSync(credsPath, 'utf-8');
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the self-JID from stored creds (the connected phone number).
 */
export function readSelfId(): { phoneNumber: string | null; jid: string | null } {
  try {
    const credsPath = resolveCredsPath();
    if (!existsSync(credsPath)) return { phoneNumber: null, jid: null };
    const raw = readFileSync(credsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
    const jid = parsed?.me?.id ?? null;
    const phoneNumber = jid ? jid.split('@')[0].split(':')[0] : null;
    return { phoneNumber, jid };
  } catch {
    return { phoneNumber: null, jid: null };
  }
}

// --- High-level credentials (our own metadata, separate from Baileys auth) ---

export async function loadCredentials(): Promise<WhatsAppCredentials | null> {
  try {
    const data = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: WhatsAppCredentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

export async function deleteCredentials(): Promise<void> {
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      await rm(CREDENTIALS_PATH);
    }
    if (existsSync(AUTH_DIR)) {
      await rm(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('[WhatsApp] Failed to delete credentials:', err);
  }
}

export function isConfigured(): boolean {
  return existsSync(CREDENTIALS_PATH) || hasAuthState();
}
