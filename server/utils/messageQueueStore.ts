/**
 * Message Queue Store
 *
 * Simple string storage for queued user messages.
 * New messages append with newline. Click to edit clears the queue.
 */

class MessageQueueStore {
  private queues = new Map<string, string>();

  /** Add text to agent's queue (appends with newline if existing) */
  add(agentId: string, text: string): void {
    const existing = this.queues.get(agentId);
    this.queues.set(agentId, existing ? `${existing}\n${text}` : text);
    console.log(`[MessageQueueStore] Updated queue for agent ${agentId}`);
  }

  /** Get and clear the queued text */
  getAndClear(agentId: string): string | null {
    const text = this.queues.get(agentId);
    this.queues.delete(agentId);
    if (text) {
      console.log(`[MessageQueueStore] Retrieved and cleared queue for agent ${agentId}`);
    }
    return text ?? null;
  }

  /** Peek at queue without clearing */
  peek(agentId: string): string | null {
    return this.queues.get(agentId) ?? null;
  }

  /** Clear queue for agent */
  clear(agentId: string): void {
    if (this.queues.has(agentId)) {
      this.queues.delete(agentId);
      console.log(`[MessageQueueStore] Cleared queue for agent ${agentId}`);
    }
  }

  /** Check if agent has queued text */
  hasQueue(agentId: string): boolean {
    return this.queues.has(agentId);
  }
}

export const messageQueueStore = new MessageQueueStore();
