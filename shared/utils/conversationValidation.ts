/**
 * Shared conversation validation utilities
 * Used by both Electron IPC handlers and HTTP handlers
 */

/**
 * Validate conversationId format to prevent path traversal attacks
 * Format: conv-{timestamp}-{random_id}
 * Example: conv-1704067200000-abc123
 */
export function validateConversationId(conversationId: string): boolean {
  return /^conv-\d+-[a-z0-9_-]+$/i.test(conversationId);
}
