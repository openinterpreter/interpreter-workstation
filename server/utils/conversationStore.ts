/**
 * Server-side Conversation Storage
 *
 * Stores conversations as they stream through the server.
 * This captures the RAW data from the model - tool calls, tool results, text, etc.
 *
 * Storage location: ~/.interpreter/conversations/{conversationId}.json
 *
 * The server is the source of truth for conversation data because:
 * 1. It sees all data as it streams (client may miss tool-input events)
 * 2. It can store incrementally as messages complete
 * 3. It captures the exact format the model returns
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Global conversations directory
const WORKSTATION_DIR = path.join(os.homedir(), '.interpreter');
const CONVERSATIONS_DIR = path.join(WORKSTATION_DIR, 'conversations');

// Message types that we store
export interface StoredToolCall {
  toolCallId: string;
  toolName: string;
  args: any;
}

export interface StoredToolResult {
  toolCallId: string;
  toolName: string;
  result: any;
  isError?: boolean;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  toolCalls?: StoredToolCall[];
  toolResults?: StoredToolResult[];
  reasoning?: string;
  parentId: string | null;
}

export interface StoredConversation {
  conversationId: string;
  agentId: string;
  profileId: string;
  isACP: boolean;
  title: string;
  messages: StoredMessage[];
  headId: string | null;
  createdAt: string;
  updatedAt: string;
  rawModelMessages?: any[];
}

// In-memory cache of active conversations
const activeConversations = new Map<string, StoredConversation>();

function getConversationPath(conversationId: string): string {
  return path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
}

function ensureConversationsDir(): void {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
}

/**
 * Get or create a conversation
 */
export function getOrCreateConversation(
  conversationId: string,
  agentId: string,
  profileId: string,
  isACP: boolean
): StoredConversation {
  const cached = activeConversations.get(conversationId);
  if (cached) {
    return cached;
  }

  // Try to load from disk
  const filePath = getConversationPath(conversationId);
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const conv = JSON.parse(data) as StoredConversation;
      activeConversations.set(conversationId, conv);
      return conv;
    } catch (e) {
      console.error('[ConversationStore] Failed to load from disk:', e);
    }
  }

  // Create new conversation
  const now = new Date().toISOString();
  const conv: StoredConversation = {
    conversationId,
    agentId,
    profileId,
    isACP,
    title: 'New Conversation',
    messages: [],
    headId: null,
    createdAt: now,
    updatedAt: now,
  };
  activeConversations.set(conversationId, conv);
  return conv;
}

/**
 * Add a user message to the conversation
 */
export function addUserMessage(
  conversationId: string,
  messageId: string,
  content: string,
  parentId: string | null = null
): void {
  const conv = activeConversations.get(conversationId);
  if (!conv) {
    console.error('[ConversationStore] No conversation found:', conversationId);
    return;
  }

  const effectiveParentId = parentId ?? conv.headId;

  const message: StoredMessage = {
    id: messageId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    parentId: effectiveParentId,
  };

  conv.messages.push(message);
  conv.headId = messageId;
  conv.updatedAt = message.createdAt;

  console.log(
    `[CONVO] user_message conversationId=${conversationId} messageId=${messageId} chars=${content.length} hasParent=${effectiveParentId ? 'true' : 'false'}`,
  );

  // Generate title from first user message
  if (conv.messages.filter(m => m.role === 'user').length === 1) {
    conv.title = content.length <= 50 ? content : content.slice(0, 47) + '...';
  }

  saveConversation(conv);
}

/**
 * Add an assistant message with optional tool calls
 */
