/**
 * Shared SSE (Server-Sent Events) utilities for browser dev mode.
 *
 * This module provides a central place for managing SSE clients and broadcasting
 * events. Both the main server and event emitters use this to push updates to
 * browser clients.
 */

import type { Response } from 'express';

// Connected SSE clients
const clients = new Set<Response>();

/**
 * Add a new SSE client connection
 */
export function addClient(res: Response): void {
  clients.add(res);
}

/**
 * Remove an SSE client connection
 */
export function removeClient(res: Response): void {
  clients.delete(res);
}

/**
 * Get the number of connected clients
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Broadcast an event to all connected SSE clients.
 *
 * @param channel - The event channel (e.g., 'approvals:created', 'workspace:files-changed')
 * @param data - The event data to send
 */
export function broadcast(channel: string, data: unknown): void {
  if (clients.size === 0) return;

  const message = `data: ${JSON.stringify({ channel, data })}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch (error) {
      // Client disconnected, remove from set
      console.error('[SSE] Error broadcasting to client:', error);
      clients.delete(client);
    }
  }
}

/**
 * Send a keepalive ping to all connected clients.
 * Call this periodically to prevent connection timeouts.
 */
export function sendKeepalive(): void {
  for (const client of clients) {
    try {
      client.write(':keepalive\n\n');
    } catch {
      clients.delete(client);
    }
  }
}
