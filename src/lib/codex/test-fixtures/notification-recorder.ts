import type { CodexAppServerClient } from "../app-server-client";
import type { AppServerNotification } from "../protocol";
import { SERVER_METHOD } from "../protocol";

/**
 * Subscribes to a CodexAppServerClient and records every notification,
 * providing helpers for filtering and waiting on specific events.
 */
export class NotificationRecorder {
  private notifications: AppServerNotification[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(client: CodexAppServerClient) {
    this.unsubscribe = client.subscribe((n) => this.notifications.push(n));
  }

  /**
   * Returns a promise that resolves with the turnCompleted notification
   * for the given turnId. Checks already-received notifications first,
   * then waits for new ones up to `timeoutMs`.
   */
  waitForTurnCompleted(
    turnId: string,
    timeoutMs = 30_000,
  ): Promise<AppServerNotification> {
    // Check already-received notifications.
    const existing = this.notifications.find(
      (n) =>
        n.method === SERVER_METHOD.turnCompleted &&
        "turn" in n.params &&
        n.params.turn.id === turnId,
    );
    if (existing) return Promise.resolve(existing);

    return new Promise<AppServerNotification>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for turnCompleted (turnId=${turnId})`)),
        timeoutMs,
      );

      // Poll newly arriving notifications via a snapshot-diff approach.
      let cursor = this.notifications.length;
      const interval = setInterval(() => {
        while (cursor < this.notifications.length) {
          const n = this.notifications[cursor]!;
          cursor++;
          if (
            n.method === SERVER_METHOD.turnCompleted &&
            "turn" in n.params &&
            n.params.turn.id === turnId
          ) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve(n);
            return;
          }
        }
      }, 50);
    });
  }

  /**
   * Returns all streamError notifications matching the given turnId.
   */
  getStreamErrors(turnId: string): AppServerNotification[] {
    return this.notifications.filter(
      (n) =>
        n.method === SERVER_METHOD.streamError &&
        "turnId" in n.params &&
        n.params.turnId === turnId,
    );
  }

  /**
   * Returns all agentMessageDelta notifications matching the given turnId.
   */
  getAgentMessageDeltas(turnId: string): AppServerNotification[] {
    return this.notifications.filter(
      (n) =>
        n.method === SERVER_METHOD.agentMessageDelta &&
        "turnId" in n.params &&
        n.params.turnId === turnId,
    );
  }

  /**
   * Concatenates the delta text from all agentMessageDelta notifications
   * for the given turnId into a single string.
   */
  collectAssistantText(turnId: string): string {
    return this.getAgentMessageDeltas(turnId)
      .map((n) => {
        if ("delta" in n.params) {
          return n.params.delta as string;
        }
        return "";
      })
      .join("");
  }

  /**
   * Returns a shallow copy of all recorded notifications.
   */
  all(): AppServerNotification[] {
    return [...this.notifications];
  }

  /**
   * Detaches the subscription. Safe to call multiple times.
   */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
