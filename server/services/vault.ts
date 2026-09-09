/**
 * PII vault access — reads the caller-persisted encrypted rehydration blob
 * and decrypts it through basemind's `vault` MCP tool.
 *
 * basemind stays stateless here: the encrypted blob lives at
 * `{userData}/vaults/{docId}.enc` and only the decrypted map for the
 * requested document is ever returned to the renderer.
 */

import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';

import { ToolManager } from '../tools/toolManager';

export function sanitizeVaultDocId(docId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) {
    throw new Error('[vault] Invalid document id for rehydration lookup');
  }
  return docId;
}

export function resolveUserDataDir(): string {
  const override = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (override) return override;
  if (process.versions.electron) {
    const { app } = require('electron') as { app: { getPath(name: 'userData'): string } };
    return app.getPath('userData');
  }
  return path.join(homedir(), '.interpreter');
}

export function resolveVaultBlobPath(docId: string, userDataDir = resolveUserDataDir()): string {
  return path.join(userDataDir, 'vaults', `${sanitizeVaultDocId(docId)}.enc`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Extract the decrypted token→original map from a basemind `vault` tool result. */
export function extractRehydrationMap(result: unknown): Record<string, string> {
  const record = asRecord(result) ?? {};
  const structured = asRecord(record.structuredContent) ?? record;
  const payload = asRecord(structured.result) ?? structured;
  const candidates = [payload.map, payload.rehydration_map, payload];
  for (const candidate of candidates) {
    const map = asRecord(candidate);
    if (!map) continue;
    const entries = Object.entries(map).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    if (entries.length > 0) return Object.fromEntries(entries);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const block of content) {
    const text = asRecord(block)?.text;
    if (typeof text !== 'string') continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const map = asRecord(parsed) ?? asRecord(asRecord(parsed)?.result);
      if (!map) continue;
      const entries = Object.entries(map).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      );
      if (entries.length > 0) return Object.fromEntries(entries);
    } catch {
      continue;
    }
  }
  return {};
}

async function decrypt(docId: string, passphrase: string): Promise<Record<string, string>> {
  if (!passphrase) throw new Error('[vault] Passphrase is required to decrypt a rehydration map');
  const blobPath = resolveVaultBlobPath(docId);
  let encryptedBlob: string;
  try {
    encryptedBlob = fs.readFileSync(blobPath, 'utf8').trim();
  } catch {
    throw new Error('[vault] No stored rehydration map for this document');
  }
  if (!encryptedBlob) throw new Error('[vault] Stored rehydration map is empty');
  const manager = new ToolManager();
  const raw = await manager.callTool('basemind', 'vault', {
    mode: 'decrypt',
    encrypted_blob: encryptedBlob,
    passphrase,
  });
  const map = extractRehydrationMap(raw);
  if (Object.keys(map).length === 0) {
    throw new Error('[vault] Decryption returned no entries; check the passphrase');
  }
  return map;
}

export const vaultManager = { decrypt };
