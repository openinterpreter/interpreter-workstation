import { createHash, timingSafeEqual } from 'node:crypto';
import type { v2 } from '../handlers/codex-generated-types';
import type {
  PublicThreadMessage,
  PublicThreadMessagePart,
  PublicThreadSnapshot,
} from '../../shared/types/publicThread';
import type { UiStreamEvent } from '../../src/lib/codex/event-mapper';

const RUNTIME_RESTART_CONTINUE_MESSAGE =
  'Continue the previous task now that Interpreter restarted. Continue from where you left off and verify the MCP/tool changes are available.';

const SECRET_MARKERS = [
  /\bBearer\s+[A-Za-z0-9._~-]+/giu,
  /\bauthorization\s*[:=]\s*[^\r\n]+/giu,
  /\b(?:api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/giu,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
];

const PRIVATE_MARKDOWN_PATH_LINK = /\[([^\]\r\n]{1,500})\]\(((?:file:\/{2,3}|\/(?:workspace|Users|home|root|private|tmp|var|etc|opt|srv|mnt|Volumes)(?:\/[^)\r\n]*)?|[A-Za-z]:[\\/][^)\r\n]+))\)/gu;
const PRIVATE_POSIX_PATH = /(?<![A-Za-z0-9:/])\/(?:workspace|Users|home|root|private|tmp|var|etc|opt|srv|mnt|Volumes)(?:\/[^\s<>"'`)\]}]*)?/gu;
const PRIVATE_WINDOWS_PATH = /\b[A-Za-z]:[\\/](?:Users|workspace|home|private|tmp|var|etc|opt|srv|mnt)[\\/][^\s<>"'`)\]}]*/gu;
const INTERNAL_CITATION_MARKER = /\s*cite[^\r\n]+/gu;

function publicWorkspaceHref(target: string, publicWorkspaceRoot?: string): string | null {
  if (!publicWorkspaceRoot) return null;
  let decoded = target.replace(/^file:\/{2,3}/iu, '/');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  const normalizedTarget = decoded.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const normalizedRoot = publicWorkspaceRoot.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (!normalizedRoot || !normalizedTarget.startsWith(`${normalizedRoot}/`)) return null;
  const relativePath = normalizedTarget.slice(normalizedRoot.length + 1);
  if (!relativePath || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return `file?path=${encodeURIComponent(relativePath)}`;
}

export function matchesPublicThreadToken(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function sanitizePublicThreadText(
  value: string,
  limit = 100_000,
  publicWorkspaceRoot?: string,
): string {
  let sanitized = value.slice(0, limit);
  sanitized = sanitized.replace(PRIVATE_MARKDOWN_PATH_LINK, (_match, label: string, target: string) => {
    const href = publicWorkspaceHref(target, publicWorkspaceRoot);
    return href ? `[${label}](${href})` : `${label} (saved in the workspace)`;
  });
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

export function publicToolPart(item: v2.ThreadItem): PublicThreadMessagePart | null {
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

const MAX_LIVE_TOOL_PARTS_PER_MESSAGE = 20;

function appendLivePart(
  messages: PublicThreadMessage[],
  messageId: string,
  part: PublicThreadMessagePart,
  createdAt: number,
): PublicThreadMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  const current = index >= 0
    ? messages[index]
    : { id: messageId, role: 'assistant' as const, parts: [], createdAt };
  let parts = current.parts;

  if (part.kind === 'tool') {
    const existingPart = parts.findIndex((candidate) => candidate.kind === 'tool' && candidate.id === part.id);
    parts = existingPart >= 0
      ? parts.map((candidate, partIndex) => partIndex === existingPart ? part : candidate)
      : [...parts, part];
    const toolIndexes = parts.flatMap((candidate, partIndex) => candidate.kind === 'tool' ? [partIndex] : []);
    const excess = toolIndexes.length - MAX_LIVE_TOOL_PARTS_PER_MESSAGE;
    if (excess > 0) {
      const omitted = new Set(toolIndexes.slice(0, excess));
      parts = parts.filter((_candidate, partIndex) => !omitted.has(partIndex));
    }
  } else if (!parts.some((candidate) => candidate.kind === 'text' && candidate.content === part.content)) {
    parts = [...parts, part];
  }

  const next = { ...current, parts };
  if (index < 0) return [...messages, next];
  return messages.map((message, messageIndex) => messageIndex === index ? next : message);
}

/**
 * Advance the durable public projection from native OIX notifications. This
 * avoids repeatedly reconstructing a multi-gigabyte thread merely to show its
 * newest activity. Tool inputs and outputs are never copied into the public
 * projection; only the same sanitized display labels used by full snapshots
 * are retained.
 */
export function applyPublicThreadUiEvents(options: {
  snapshot: PublicThreadSnapshot;
  events: readonly UiStreamEvent[];
  turnId: string | null;
  publicWorkspaceRoot?: string;
  now?: number;
}): PublicThreadSnapshot {
  const now = options.now ?? Date.now();
  let messages = options.snapshot.messages;
  let status = options.snapshot.status;
  const liveMessageId = options.turnId ? `live-turn-${options.turnId}` : null;

  for (const event of options.events) {
    if (event.event === 'userMessage') {
      const text = event.payload.text.trim();
      if (text && text !== RUNTIME_RESTART_CONTINUE_MESSAGE && !messages.some((message) => message.id === event.payload.itemId)) {
        messages = [...messages, {
          id: event.payload.itemId,
          role: 'user',
          parts: [{ kind: 'text', content: sanitizePublicThreadText(text, 100_000, options.publicWorkspaceRoot) }],
          createdAt: now,
        }];
      }
      continue;
    }

    if (event.event === 'tool' && liveMessageId) {
      const part = publicToolPart(event.payload.item);
      if (part) messages = appendLivePart(messages, liveMessageId, part, now);
      status = 'working';
      continue;
    }

    if (event.event === 'final') {
      const text = event.payload.text.trim();
      if (text) {
        messages = appendLivePart(
          messages,
          liveMessageId ?? event.payload.itemId ?? `live-message-${now}`,
          { kind: 'text', content: sanitizePublicThreadText(text, 100_000, options.publicWorkspaceRoot) },
          now,
        );
      }
      status = 'working';
      continue;
    }

    if (event.event === 'completed') {
      status = event.payload.status === 'failed' ? 'error' : 'idle';
      continue;
    }

    if (event.event === 'error') status = 'error';
  }

  if (messages === options.snapshot.messages && status === options.snapshot.status) return options.snapshot;
  return {
    ...options.snapshot,
    messages,
    status,
    eventCursor: `${now}:${options.turnId ?? 'thread'}`,
    updatedAt: now,
  };
}

function publicUserText(item: Extract<v2.ThreadItem, { type: 'userMessage' }>): string {
  return item.content
    .filter((input): input is Extract<(typeof item.content)[number], { type: 'text' }> => input.type === 'text')
    .map((input) => input.text)
    .join('');
}

export function threadToPublicMessages(
  thread: v2.Thread,
  publicWorkspaceRoot?: string,
): PublicThreadMessage[] {
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
            parts: [{ kind: 'text', content: sanitizePublicThreadText(text, 100_000, publicWorkspaceRoot) }],
          });
        }
        continue;
      }

      const part = item.type === 'agentMessage'
        ? { kind: 'text' as const, content: sanitizePublicThreadText(item.text, 100_000, publicWorkspaceRoot) }
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
  publicWorkspaceRoot?: string;
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
    messages: threadToPublicMessages(thread, options.publicWorkspaceRoot),
    page: {
      nextCursor: options.nextCursor,
      hasMore: options.hasMore,
    },
    eventCursor: `${thread.updatedAt}:${thread.turns[thread.turns.length - 1]?.id ?? 'empty'}`,
    updatedAt: thread.updatedAt * 1000,
  };
}
