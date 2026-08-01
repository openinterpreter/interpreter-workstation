/**
 * Checkpoint Manager
 *
 * Manages file checkpoints for edit operations.
 * Stores before/after snapshots of files indexed by messageId.
 *
 * Storage structure:
 * ~/.interpreter/checkpoints/
 * ├── {messageIdHash}/
 * │   ├── before/
 * │   │   └── {filename}
 * │   ├── after/
 * │   │   └── {filename}
 * │   └── metadata.json
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { emitEvent } from './ipcBridge';
import { IPC_CHANNELS } from '../../electron/ipc/registry';
import { approvalManager } from '../approvalManager';
import { getCurrentWorkspace } from './workspace';
import { getInterpreterHomeDir } from '../configStore';

function getWorkstationDir(): string {
  return getInterpreterHomeDir();
}

function getCheckpointsDir(): string {
  return path.join(getWorkstationDir(), 'checkpoints');
}

function getSettingsFile(): string {
  return path.join(getWorkstationDir(), 'checkpoint-settings.json');
}

function hashId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getCheckpointDir(messageId: string): string {
  return path.join(getCheckpointsDir(), hashId(messageId));
}

function getCheckpointFileId(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex');
}

function normalizePathForComparison(filePath: string): string {
  const normalized = path.resolve(path.normalize(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function parseCheckpointTimestamp(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Validate that a file path's realpath is within the workspace.
 * This prevents symlink attacks where a symlink points outside the workspace.
 * Returns the realpath if valid, or null if the path escapes the workspace.
 */
async function validatePathWithinWorkspace(filePath: string, workspaceOverride?: string | null): Promise<string | null> {
  const workspace = workspaceOverride ?? getCurrentWorkspace();
  if (!workspace) {
    // No workspace set - allow the operation but log a warning
    console.warn('[CheckpointManager] No workspace set, skipping symlink validation');
    return filePath;
  }

  try {
    // Get the parent directory of the file
    const parentDir = path.dirname(filePath);

    // Try to resolve the realpath of the parent directory
    // (the file itself may not exist yet for new files)
    let realParentPath: string;
    try {
      realParentPath = await fs.realpath(parentDir);
    } catch {
      // Parent doesn't exist - use the path as-is
      realParentPath = parentDir;
    }

    // If the file exists, check its realpath directly
    let realFilePath: string;
    try {
      realFilePath = await fs.realpath(filePath);
    } catch {
      // File doesn't exist yet - construct from real parent path
      realFilePath = path.join(realParentPath, path.basename(filePath));
    }

    // Get the realpath of the workspace
    let realWorkspace: string;
    try {
      realWorkspace = await fs.realpath(workspace);
    } catch {
      realWorkspace = workspace;
    }

    // Check if the real path is within the workspace
    if (!realFilePath.startsWith(realWorkspace + path.sep) && realFilePath !== realWorkspace) {
      console.error(`[CheckpointManager] Security: Path escapes workspace via symlink: ${filePath} -> ${realFilePath}`);
      return null;
    }

    return realFilePath;
  } catch (error: any) {
    console.error(`[CheckpointManager] Error validating path: ${error.message}`);
    return null;
  }
}

/**
 * Checkpoint settings
 */
export interface CheckpointSettings {
  enabled: boolean;
  retentionDays: number;
  requireApprovalForLargeFiles: boolean;
}

// 10MB limit for checkpointing
const LARGE_FILE_LIMIT_BYTES = 10 * 1024 * 1024;

const DEFAULT_SETTINGS: CheckpointSettings = {
  enabled: true,
  retentionDays: 7,
  requireApprovalForLargeFiles: true,
};

/**
 * Result of checkpoint creation attempt
 */
export interface CheckpointResult {
  created: boolean;
  skippedDueToSize: boolean;
  approvalRequired: boolean;
  approved?: boolean;
  totalSizeBytes?: number;
  files?: string[];
}

