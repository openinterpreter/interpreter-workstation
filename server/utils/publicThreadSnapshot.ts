import { createHash, timingSafeEqual } from 'node:crypto';
import type { v2 } from '../handlers/codex-generated-types';
import type {
  PublicThreadMessage,
  PublicThreadSnapshot,
} from '../../shared/types/publicThread';
import { mapThreadToChatMessages } from '../../src/lib/codex/thread-history-mapper';
import { isHiddenRuntimeContinuationMessage } from '../../src/hooks/use-chat';

const SECRET_MARKERS = [
  /\bBearer\s+[A-Za-z0-9._~-]+/giu,
  /\bauthorization\s*[:=]\s*[^\r\n]+/giu,
  /\b(?:api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/giu,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
];

export function matchesPublicThreadToken(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function sanitizePublicThreadText(value: string, limit = 100_000): string {
  let sanitized = value.slice(0, limit);
  for (const marker of SECRET_MARKERS) {
    sanitized = sanitized.replace(marker, '[redacted]');
  }
  return sanitized;
}

export function threadToPublicMessages(thread: v2.Thread): PublicThreadMessage[] {
  return mapThreadToChatMessages(thread)
    .filter((message) => !isHiddenRuntimeContinuationMessage(message))
    .map((message): PublicThreadMessage => ({
      id: message.id,
      role: message.role,
      parts: message.parts.flatMap((part) => {
        if (part.kind === 'text') {
          return [{ kind: 'text' as const, content: sanitizePublicThreadText(part.content) }];
        }
        if (part.toolCall.type === 'reasoning') return [];
        return [{
          kind: 'tool' as const,
          id: part.toolCall.id,
          label: sanitizePublicThreadText(part.toolCall.label, 500),
          state: part.toolCall.state,
        }];
      }),
    }));
}

export function buildPublicThreadSnapshot(options: {
  thread: v2.Thread;
  goal: v2.ThreadGoal | null;
  title: string;
  nextCursor: string | null;
  hasMore: boolean;
}): PublicThreadSnapshot {
  const { thread, goal } = options;
  const goalPaused = goal?.status === 'paused';
  return {
    schemaVersion: 1,
    threadId: thread.id,
    title: options.title,
    status: goalPaused
      ? 'paused'
      : thread.status.type === 'active'
        ? 'working'
        : thread.status.type === 'systemError'
          ? 'error'
          : 'idle',
    goal: goal
      ? {
          objective: sanitizePublicThreadText(goal.objective, 10_000),
          status: goal.status,
          updatedAt: goal.updatedAt,
        }
      : null,
    messages: threadToPublicMessages(thread),
    page: {
      nextCursor: options.nextCursor,
      hasMore: options.hasMore,
    },
    eventCursor: `${thread.updatedAt}:${thread.turns.at(-1)?.id ?? 'empty'}`,
    updatedAt: thread.updatedAt * 1000,
  };
}
