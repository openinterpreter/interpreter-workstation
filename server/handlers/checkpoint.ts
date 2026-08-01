/**
 * Checkpoint Handlers
 *
 * THE business logic for checkpoint management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import { checkpointManager } from '../utils/checkpointManager';

// ============================================================================
// Checkpoint Operations
// ============================================================================

export async function getCheckpoint(messageId: string): Promise<{
  success: boolean;
  checkpoint?: any;
}> {
  const checkpoint = await checkpointManager.getCheckpoint(messageId);
  return { success: !!checkpoint, checkpoint };
}

export async function restoreCheckpoint(
  messageId: string,
  type: 'before' | 'after',
  paths?: string[]
): Promise<any> {
  const result = await checkpointManager.restore(messageId, type, paths);
  return result;
}

export async function getCheckpointSettings(): Promise<{ settings: any }> {
  const settings = checkpointManager.getSettings();
  return { settings };
}

export async function setCheckpointSettings(settings: any): Promise<{ success: boolean }> {
  await checkpointManager.setSettings(settings);
  return { success: true };
}
