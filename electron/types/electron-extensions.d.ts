/**
 * Type extensions for Electron APIs that are missing from @types/electron
 */

import type { BrowserWindow } from 'electron';

declare module 'electron' {
  interface WebContents {
    /**
     * Returns the BrowserWindow that owns this WebContents, or null if not owned by one.
     * This method exists at runtime but is missing from some @types/electron versions.
     */
    getOwnerBrowserWindow(): BrowserWindow | null;
  }
}

export {};
