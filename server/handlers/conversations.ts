/**
 * Conversations Handlers
 *
 * THE business logic for conversation save/load/list/delete.
 * Both Electron IPC and HTTP routes call these same functions.
 *
 * Storage location: ~/.interpreter/conversations/{conversationId}.chat
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { validateConversationId } from '../../shared/utils/conversationValidation';
import { stripWorkstationContext } from '../../shared/utils/formatWorkstationContext';

// Import types from IPC registry to ensure consistency
import type {
  ConversationMetadata,
  SavedConversation,
  ConversationWithPreview,
} from '../../electron/ipc/registry';

// Re-export for backwards compatibility
export { validateConversationId };

// Global conversations directory
const WORKSTATION_DIR = path.join(os.homedir(), '.interpreter');
const CONVERSATIONS_DIR = path.join(WORKSTATION_DIR, 'conversations');

// ============================================================================
// Helper Functions
// ============================================================================

export async function ensureConversationsDir(): Promise<void> {
  await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
}

// ============================================================================
// Conversation Operations
// ============================================================================

export async function saveConversation(
  _workspace: string,
  conversation: any
): Promise<{ success: boolean; conversationId?: string; error?: string }> {
  // Frontend sends { conversationId, threadState, metadata, subagentToolCalls }
  const conversationId = conversation?.conversationId;

  if (!conversationId) {
    return { success: false, error: 'Invalid conversation data - missing conversationId' };
  }

  if (!validateConversationId(conversationId)) {
    return { success: false, error: 'Invalid conversation ID format' };
  }

  try {
    await ensureConversationsDir();
    const filePath = path.join(CONVERSATIONS_DIR, `${conversationId}.chat`);

    // Save the conversation object as-is (matches Electron IPC handler behavior)
    await fs.writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
    console.log('[Conversations Handler] Saved:', filePath);
    return { success: true, conversationId };
  } catch (error: any) {
    console.error('[Conversations Handler] Failed to save conversation:', error);
    return { success: false, error: error.message };
  }
}

export async function loadConversation(
  _workspace: string,
  conversationId: string
): Promise<{ success: boolean; conversation?: SavedConversation; error?: string }> {
  if (!conversationId) {
    return { success: false, error: 'Missing conversationId' };
  }

  if (!validateConversationId(conversationId)) {
    return { success: false, error: 'Invalid conversation ID format' };
  }

  try {
    const filePath = path.join(CONVERSATIONS_DIR, `${conversationId}.chat`);
    const content = await fs.readFile(filePath, 'utf-8');
    const conversation = JSON.parse(content) as SavedConversation;
    return { success: true, conversation };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return { success: false, error: 'Conversation not found' };
    }
    console.error('[Conversations Handler] Failed to load conversation:', error);
    return { success: false, error: error.message };
  }
}

export async function listConversations(
  _workspace?: string
): Promise<{ success: boolean; conversations: ConversationMetadata[]; error?: string }> {
  try {
    try {
      await fs.access(CONVERSATIONS_DIR);
    } catch {
      return { success: true, conversations: [] };
    }

    const files = await fs.readdir(CONVERSATIONS_DIR);
    const conversations: ConversationMetadata[] = [];

    for (const file of files) {
      if (!file.endsWith('.chat')) continue;
      try {
        const filePath = path.join(CONVERSATIONS_DIR, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as SavedConversation;
        conversations.push(parsed.metadata);
      } catch (error) {
        console.error(`[Conversations Handler] Failed to read conversation ${file}:`, error);
      }
    }

    conversations.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return { success: true, conversations };
  } catch (error: any) {
    console.error('[Conversations Handler] Failed to list conversations:', error);
    return { success: false, conversations: [], error: error.message };
  }
}

export async function listConversationsWithPreviews(
  _workspace?: string
): Promise<{ success: boolean; conversations: ConversationWithPreview[]; error?: string }> {
  try {
    try {
      await fs.access(CONVERSATIONS_DIR);
    } catch {
      return { success: true, conversations: [] };
    }

    const files = await fs.readdir(CONVERSATIONS_DIR);
    const conversations: ConversationWithPreview[] = [];

    for (const file of files) {
      if (!file.endsWith('.chat')) continue;
      try {
        const filePath = path.join(CONVERSATIONS_DIR, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as SavedConversation;

        // Extract message previews
        const messages = parsed.threadState?.messages || [];
        const userMessages = messages.filter((m: any) => m.message?.role === 'user');

        function extractTextContent(message: any): string {
          if (!message?.content) return '';
          const textParts = message.content.filter((p: any) => p.type === 'text');
          const raw = textParts.map((p: any) => p.text || '').join(' ');
          return stripWorkstationContext(raw).slice(0, 200);
        }

        // Last message preview: walk backwards to find last message with text
        let lastPreview = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const text = extractTextContent(messages[i]?.message);
          if (text) {
            lastPreview = text;
            break;
          }
        }

        conversations.push({
          ...parsed.metadata,
          firstMessagePreview: extractTextContent(userMessages[0]?.message),
          lastMessagePreview: lastPreview,
        });
      } catch (error) {
        console.error(`[Conversations Handler] Failed to read conversation ${file}:`, error);
      }
    }

    conversations.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return { success: true, conversations };
  } catch (error: any) {
    console.error('[Conversations Handler] Failed to list conversations with previews:', error);
    return { success: false, conversations: [], error: error.message };
  }
}

export async function deleteConversation(
  _workspace: string,
  conversationId: string
): Promise<{ success: boolean; error?: string }> {
  if (!conversationId) {
    return { success: false, error: 'Missing conversationId' };
  }

  if (!validateConversationId(conversationId)) {
    return { success: false, error: 'Invalid conversation ID format' };
  }

  try {
    const filePath = path.join(CONVERSATIONS_DIR, `${conversationId}.chat`);
    await fs.unlink(filePath);
    return { success: true };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return { success: true }; // Already deleted
    }
    console.error('[Conversations Handler] Failed to delete conversation:', error);
    return { success: false, error: error.message };
  }
}
