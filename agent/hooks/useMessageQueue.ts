/**
 * Message Queue Hook
 *
 * Simple string queue for messages sent while agent is streaming.
 * New messages append with newline. Click to edit clears and returns text.
 */

import { useState, useCallback } from 'react';
import { useAgentError } from '../contexts/AgentErrorContext';
import { tr } from '../../src/i18n';
import { getApiUrl } from '../../src/ipc';

interface UseMessageQueueOptions {
  agentId: string;
  serverPort: number;
}

interface AddToQueueResult {
  success: boolean;
  error?: string;
}

export function useMessageQueue({ agentId, serverPort: _serverPort }: UseMessageQueueOptions) {
  const [queuedText, setQueuedText] = useState<string | null>(null);
  const { showError } = useAgentError();

  // Add text to queue (appends with newline if existing)
  // Returns success/failure so caller can handle (e.g., keep text in composer on failure)
  const addToQueue = useCallback(async (text: string): Promise<AddToQueueResult> => {
    if (!text.trim()) return { success: false, error: tr('composer.queue.emptyMessage') };

    // Optimistic update using functional form
    setQueuedText(prev => prev ? `${prev}\n${text}` : text);

    // Sync to backend
    try {
      const response = await fetch(await getApiUrl('/api/agent/queue'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, message: text }),
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      return { success: true };
    } catch {
      // Rollback: remove our specific text using functional update
      // This correctly handles concurrent operations by only removing what we added
      setQueuedText(prev => {
        if (prev === null) return null;
        if (prev === text) return null;
        if (prev.endsWith(`\n${text}`)) return prev.slice(0, -(text.length + 1));
        return prev;
      });

      // Show error via unified error system
      showError(tr('composer.queue.failedTryAgain'));

      return { success: false, error: tr('composer.queue.failed') };
    }
  }, [agentId, showError]);

  // Edit: clear queue and return text for composer
  const editQueue = useCallback(async (): Promise<string | null> => {
    const text = queuedText;
    setQueuedText(null);

    // Clear backend
    try {
      await fetch(await getApiUrl(`/api/agent/queue/${encodeURIComponent(agentId)}`), {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch {
      // Silently fail - local state already cleared
    }

    return text;
  }, [queuedText, agentId]);

  // Clear queue without returning text
  const clearQueue = useCallback(async () => {
    setQueuedText(null);

    try {
      await fetch(await getApiUrl(`/api/agent/queue/${encodeURIComponent(agentId)}`), {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch {
      // Silently fail - local state already cleared
    }
  }, [agentId]);

  return {
    queuedText,
    addToQueue,
    editQueue,
    clearQueue,
    hasQueue: queuedText !== null,
  };
}
