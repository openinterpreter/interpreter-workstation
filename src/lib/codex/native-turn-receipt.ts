import { createHash } from 'node:crypto';

type TurnItem = { type: string; id: string; [key: string]: unknown };
type Turn = {
  id: string;
  status: string;
  items: TurnItem[];
  error?: { message?: string; codexErrorInfo?: unknown } | null;
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** A current native thread-read observation, not an OS process-liveness probe.
 * Never return command text, cwd, output, or private native error prose. */
export function nativeCommandSessionSnapshot(input: unknown, threadActive: boolean) {
  if (input === null || input === undefined) return {
    scope: 'native-thread-read-not-os-process-custody' as const,
    observation: 'unavailable-no-native-turn' as const,
    observationTurnId: null,
    observationTurnStatus: null,
    sessions: [],
  };
  if (!input || typeof input !== 'object') throw new Error('Invalid native command turn');
  const turn = input as Turn;
  if (typeof turn.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(turn.id) ||
      !Array.isArray(turn.items) || turn.items.length > 200 ||
      !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)) {
    throw new Error('Invalid native command turn');
  }
  const commands = turn.items.filter((item) => item?.type === 'commandExecution');
  if (commands.length > 32) throw new Error('Native command session bound exceeded');
  const seenItemIds = new Set<string>();
  const sessions = commands.map((item) => {
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.id) ||
        (item.processId !== null && item.processId !== undefined &&
          (typeof item.processId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.processId))) ||
        !['inProgress', 'completed', 'failed', 'declined'].includes(item.status as string) ||
        (item.exitCode !== null && item.exitCode !== undefined &&
          (!Number.isSafeInteger(item.exitCode) || typeof item.exitCode !== 'number'))) {
      throw new Error('Invalid native command session');
    }
    if (seenItemIds.has(item.id)) throw new Error('Ambiguous native command item identifier');
    seenItemIds.add(item.id);
    const output = item.aggregatedOutput;
    if (output !== null && output !== undefined &&
        (typeof output !== 'string' || Buffer.byteLength(output) > 16_777_216)) {
      throw new Error('Native command output bound exceeded');
    }
    return { itemId: item.id, processId: item.processId ?? null, status: item.status,
      nativeTurnActiveAtRead: threadActive && turn.status === 'inProgress' && item.status === 'inProgress',
      exitCode: item.exitCode ?? null,
      outputBytes: typeof output === 'string' ? Buffer.byteLength(output) : null,
      outputSha256: typeof output === 'string' ? sha256(output) : null };
  });
  return { scope: 'native-thread-read-not-os-process-custody' as const,
    observation: 'last-native-turn-only' as const,
    observationTurnId: turn.id, observationTurnStatus: turn.status, sessions };
}

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
    if (item.clientId !== undefined && item.clientId !== null &&
        (typeof item.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.clientId))) {
      throw new Error('Invalid native client identifier');
    }
    return { itemId: item.id, contentSha256: sha256(value), contentBytes: Buffer.byteLength(value),
      clientUserMessageId: typeof item.clientId === 'string' ? item.clientId : null };
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
  // These are native item observations, not evidence of provider or device
  // delivery. In particular, command completion does not identify its target.
  if (turn.items.length > 200) throw new Error('Native turn item bound exceeded');
  const agentItems = turn.items.filter((item) => item.type === 'agentMessage');
  const toolItems = turn.items.filter((item) =>
    ['mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(item.type));
  if (agentItems.length > 32 || toolItems.length > 64) throw new Error('Native handling item bound exceeded');
  const agentMessages = agentItems.map((item) => {
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.id) ||
        typeof item.text !== 'string' || Buffer.byteLength(item.text) > 1_048_576) {
      throw new Error('Invalid native agent item');
    }
    return { itemId: item.id, contentBytes: Buffer.byteLength(item.text), contentSha256: sha256(item.text) };
  });
  const toolObservations = toolItems.map((item) => {
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.id)) {
      throw new Error('Invalid native tool item');
    }
    const status = typeof item.status === 'string' &&
      ['inProgress', 'completed', 'failed', 'declined'].includes(item.status) ? item.status : 'unclassified';
    return { itemId: item.id, kind: item.type, status: item.type === 'functionCallOutput' ? 'recorded' : status };
  });
  const message = turn.error?.message;
  const info = turn.error?.codexErrorInfo;
  const errorCategory = typeof info === 'string' ? info
    : info && typeof info === 'object' && !Array.isArray(info) && Object.keys(info).length === 1
      ? Object.keys(info)[0] : null;
  const category = errorCategory && ['serverOverloaded', 'unauthorized', 'usageLimitReached'].includes(errorCategory)
    ? errorCategory : 'unclassified';
  return { turnId: turn.id, status: turn.status, userItems, commandSessions,
    agentMessages, toolObservations, externalDeliveryScope: 'not-established-by-native-turn' as const,
    error: typeof message === 'string' ? { category, bytes: Buffer.byteLength(message), sha256: sha256(message) } : null,
    clientIdLinkage: userItems.some(item => item.clientUserMessageId !== null)
      ? 'native-user-item' as const : 'unavailable-from-native-turn' as const,
    commandSessionScope: 'saved-native-turn-only-not-live-process-custody' as const };
}
