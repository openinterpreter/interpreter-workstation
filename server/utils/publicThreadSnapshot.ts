import { createHash, timingSafeEqual } from 'node:crypto';
import type { v2 } from '../handlers/codex-generated-types';
import type {
  PublicThreadMessage,
  PublicThreadMessagePart,
  PublicThreadSnapshot,
} from '../../shared/types/publicThread';

const RUNTIME_RESTART_CONTINUE_MESSAGE =
  'Continue the previous task now that Interpreter restarted. Continue from where you left off and verify the MCP/tool changes are available.';

const SECRET_MARKERS = [
  /\bBearer\s+[A-Za-z0-9._~-]+/giu,
  /\bauthorization\s*[:=]\s*[^\r\n]+/giu,
  /\b(?:api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/giu,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
];

const PRIVATE_MARKDOWN_PATH_LINK = /\[([^\]\r\n]{1,500})\]\((?:file:\/{2,3}|\/(?:workspace|Users|home|root|private|tmp|var|etc|opt|srv|mnt|Volumes)(?:\/[^)\r\n]*)?|[A-Za-z]:[\\/][^)\r\n]+)\)/gu;
const PRIVATE_POSIX_PATH = /(?<![A-Za-z0-9:/])\/(?:workspace|Users|home|root|private|tmp|var|etc|opt|srv|mnt|Volumes)(?:\/[^\s<>"'`)\]}]*)?/gu;
const PRIVATE_WINDOWS_PATH = /\b[A-Za-z]:[\\/](?:Users|workspace|home|private|tmp|var|etc|opt|srv|mnt)[\\/][^\s<>"'`)\]}]*/gu;
const INTERNAL_CITATION_MARKER = /\s*cite[^\r\n]+/gu;

export function matchesPublicThreadToken(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function sanitizePublicThreadText(value: string, limit = 100_000): string {
  let sanitized = value.slice(0, limit);
  sanitized = sanitized.replace(PRIVATE_MARKDOWN_PATH_LINK, '$1 (saved in the workspace)');
  sanitized = sanitized.replace(PRIVATE_POSIX_PATH, '[private path omitted]');
  sanitized = sanitized.replace(PRIVATE_WINDOWS_PATH, '[private path omitted]');
  sanitized = sanitized.replace(INTERNAL_CITATION_MARKER, ' [source citation]');
  for (const marker of SECRET_MARKERS) {
    sanitized = sanitized.replace(marker, '[redacted]');
  }
  return sanitized;
}

function toolState(status: string): 'loading' | 'complete' | 'error' {
  if (status === 'inProgress') return 'loading';
  if (status === 'completed') return 'complete';
  return 'error';
}

function publicFileChangeLabel(item: Extract<v2.ThreadItem, { type: 'fileChange' }>): string {
  const paths = item.changes.map((change) => change.path);
  if (paths.length === 0) return 'Updated files';
  const segments = paths[0].split(/[\\/]/).filter(Boolean);
  const filename = segments[segments.length - 1] ?? 'file';
  const suffix = paths.length > 1 ? ` and ${paths.length - 1} more` : '';
  const change = item.changes[0];
  const kind = typeof change.kind === 'string' ? change.kind : change.kind.type;
  const verb = kind === 'add' ? 'Created' : kind === 'delete' ? 'Deleted' : 'Edited';
  return `${verb} ${sanitizePublicThreadText(filename, 200)}${suffix}`;
}

function publicToolPart(item: v2.ThreadItem): PublicThreadMessagePart | null {
  switch (item.type) {
    case 'commandExecution':
      return { kind: 'tool', id: item.id, label: 'Ran a command', state: toolState(item.status) };
    case 'fileChange':
      return { kind: 'tool', id: item.id, label: publicFileChangeLabel(item), state: toolState(item.status) };
    case 'mcpToolCall':
      return { kind: 'tool', id: item.id, label: sanitizePublicThreadText(item.tool, 200), state: toolState(item.status) };
    case 'dynamicToolCall':
      return { kind: 'tool', id: item.id, label: sanitizePublicThreadText(item.tool, 200), state: toolState(item.status) };
    case 'collabAgentToolCall':
      return { kind: 'tool', id: item.id, label: 'Agent collaboration', state: toolState(item.status) };
    case 'webSearch':
      return {
        kind: 'tool',
        id: item.id,
        label: item.query
          ? `Searched the web for “${sanitizePublicThreadText(item.query, 120)}”`
          : 'Searched the web',
        state: 'complete',
      };
    case 'imageView':
      return { kind: 'tool', id: item.id, label: 'View image', state: 'complete' };
    case 'sleep':
      return { kind: 'tool', id: item.id, label: 'Wait', state: 'complete' };
    case 'imageGeneration':
      return { kind: 'tool', id: item.id, label: 'Generate image', state: 'complete' };
    default:
      return null;
  }
}

function publicUserText(item: Extract<v2.ThreadItem, { type: 'userMessage' }>): string {
  return item.content
    .filter((input): input is Extract<(typeof item.content)[number], { type: 'text' }> => input.type === 'text')
    .map((input) => input.text)
    .join('');
}

export function threadToPublicMessages(thread: v2.Thread): PublicThreadMessage[] {
  const messages: PublicThreadMessage[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (candidate: string) => {
    let id = candidate;
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `${candidate}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return id;
  };

  for (const turn of thread.turns) {
    let assistant: PublicThreadMessage | null = null;
    const flushAssistant = () => {
      if (assistant && assistant.parts.length > 0) messages.push(assistant);
      assistant = null;
    };

    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        flushAssistant();
        const text = publicUserText(item);
        if (text.trim() && text.trim() !== RUNTIME_RESTART_CONTINUE_MESSAGE) {
          messages.push({
            id: uniqueId(item.id),
            role: 'user',
            parts: [{ kind: 'text', content: sanitizePublicThreadText(text) }],
          });
        }
        continue;
      }

      const part = item.type === 'agentMessage'
        ? { kind: 'text' as const, content: sanitizePublicThreadText(item.text) }
        : publicToolPart(item);
      if (!part) continue;
      if (!assistant) {
        assistant = { id: uniqueId(item.id), role: 'assistant', parts: [] };
      }
      assistant.parts.push(part);
    }
    flushAssistant();
  }

  return messages;
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
    eventCursor: `${thread.updatedAt}:${thread.turns[thread.turns.length - 1]?.id ?? 'empty'}`,
    updatedAt: thread.updatedAt * 1000,
  };
}
