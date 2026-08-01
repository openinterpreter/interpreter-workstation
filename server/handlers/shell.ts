/**
 * Shell Handlers
 *
 * ONE implementation of shell operations.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export async function revealInFinder(filePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      await execAsync(`open -R "${filePath}"`);
    } else if (platform === 'win32') {
      await execAsync(`explorer /select,"${filePath}"`);
    } else {
      // Linux - open parent directory
      await execAsync(`xdg-open "${path.dirname(filePath)}"`);
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function openExternal(url: string): Promise<{ success: boolean; error?: string }> {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      await execAsync(`open "${url}"`);
    } else if (platform === 'win32') {
      await execAsync(`start "" "${url}"`);
    } else {
      await execAsync(`xdg-open "${url}"`);
    }
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
