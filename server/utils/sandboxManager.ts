/**
 * Manages the interpreter sandbox folder for storing large tool outputs
 *
 * This folder is:
 * - Located at ~/.interpreter/sandbox/
 * - Always readable/writable by all agents (enforced in permissions.ts)
 * - Cleaned up on server startup and shutdown
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getInterpreterHomeDir } from '../configStore';

/**
 * The sandbox directory path (~/.interpreter/sandbox/)
 * This is a consistent, predictable location that ALL agents can read/write
 */
function resolveSandboxDir(): string {
  return path.join(getInterpreterHomeDir(), 'sandbox');
}

/**
 * Get the sandbox directory path
 */
export function getSandboxDir(): string {
  return resolveSandboxDir();
}

/**
 * Initialize the sandbox directory
 * - Creates the directory if it doesn't exist
 * - Cleans up any existing files from previous sessions
 */
export async function initializeSandbox(): Promise<void> {
  try {
    // Try to clean up first
    await cleanupSandbox();
  } catch (error) {
    // Directory might not exist yet, that's okay
  }

  // Create fresh directory
  try {
    const sandboxDir = resolveSandboxDir();
    await fs.mkdir(sandboxDir, { recursive: true });
    console.log('[Sandbox] Initialized at:', sandboxDir);
  } catch (error: any) {
    console.error('[Sandbox] Failed to create directory:', error.message);
    throw error;
  }
}

/**
 * Clean up the sandbox directory
 * - Removes all files in the directory
 * - Called on startup and shutdown
 */
export async function cleanupSandbox(): Promise<void> {
  try {
    const sandboxDir = resolveSandboxDir();
    // Check if directory exists
    try {
      await fs.access(sandboxDir);
    } catch {
      // Directory doesn't exist, nothing to clean
      return;
    }

    // Remove all files in the directory
    const files = await fs.readdir(sandboxDir);
    for (const file of files) {
      const filePath = path.join(sandboxDir, file);
      try {
        await fs.unlink(filePath);
      } catch (error: any) {
        console.error('[Sandbox] Failed to delete file:', filePath, error.message);
      }
    }

    console.log('[Sandbox] Cleaned up:', files.length, 'files removed');
  } catch (error: any) {
    console.error('[Sandbox] Cleanup failed:', error.message);
  }
}

/**
 * Write content to a file in the sandbox
 * Returns the absolute path to the created file
 */
export async function writeSandboxFile(
  prefix: string,
  content: string
): Promise<string> {
  // Generate unique filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const randomId = randomBytes(4).toString('hex');
  const filename = `${prefix}-${timestamp}-${randomId}.txt`;
  const filePath = path.join(resolveSandboxDir(), filename);

  // Write the file
  await fs.writeFile(filePath, content, 'utf-8');

  console.log('[Sandbox] Written file:', filePath, `(${content.length} characters)`);

  return filePath;
}

/**
 * Check if a path is within the sandbox directory
 */
export function isSandboxPath(filePath: string): boolean {
  const normalizedPath = path.resolve(filePath);
  const normalizedSandbox = path.resolve(resolveSandboxDir());
  return normalizedPath === normalizedSandbox || normalizedPath.startsWith(normalizedSandbox + path.sep);
}
