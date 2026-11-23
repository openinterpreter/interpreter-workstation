import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type BrowserPiTranscript = {
  version: 1;
  projectId: string;
  threadId: string;
  revision: number;
  messages: AgentMessage[];
  /** User turns whose model stopped before a final answer; their completed tools are context, not work to replay. */
  interruptedTurnIds?: string[];
  /** Terminal failures after durable tool results; distinct from explicit user interruption. */
  failedTurns?: Record<string, 'failed' | 'truncated' | 'storage'>;
};
export type BrowserPiTranscriptStore = {
  read(projectId: string, threadId: string): Promise<BrowserPiTranscript | null>;
  compareAndSwap(value: BrowserPiTranscript, expectedRevision: number): Promise<void>;
  /** Hold an exclusive per-thread lease through model and tool execution, not just the final write. */
  runExclusive<T>(projectId: string, threadId: string, action: () => Promise<T>): Promise<T>;
};

const encoder = new TextEncoder();
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
// A bounded session permits 64 user turns with up to 16 tool calls each;
// ordinary retained results must never exhaust the persistence envelope.
const MAX_TRANSCRIPT_MESSAGES = 3_072;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const roles = new Set(['system', 'user', 'assistant', 'toolResult']);
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function content(value: unknown, allowTools: boolean): boolean {
  return Array.isArray(value) && value.length <= 128 && value.every(part => {
    if (!plain(part)) return false;
    if (part.type === 'text') return typeof part.text === 'string';
    if (part.type === 'thinking') return allowTools && typeof part.thinking === 'string';
    if (part.type === 'image') return typeof part.data === 'string' && typeof part.mimeType === 'string';
    if (part.type === 'toolCall') return allowTools && typeof part.id === 'string' &&
      typeof part.name === 'string' && plain(part.arguments);
    return false;
  });
}
function messageShape(value: unknown): boolean {
  if (!plain(value) || !roles.has(String(value.role)) ||
      !Number.isFinite(value.timestamp)) return false;
  if (value.role === 'system') return typeof value.content === 'string' || content(value.content, false);
  if (value.role === 'user') return typeof value.content === 'string' || content(value.content, false);
  if (value.role === 'assistant') return content(value.content, true) &&
    typeof value.stopReason === 'string' && typeof value.model === 'string';
  return typeof value.toolCallId === 'string' && typeof value.toolName === 'string' &&
    typeof value.isError === 'boolean' && content(value.content, false);
}

/** Reject cross-project, corrupt or oversized browser transcripts before model context reuse. */
export function validatePiTranscript(value: unknown, projectId: string, threadId: string): BrowserPiTranscript {
  if (!idPattern.test(projectId) || !idPattern.test(threadId) ||
      typeof value !== 'object' || !value || Array.isArray(value)) throw new Error('Invalid Pi transcript identity');
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages) && record.messages.length > MAX_TRANSCRIPT_MESSAGES ||
      encoder.encode(JSON.stringify(record)).byteLength > MAX_TRANSCRIPT_BYTES)
    throw new Error('Browser conversation exceeds finite capacity; start a new thread');
  const keys = Object.keys(record);
  if (keys.some(key => !['messages', 'projectId', 'revision', 'threadId', 'version',
    'interruptedTurnIds', 'failedTurns'].includes(key)) || keys.length < 5 ||
      record.version !== 1 || record.projectId !== projectId || record.threadId !== threadId ||
      !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
      !Array.isArray(record.messages) ||
      (record.interruptedTurnIds !== undefined && (!Array.isArray(record.interruptedTurnIds) ||
        record.interruptedTurnIds.length > 64 || record.interruptedTurnIds.some((id: unknown) =>
          typeof id !== 'string' || !/^pi-turn-\d+$/.test(id)))) ||
      record.messages.some((message: unknown) => !messageShape(message)) ||
      (record.failedTurns !== undefined && (!plain(record.failedTurns) ||
        Object.keys(record.failedTurns).length > 64 ||
        Object.entries(record.failedTurns).some(([id, kind]) =>
          !/^pi-turn-\d+$/.test(id) || kind !== 'failed' && kind !== 'truncated' && kind !== 'storage'))))
    throw new Error('Invalid browser Pi transcript');
  if (record.interruptedTurnIds !== undefined) {
    const userTurnIds = new Set((record.messages as AgentMessage[]).flatMap((message, index) =>
      message.role === 'user' ? [`pi-turn-${index}`] : []));
    const ids = record.interruptedTurnIds as string[];
    if (new Set(ids).size !== ids.length || ids.some(id => !userTurnIds.has(id)))
      throw new Error('Invalid browser Pi interrupted turn journal');
  }
  if (record.failedTurns !== undefined) {
    const userTurnIds = new Set((record.messages as AgentMessage[]).flatMap((message, index) =>
      message.role === 'user' ? [`pi-turn-${index}`] : []));
    if (Object.keys(record.failedTurns).some(id => !userTurnIds.has(id) ||
      (record.interruptedTurnIds as string[] | undefined)?.includes(id)))
      throw new Error('Invalid browser Pi failed turn journal');
  }
  return structuredClone(record) as BrowserPiTranscript;
}