export function addAssistantMessage(
  conversationId: string,
  messageId: string,
  content: string,
  toolCalls?: StoredToolCall[],
  reasoning?: string
): void {
  const conv = activeConversations.get(conversationId);
  if (!conv) {
    console.error('[ConversationStore] No conversation found:', conversationId);
    return;
  }

  const message: StoredMessage = {
    id: messageId,
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
    parentId: conv.headId,
    toolCalls,
    reasoning,
  };

  conv.messages.push(message);
  conv.headId = messageId;
  conv.updatedAt = message.createdAt;

  console.log(
    `[CONVO] assistant_message conversationId=${conversationId} messageId=${messageId} chars=${content.length} toolCalls=${toolCalls?.length ?? 0} reasoningChars=${reasoning?.length ?? 0}`,
  );

  saveConversation(conv);
}

/**
 * Add tool results to the last assistant message
 */
export function addToolResults(
  conversationId: string,
  toolResults: StoredToolResult[]
): void {
  const conv = activeConversations.get(conversationId);
  if (!conv) {
    console.error('[ConversationStore] No conversation found:', conversationId);
    return;
  }

  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'assistant') {
      conv.messages[i].toolResults = [
        ...(conv.messages[i].toolResults || []),
        ...toolResults
      ];
      conv.updatedAt = new Date().toISOString();
      const errorCount = toolResults.filter((result) => result.isError).length;
      console.log(
        `[CONVO] tool_results conversationId=${conversationId} messageId=${conv.messages[i].id} count=${toolResults.length} errorCount=${errorCount}`,
      );
      saveConversation(conv);
      return;
    }
  }
}

/**
 * Update conversation title
 */
export function updateTitle(conversationId: string, title: string): void {
  const conv = activeConversations.get(conversationId);
  if (!conv) return;
  conv.title = title;
  conv.updatedAt = new Date().toISOString();
  saveConversation(conv);
}

/**
 * Save conversation to disk
 */
function saveConversation(conv: StoredConversation): void {
  try {
    ensureConversationsDir();
    const filePath = getConversationPath(conv.conversationId);
    fs.writeFileSync(filePath, JSON.stringify(conv, null, 2));
  } catch (e) {
    console.error('[ConversationStore] Save failed:', e);
  }
}

/**
 * Load a conversation from disk
 */
export function loadConversation(conversationId: string): StoredConversation | null {
  const filePath = getConversationPath(conversationId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const conv = JSON.parse(data) as StoredConversation;
    activeConversations.set(conversationId, conv);
    return conv;
  } catch (e) {
    console.error('[ConversationStore] Failed to load:', e);
    return null;
  }
}

/**
 * List all conversations
 */
export function listConversations(): StoredConversation[] {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    return [];
  }

  const conversations: StoredConversation[] = [];
  const files = fs.readdirSync(CONVERSATIONS_DIR);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf-8');
      const conv = JSON.parse(data) as StoredConversation;
      conversations.push(conv);
    } catch (e) {
      // Skip corrupted files
    }
  }

  conversations.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return conversations;
}

/**
 * Delete a conversation
 */
export function deleteConversation(conversationId: string): boolean {
  activeConversations.delete(conversationId);

  const filePath = getConversationPath(conversationId);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      console.error('[ConversationStore] Failed to delete:', e);
      return false;
    }
  }
  return true;
}

/**
 * Get conversation from memory (for active conversations)
 */
export function getActiveConversation(conversationId: string): StoredConversation | undefined {
  return activeConversations.get(conversationId);
}

/**
 * Store raw AI SDK model messages for ACP agents
 */
export function setRawModelMessages(conversationId: string, messages: any[]): void {
  const conv = activeConversations.get(conversationId);
  if (!conv) {
    console.error('[ConversationStore] No conversation found for raw messages:', conversationId);
    return;
  }
  conv.rawModelMessages = messages;
  conv.updatedAt = new Date().toISOString();
  saveConversation(conv);
}

/**
 * Get raw AI SDK model messages for an ACP agent conversation
 */
export function getRawModelMessages(conversationId: string): any[] | undefined {
  const conv = activeConversations.get(conversationId);
  return conv?.rawModelMessages;
}

/**
 * Clear a conversation from memory cache (when agent tab closes)
 */
export function clearFromCache(conversationId: string): void {
  activeConversations.delete(conversationId);
}