/**
 * Compute MD5 hash of a file for comparison
 */
async function getFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Get total size of files in bytes
 */
async function getTotalFileSize(filePaths: string[]): Promise<{ totalBytes: number; fileSizes: Map<string, number> }> {
  let totalBytes = 0;
  const fileSizes = new Map<string, number>();

  for (const filePath of filePaths) {
    try {
      const stats = await fs.stat(filePath);
      fileSizes.set(filePath, stats.size);
      totalBytes += stats.size;
    } catch {
      // File doesn't exist, skip
    }
  }

  return { totalBytes, fileSizes };
}

/**
 * Recursively collect all regular files under a directory.
 * Symlinks and special files are skipped.
 */
async function getDirectoryFilesRecursive(directoryPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (err: any) {
      console.error(`[CheckpointManager] Error reading directory ${currentPath}:`, err.message);
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isFile()) {
        files.push(entryPath);
      } else if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(directoryPath);
  return files;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface CheckpointFileEntry {
  path: string;
  fileId: string;
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface CheckpointMetadata {
  messageId: string;
  files: CheckpointFileEntry[];
  timestamp: string;
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface LatestFileCheckpoint {
  messageId: string;
  filePath: string;
  timestamp: string;
}

class CheckpointManager {
  private initialized = false;
  private settings: CheckpointSettings = { ...DEFAULT_SETTINGS };

  /**
   * Initialize the checkpoint manager
   * Creates the checkpoints directory if it doesn't exist
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const checkpointsDir = getCheckpointsDir();
      await fs.mkdir(checkpointsDir, { recursive: true });

      // Load settings
      await this.loadSettings();

      console.log('[CheckpointManager] Initialized at:', checkpointsDir);
      this.initialized = true;

      // Clean up old checkpoints in background (don't block startup)
      this.cleanupOldCheckpoints().catch(err => {
        console.error('[CheckpointManager] Background cleanup failed:', err.message);
      });
    } catch (error: any) {
      console.error('[CheckpointManager] Failed to initialize:', error.message);
      throw error;
    }
  }

  /**
   * Load settings from disk
   */
  private async loadSettings(): Promise<void> {
    try {
      const content = await fs.readFile(getSettingsFile(), 'utf-8');
      const saved = JSON.parse(content);
      this.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch {
      // Use defaults if file doesn't exist or is invalid
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Save settings to disk
   */
  private async saveSettings(): Promise<void> {
    await fs.mkdir(getWorkstationDir(), { recursive: true });
    await fs.writeFile(getSettingsFile(), JSON.stringify(this.settings, null, 2));
  }

  /**
   * Get current settings
   */
  getSettings(): CheckpointSettings {
    return { ...this.settings };
  }

  /**
   * Update settings
   */
  async setSettings(updates: Partial<CheckpointSettings>): Promise<CheckpointSettings> {
    this.settings = { ...this.settings, ...updates };
    await this.saveSettings();

    // Emit change event
    emitEvent(IPC_CHANNELS.CHECKPOINT_SETTINGS_CHANGED, { settings: this.settings });

    return { ...this.settings };
  }

  /**
   * Check if checkpoints are enabled
   */
  isEnabled(): boolean {
    return this.settings.enabled;
  }

  /**
   * Create a "before" checkpoint for the given files
   * Only creates checkpoint for files that already exist (not new files being created)
   * If files exceed 10MB and requireApprovalForLargeFiles is enabled, requests user approval instead
   */
  async createBeforeCheckpoint(
    messageId: string,
    filePaths: string[],
    options?: { force?: boolean }
  ): Promise<CheckpointResult> {
    const force = options?.force === true;

    // Skip if checkpoints are disabled
    if (!this.settings.enabled && !force) {
      console.log('[CheckpointManager] Checkpoints disabled, skipping');
      return { created: false, skippedDueToSize: false, approvalRequired: false };
    }
    if (!this.settings.enabled && force) {
      console.log('[CheckpointManager] Checkpoints disabled in settings, but force mode is enabled for this operation');
    }

    if (!messageId) {
      console.warn('[CheckpointManager] No messageId provided, skipping checkpoint');
      return { created: false, skippedDueToSize: false, approvalRequired: false };
    }

    try {
      const uniquePaths = Array.from(new Set(filePaths));
      // First, check which files actually exist
      const existingFiles: string[] = [];
      for (const filePath of uniquePaths) {
        try {
          const stats = await fs.stat(filePath);
          if (stats.isDirectory()) {
            const nestedFiles = await getDirectoryFilesRecursive(filePath);
            if (nestedFiles.length === 0) {
              console.log(`[CheckpointManager] Directory has no files to checkpoint: ${filePath}`);
            } else {
              existingFiles.push(...nestedFiles);
            }
            continue;
          }

          if (!stats.isFile()) {
            continue;
          }
          existingFiles.push(filePath);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            // File doesn't exist yet (will be created) - skip entirely
            console.log(`[CheckpointManager] Skipping new file (no checkpoint needed): ${filePath}`);
          }
        }
      }

      const uniqueExistingFiles = Array.from(new Set(existingFiles));
      if (uniqueExistingFiles.length === 0) {
        console.log(`[CheckpointManager] No existing files to checkpoint for ${messageId}`);
        return { created: false, skippedDueToSize: false, approvalRequired: false };
      }

      const checkpointDir = getCheckpointDir(messageId);
      const metadataPath = path.join(checkpointDir, 'metadata.json');
      const beforeDir = path.join(checkpointDir, 'before');

      let metadata: CheckpointMetadata | null = null;
      try {
        const existing = await fs.readFile(metadataPath, 'utf-8');
        metadata = JSON.parse(existing);
      } catch {
        metadata = null;
      }

      const existingEntries = metadata?.files ?? [];
      const alreadyCheckpointed = new Set(
        existingEntries.filter(entry => entry.hasBefore).map(entry => entry.path)
      );

      const newFiles = uniqueExistingFiles.filter(filePath => !alreadyCheckpointed.has(filePath));
      if (newFiles.length === 0) {
        return { created: false, skippedDueToSize: false, approvalRequired: false };
      }

      // Check total file size for new files only
      const { totalBytes, fileSizes } = await getTotalFileSize(newFiles);

      // If files exceed limit and approval is required, ask user
      if (!force && totalBytes > LARGE_FILE_LIMIT_BYTES && this.settings.requireApprovalForLargeFiles) {
        const checkpointLimit = formatBytes(LARGE_FILE_LIMIT_BYTES);
        const totalSize = formatBytes(totalBytes);
        console.log(`[CheckpointManager] Files exceed ${checkpointLimit} limit (${totalSize}), requesting approval`);

        const workspace = getCurrentWorkspace();
        const displayPaths = newFiles.map((filePath) => {
          if (workspace &&
            (filePath === workspace || filePath.startsWith(workspace + path.sep))) {
            const rel = path.relative(workspace, filePath);
            return rel || path.basename(filePath);
          }
          return filePath;
        });

        // Build file list with sizes for display
        const fileDetails = newFiles.map((filePath, index) => {
          const size = fileSizes.get(filePath) || 0;
          return `${displayPaths[index]} (${formatBytes(size)})`;
        });

        // Request approval
        const approved = await approvalManager.createApproval(
          'replace_text_in_docx',
          'checkpoint-manager',
          {
            message: 'Large file edit requires approval',
            description: 'Checkpoint backup will be skipped for this edit.',
            reason: `Total selected file size (${totalSize}) exceeds the checkpoint limit (${checkpointLimit}).`,
            warning: 'These files will be edited directly without a checkpoint backup.',
            paths: displayPaths,
            files: fileDetails,
            totalSize,
            checkpointLimit,
          },
          60000, // 60 second timeout
          messageId
        );

        if (!approved) {
          throw new Error('User denied the edit request for large files');
        }

        console.log(`[CheckpointManager] User approved large file edit without checkpoint`);
        return {
          created: false,
          skippedDueToSize: true,
          approvalRequired: true,
          approved: true,
          totalSizeBytes: totalBytes,
          files: newFiles,
        };
      }
      if (force && totalBytes > LARGE_FILE_LIMIT_BYTES) {
        console.log(`[CheckpointManager] Force mode enabled; checkpointing ${formatBytes(totalBytes)} without large-file bypass`);
      }

      emitEvent(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, {
        messageId,
        type: 'before',
        state: 'saving',
      });

      // Normal checkpoint creation
      await fs.mkdir(beforeDir, { recursive: true });

      const copiedFiles: string[] = [];
      const updatedEntries = [...existingEntries];

      for (const filePath of newFiles) {
        try {
          const fileId = getCheckpointFileId(filePath);
          const destPath = path.join(beforeDir, fileId);
          await fs.copyFile(filePath, destPath);
          copiedFiles.push(filePath);

          const existingEntryIndex = updatedEntries.findIndex(entry => entry.path === filePath);
          if (existingEntryIndex >= 0) {
            updatedEntries[existingEntryIndex] = {
              ...updatedEntries[existingEntryIndex],
              fileId,
              hasBefore: true,
            };
          } else {
            updatedEntries.push({
              path: filePath,
              fileId,
              hasBefore: true,
              hasAfter: false,
            });
          }

          console.log(`[CheckpointManager] Before checkpoint: ${filePath} -> ${destPath}`);
        } catch (err: any) {
          console.error(`[CheckpointManager] Error copying file ${filePath}:`, err.message);
        }
      }

      if (copiedFiles.length === 0) {
        throw new Error('No files could be checkpointed.');
      }

      if (copiedFiles.length > 0) {
        const updatedMetadata: CheckpointMetadata = {
          messageId,
          files: updatedEntries,
          timestamp: metadata?.timestamp ?? new Date().toISOString(),
          hasBefore: true,
          hasAfter: updatedEntries.some(entry => entry.hasAfter),
        };

        await fs.mkdir(checkpointDir, { recursive: true });
        await fs.writeFile(metadataPath, JSON.stringify(updatedMetadata, null, 2));

        emitEvent(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, {
          messageId,
          type: 'before',
          state: 'saved',
          checkpoint: updatedMetadata,
        });

        console.log(`[CheckpointManager] Created before checkpoint for ${messageId}: ${copiedFiles.length} files`);
      }

      return { created: copiedFiles.length > 0, skippedDueToSize: false, approvalRequired: false };
    } catch (error: any) {
      // Check for specific error types and provide descriptive messages
      let errorMessage = `Failed to create checkpoint: ${error.message}`;

      if (error.code === 'ENOSPC') {
        errorMessage = 'Failed to create checkpoint: Disk is full. Please free up disk space and try again.';
      } else if (error.code === 'EACCES' || error.code === 'EPERM') {
        errorMessage = `Failed to create checkpoint: Permission denied writing to ${getCheckpointsDir()}. Check directory permissions.`;
      } else if (error.code === 'EROFS') {
        errorMessage = 'Failed to create checkpoint: Filesystem is read-only.';
      } else if (error.code === 'EDQUOT') {
        errorMessage = 'Failed to create checkpoint: Disk quota exceeded.';
      } else if (error.message.includes('denied')) {
        // User denied approval - pass through
        errorMessage = error.message;
      }

      emitEvent(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, {
        messageId,
        type: 'before',
        state: 'error',
        error: errorMessage,
      });

      console.error('[CheckpointManager] Error creating before checkpoint:', errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Create an "after" checkpoint for the given message
   * Only creates if there's already a "before" checkpoint (i.e., files existed before edit)
   */
  async createAfterCheckpoint(messageId: string): Promise<void> {
    if (!messageId) {
      console.warn('[CheckpointManager] No messageId provided, skipping checkpoint');
      return;
    }

    const checkpointDir = getCheckpointDir(messageId);
    const metadataPath = path.join(checkpointDir, 'metadata.json');

    try {
      // Check if there's already a "before" checkpoint - if not, skip
      let metadata: CheckpointMetadata;
      try {
        const existing = await fs.readFile(metadataPath, 'utf-8');
        metadata = JSON.parse(existing);
      } catch {
        // No existing metadata means no "before" checkpoint was created
        console.log(`[CheckpointManager] No before checkpoint exists for ${messageId}, skipping after checkpoint`);
        return;
      }

      if (!metadata.hasBefore) {
        console.log(`[CheckpointManager] Before checkpoint is empty for ${messageId}, skipping after checkpoint`);
        return;
      }

      const beforeDir = path.join(checkpointDir, 'before');
      const afterDir = path.join(checkpointDir, 'after');

      const copiedFiles: string[] = [];
      let skippedUnchanged = 0;
      let emittedSaving = false;

      const updatedEntries = metadata.files.map(entry => ({ ...entry }));

      // Only checkpoint files that were in the "before" checkpoint
      for (const entry of updatedEntries) {
        if (!entry.hasBefore) continue;
        const filePath = entry.path;
        try {
          await fs.access(filePath);

          const beforePath = path.join(beforeDir, entry.fileId);

          // Compare hashes - skip if file hasn't changed (deduplication)
          try {
            const beforeHash = await getFileHash(beforePath);
            const afterHash = await getFileHash(filePath);

            if (beforeHash === afterHash) {
              console.log(`[CheckpointManager] Skipping unchanged file: ${filePath}`);
              skippedUnchanged++;
              continue;
            }
          } catch {
            // If we can't compare hashes, proceed with copy
          }

          if (!emittedSaving) {
            emitEvent(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, {
              messageId,
              type: 'after',
              state: 'saving',
            });
            emittedSaving = true;
          }

          if (copiedFiles.length === 0) {
            await fs.mkdir(afterDir, { recursive: true });
          }

          const destPath = path.join(afterDir, entry.fileId);
          await fs.copyFile(filePath, destPath);
          copiedFiles.push(filePath);
          entry.hasAfter = true;

          console.log(`[CheckpointManager] After checkpoint: ${filePath} -> ${destPath}`);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            console.log(`[CheckpointManager] Skipping deleted file: ${filePath}`);
          } else {
            console.error(`[CheckpointManager] Error copying file ${filePath}:`, err.message);
          }
        }
      }

      metadata.hasAfter = copiedFiles.length > 0;
      metadata.files = updatedEntries;
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      if (skippedUnchanged > 0) {
        console.log(`[CheckpointManager] Skipped ${skippedUnchanged} unchanged file(s) for ${messageId}`);
      }

      if (metadata.hasAfter) {
        emitEvent(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, {
          messageId,
          type: 'after',
          state: 'saved',
          checkpoint: metadata,
        });
      }

      console.log(`[CheckpointManager] Created after checkpoint for ${messageId}: ${copiedFiles.length} files`);
    } catch (error: any) {
      // After checkpoint failure is less critical - edit already happened
      // But we should throw so caller can inform agent/UI
      let errorMessage = `Failed to create after checkpoint: ${error.message}`;

      if (error.code === 'ENOSPC') {
        errorMessage = 'Disk is full';
      } else if (error.code === 'EACCES' || error.code === 'EPERM') {
        errorMessage = 'Permission denied';
      } else if (error.code === 'EDQUOT') {
        errorMessage = 'Disk quota exceeded';
      }

      emitEvent(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, {
        messageId,
        type: 'after',
        state: 'error',
        error: errorMessage,
      });

      console.error('[CheckpointManager] After checkpoint failed:', errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Get checkpoint metadata for a messageId
   */
  async getCheckpoint(messageId: string): Promise<CheckpointMetadata | null> {
    if (!messageId) return null;

    const metadataPath = path.join(getCheckpointDir(messageId), 'metadata.json');

    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Find the most recent checkpoint containing a "before" snapshot for the given file.
   */
  async findLatestBeforeCheckpointForFile(
    filePath: string,
    options?: { excludeMessageId?: string }
  ): Promise<LatestFileCheckpoint | null> {
    if (!filePath) return null;

    await this.initialize();

    const targetPath = normalizePathForComparison(filePath);
    const checkpointsDir = getCheckpointsDir();
    const checkpointEntries = await fs.readdir(checkpointsDir, { withFileTypes: true });

    let latestMatch: (LatestFileCheckpoint & { timestampMs: number }) | null = null;

    for (const checkpointEntry of checkpointEntries) {
      if (!checkpointEntry.isDirectory()) continue;

      const metadataPath = path.join(checkpointsDir, checkpointEntry.name, 'metadata.json');
      let metadata: CheckpointMetadata;

      try {
        const content = await fs.readFile(metadataPath, 'utf-8');
        metadata = JSON.parse(content);
      } catch {
        continue;
      }

      if (options?.excludeMessageId && metadata.messageId === options.excludeMessageId) {
        continue;
      }

      if (!metadata.hasBefore) continue;
      if (!Array.isArray(metadata.files)) continue;

      const matchedFile = metadata.files.find(entry =>
        entry.hasBefore && normalizePathForComparison(entry.path) === targetPath
      );
      if (!matchedFile) continue;

      const timestampMs = parseCheckpointTimestamp(metadata.timestamp);
      if (!latestMatch || timestampMs > latestMatch.timestampMs) {
        latestMatch = {
          messageId: metadata.messageId,
          filePath: matchedFile.path,
          timestamp: metadata.timestamp,
          timestampMs,
        };
      }
    }

    if (!latestMatch) return null;
    return {
      messageId: latestMatch.messageId,
      filePath: latestMatch.filePath,
      timestamp: latestMatch.timestamp,
    };
  }

  /**
   * Restore a file from the latest available "before" checkpoint.
   */
  async restoreLatestBeforeForFile(
    filePath: string,
    options?: { excludeMessageId?: string; workspace?: string | null }
  ): Promise<{
    success: boolean;
    restored: string[];
    messageId?: string;
    timestamp?: string;
    error?: string;
  }> {
    if (!filePath) {
      return { success: false, restored: [], error: 'No file path provided' };
    }

    const latestCheckpoint = await this.findLatestBeforeCheckpointForFile(filePath, options);
    if (!latestCheckpoint) {
      return { success: false, restored: [], error: 'No checkpoint found for this file' };
    }

    const restoreResult = await this.restore(
      latestCheckpoint.messageId,
      'before',
      [latestCheckpoint.filePath],
      { workspace: options?.workspace }
    );
    if (!restoreResult.success) {
      return {
        ...restoreResult,
        messageId: latestCheckpoint.messageId,
        timestamp: latestCheckpoint.timestamp,
      };
    }

    return {
      success: true,
      restored: restoreResult.restored,
      messageId: latestCheckpoint.messageId,
      timestamp: latestCheckpoint.timestamp,
    };
  }

  /**
   * Restore files from a checkpoint
   */
  async restore(
    messageId: string,
    type: 'before' | 'after',
    paths?: string[],
    options?: { workspace?: string | null }
  ): Promise<{ success: boolean; restored: string[]; error?: string }> {
    if (!messageId) {
      return { success: false, restored: [], error: 'No messageId provided' };
    }

    const checkpointDir = getCheckpointDir(messageId);
    const sourceDir = path.join(checkpointDir, type);

    try {
      const metadata = await this.getCheckpoint(messageId);
      if (!metadata) {
        return { success: false, restored: [], error: 'Checkpoint not found' };
      }

      if (type === 'before' && !metadata.hasBefore) {
        return { success: false, restored: [], error: 'No before checkpoint available' };
      }
      if (type === 'after' && !metadata.hasAfter) {
        return { success: false, restored: [], error: 'No after checkpoint available' };
      }

      const pathFilter = paths && paths.length > 0 ? new Set(paths) : null;
      const targetEntries = pathFilter
        ? metadata.files.filter(entry => pathFilter.has(entry.path))
        : metadata.files;

      if (pathFilter && targetEntries.length === 0) {
        return { success: false, restored: [], error: 'No matching files in checkpoint' };
      }

      const restored: string[] = [];

      for (const entry of targetEntries) {
        if (type === 'before' && !entry.hasBefore) continue;
        if (type === 'after' && !entry.hasAfter) continue;

        const originalPath = entry.path;

        const validatedPath = await validatePathWithinWorkspace(originalPath, options?.workspace);
        if (!validatedPath) {
          console.error(`[CheckpointManager] Restore blocked: ${originalPath} resolves outside workspace`);
          continue;
        }

        const sourcePath = path.join(sourceDir, entry.fileId);

        try {
          await fs.copyFile(sourcePath, originalPath);
          restored.push(originalPath);
          console.log(`[CheckpointManager] Restored: ${sourcePath} -> ${originalPath}`);

          emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: originalPath });
        } catch (err: any) {
          console.error(`[CheckpointManager] Error restoring ${entry.fileId}:`, err.message);
        }
      }

      console.log(`[CheckpointManager] Restored ${restored.length} files from ${type} checkpoint`);
      if (restored.length === 0) {
        return { success: false, restored: [], error: 'No files restored' };
      }
      return { success: true, restored };
    } catch (error: any) {
      console.error('[CheckpointManager] Error restoring checkpoint:', error.message);
      return { success: false, restored: [], error: error.message };
    }
  }

  /**
   * Clean up old checkpoints (older than retention period from settings)
   */
  async cleanupOldCheckpoints(): Promise<void> {
    try {
      const retentionDays = this.settings.retentionDays;
      const checkpointsDir = getCheckpointsDir();
      const entries = await fs.readdir(checkpointsDir, { withFileTypes: true });
      const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      let cleaned = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const checkpointDir = path.join(checkpointsDir, entry.name);
        const metadataPath = path.join(checkpointDir, 'metadata.json');

        try {
          const content = await fs.readFile(metadataPath, 'utf-8');
          const metadata = JSON.parse(content);
          const timestamp = new Date(metadata.timestamp).getTime();

          if (timestamp < cutoff) {
            await fs.rm(checkpointDir, { recursive: true });
            cleaned++;
          }
        } catch {
          // Skip if can't read metadata
        }
      }

      if (cleaned > 0) {
        console.log(`[CheckpointManager] Cleaned up ${cleaned} old checkpoints`);
      }
    } catch (error: any) {
      console.error('[CheckpointManager] Error cleaning up checkpoints:', error.message);
    }
  }
}

// Export singleton instance
export const checkpointManager = new CheckpointManager();

/**
 * Try to create a "before" checkpoint.
 * Returns failure when force=true but no messageId is available.
 */
export async function tryCreateBeforeCheckpoint(
  messageId: string | undefined,
  filePaths: string[],
  options?: { force?: boolean }
): Promise<{ success: true } | { success: false; error: string }> {
  if (!messageId) {
    if (options?.force) {
      return { success: false, error: 'Checkpoint required but no messageId was provided for this operation.' };
    }
    return { success: true };
  }
  try {
    await checkpointManager.createBeforeCheckpoint(messageId, filePaths, options);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Try to create an "after" checkpoint. Returns error message if failed, null if success or skipped.
 */
export async function tryCreateAfterCheckpoint(
  messageId: string | undefined
): Promise<string | null> {
  if (!messageId) return null;
  try {
    await checkpointManager.createAfterCheckpoint(messageId);
    return null;
  } catch (err: any) {
    return err.message;
  }
}
