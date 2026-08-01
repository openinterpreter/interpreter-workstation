// =============================================================================
// SERVER LOGGING - Unified with electron/main.ts
//
// HOW IT WORKS:
// - electron/main.ts overrides console.log/error/warn/info globally
// - All console calls in server code automatically go to the unified log file
// - The LOG_FILE env var is set by main.ts before any server modules load
//
// This module exports utilities for:
// - Getting the current log file path
// - Writing log entries with consistent formatting
//
// You can use regular console.log() calls - they will be captured.
// Use logger.log() if you need to write directly to the file (rare).
// =============================================================================

import fs from 'fs';

export const logger = {
  /**
   * Get the current log file path
   */
  getLogPath(): string {
    return process.env.LOG_FILE || '/tmp/workstation-fallback.log';
  },

  /**
   * Write a log entry directly to the log file (bypasses console override)
   * Use this only if you need to log without going through console.
   * Most code should just use console.log() instead.
   */
  write(prefix: string, message: string): void {
    const logPath = this.getLogPath();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${prefix}] ${message}\n`;
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      // Silent fail - don't break the app if logging fails
    }
  },
};
