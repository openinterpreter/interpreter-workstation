/**
 * Unified Event Broadcasting
 *
 * ONE function to broadcast events to all connected clients.
 * Works in both Electron (IPC) and Browser (SSE) modes.
 *
 * Backend code calls: broadcastEvent('theme:changed', { theme: 'dark' })
 * Frontend listens via: theme.onChanged(callback)
 *
 * The transport (IPC vs SSE) is abstracted away.
 */

import { broadcast as sseBroadcast } from '../utils/sse';

export interface BroadcastScope {
  windowSessionKey?: string;
  workspacePath?: string | null;
}

// In Electron mode, this will be set by the main process
let electronBroadcaster: ((channel: string, data: unknown, scope?: BroadcastScope) => void) | null = null;

/**
 * Set the Electron broadcaster function.
 * Called from electron/ipc/handlers.ts during initialization.
 */
export function setElectronBroadcaster(
  broadcaster: (channel: string, data: unknown, scope?: BroadcastScope) => void
): void {
  electronBroadcaster = broadcaster;
}

/**
 * Broadcast an event to all connected clients.
 * Works in both Electron and Browser modes.
 *
 * Broadcasts to BOTH IPC (Electron windows) and SSE (browser clients).
 * In pure Electron mode, SSE has no clients so it's a no-op.
 * In browser dev mode, both channels may have listeners.
 *
 * @param channel - Event channel (e.g., 'theme:changed', 'approvals:created')
 * @param data - Event payload
 */
export function broadcastEvent(channel: string, data: unknown, scope?: BroadcastScope): void {
  // Broadcast to Electron windows via IPC (if available)
  if (electronBroadcaster) {
    electronBroadcaster(channel, data, scope);
  }

  // Broadcast to browser clients via SSE (always, no-op if no clients)
  sseBroadcast(channel, data);
}
