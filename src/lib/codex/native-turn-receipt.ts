import { createHash } from 'node:crypto';

type TurnItem = { type: string; id: string; [key: string]: unknown };
type Turn = {
  id: string;
  status: string;
  items: TurnItem[];
  error?: { message?: string; codexErrorInfo?: unknown } | null;
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Exact-turn, content-free native receipt. An absent client ID is never inferred from an item ID. */
export function nativeTurnReceipt(input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('Invalid native turn');
  const turn = input as Turn;
  if (typeof turn.id !== 'string' || typeof turn.status !== 'string') throw new Error('Invalid native turn identity');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(turn.id) ||
      !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)) {
    throw new Error('Invalid native turn status');
  }
  if (!Array.isArray(turn.items) || turn.items.length > 2000) throw new Error('Native turn item bound exceeded');
  if (turn.items.some((item) => !item || typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(item.id) || typeof item.type !== 'string')) {
    throw new Error('Invalid native turn item');
  }
  const userItems = turn.items.filter((item) => item.type === 'userMessage').map((item) => {
    const content = item.content;
    if (!Array.isArray(content)) throw new Error('Invalid native user item');
    const text = content.filter((part) => part && typeof part === 'object' && part.type === 'text')
      .map((part) => part.text);
    if (text.some((part) => typeof part !== 'string')) throw new Error('Invalid native user text');
    const value = JSON.stringify(content);
    if (Buffer.byteLength(value) > 1_048_576) throw new Error('Native user item bound exceeded');
    return { itemId: item.id, contentSha256: sha256(value), contentBytes: Buffer.byteLength(value),
      clientUserMessageId: null as null };
  });
  const commandSessions = turn.items.filter((item) => item.type === 'commandExecution').map((item) => {
    const output = item.aggregatedOutput;
    if (output !== null && output !== undefined && typeof output !== 'string') throw new Error('Invalid native command output');
    if (typeof item.processId === 'string' && !/^[A-Za-z0-9_-]{1,160}$/.test(item.processId)) {
      throw new Error('Invalid native process identifier');
    }
    if (typeof item.status !== 'string' || !['inProgress', 'completed', 'failed', 'declined'].includes(item.status)) {
      throw new Error('Invalid native command status');
    }
    if (typeof output === 'string' && Buffer.byteLength(output) > 16_777_216) {
      throw new Error('Native command output bound exceeded');
    }
    return { itemId: item.id, processId: typeof item.processId === 'string' ? item.processId : null,
      status: item.status, exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      outputSha256: typeof output === 'string' ? sha256(output) : null,
      outputBytes: typeof output === 'string' ? Buffer.byteLength(output) : null };
  });
  const message = turn.error?.message;
  const info = turn.error?.codexErrorInfo;
  const errorCategory = typeof info === 'string' ? info
    : info && typeof info === 'object' && !Array.isArray(info) && Object.keys(info).length === 1
      ? Object.keys(info)[0] : null;
  const category = errorCategory && ['serverOverloaded', 'unauthorized', 'usageLimitReached'].includes(errorCategory)
    ? errorCategory : 'unclassified';
  return { turnId: turn.id, status: turn.status, userItems, commandSessions,
    error: typeof message === 'string' ? { category, bytes: Buffer.byteLength(message), sha256: sha256(message) } : null,
    clientIdLinkage: 'unavailable-from-native-turn' as const };
}
