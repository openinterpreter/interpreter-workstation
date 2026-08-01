import type { VaultNoteContext, VaultSnapshot, VaultTagSummary } from '../../shared/types/vault';
import {
  getVaultNoteContext,
  getVaultSnapshot,
  getVaultTagSummaries,
  searchVaultNotes,
} from '../utils/vaultIndex';

export async function getSnapshot(): Promise<VaultSnapshot> {
  return getVaultSnapshot();
}

export async function getNoteContext(filePath: string): Promise<VaultNoteContext> {
  return getVaultNoteContext(filePath);
}

export async function getTags(limit?: number): Promise<{ tags: VaultTagSummary[] }> {
  return getVaultTagSummaries({ limit });
}

export async function searchNotes(query: string, limit?: number) {
  return searchVaultNotes(query, { limit });
}