/** Atomic IndexedDB CAS prevents two tabs from silently overwriting a retained Pi conversation. */
export class IndexedDbPiTranscriptStore implements BrowserPiTranscriptStore {
  private readonly db: Promise<IDBDatabase>;
  constructor(name = 'interpreter-browser-pi-v1') {
    if (typeof indexedDB === 'undefined') throw new Error('Browser Pi persistent storage unavailable');
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('threads');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async runExclusive<T>(projectId: string, threadId: string, action: () => Promise<T>): Promise<T> {
    if (!idPattern.test(projectId) || !idPattern.test(threadId))
      throw new Error('Invalid Pi transcript identity');
    if (typeof navigator === 'undefined' || !navigator.locks?.request)
      throw new Error('Browser Pi cross-tab lock capability unavailable');
    return navigator.locks.request(`interpreter-browser-pi:${projectId}:${threadId}`,
      { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Browser Pi thread is active in another tab');
        return action();
      });
  }
  async read(projectId: string, threadId: string): Promise<BrowserPiTranscript | null> {
    if (!idPattern.test(projectId) || !idPattern.test(threadId)) throw new Error('Invalid Pi transcript identity');
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = db.transaction('threads', 'readonly').objectStore('threads').get(`${projectId}:${threadId}`);
      request.onsuccess = () => {
        try { resolve(request.result === undefined ? null : validatePiTranscript(request.result, projectId, threadId)); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error);
    });
  }
  async compareAndSwap(value: BrowserPiTranscript, expectedRevision: number): Promise<void> {
    const next = validatePiTranscript(value, value.projectId, value.threadId);
    if (next.revision !== expectedRevision + 1) throw new Error('Invalid Pi transcript revision');
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('threads', 'readwrite');
      const store = transaction.objectStore('threads');
      let conflict = false;
      const request = store.get(`${next.projectId}:${next.threadId}`);
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== expectedRevision) {
          conflict = true; transaction.abort();
        } else store.put(next, `${next.projectId}:${next.threadId}`);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(new Error(conflict
        ? 'Browser Pi transcript changed in another tab; reload before sending'
        : 'Browser Pi transcript write failed'));
    });
  }
}

export class MemoryPiTranscriptStore implements BrowserPiTranscriptStore {
  private readonly records = new Map<string, BrowserPiTranscript>();
  private readonly active = new Set<string>();
  async runExclusive<T>(projectId: string, threadId: string, action: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${threadId}`;
    if (this.active.has(key)) throw new Error('Browser Pi thread is active in another tab');
    this.active.add(key);
    try { return await action(); }
    finally { this.active.delete(key); }
  }
  async read(projectId: string, threadId: string): Promise<BrowserPiTranscript | null> {
    const record = this.records.get(`${projectId}:${threadId}`);
    return record ? validatePiTranscript(record, projectId, threadId) : null;
  }
  async compareAndSwap(value: BrowserPiTranscript, expectedRevision: number): Promise<void> {
    const next = validatePiTranscript(value, value.projectId, value.threadId);
    const key = `${next.projectId}:${next.threadId}`;
    if ((this.records.get(key)?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1)
      throw new Error('Browser Pi transcript changed in another tab; reload before sending');
    this.records.set(key, next);
  }
}
