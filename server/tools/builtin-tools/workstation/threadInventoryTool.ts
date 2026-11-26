import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import type { v2 } from '../../../handlers/codex-generated-types/index';
import { getCodexService, THREAD_LIST_DEFAULTS } from '../../../../src/lib/codex/service';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_WAIT_MS = 3_000;

function unavailable(category: 'caller_unavailable' | 'invalid_cursor' | 'inventory_unavailable') {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ available: false, category }) }], isError: true };
}

/** One bounded local native page; this is neither an atomic fleet snapshot nor a queue read. */
export async function readThreadInventoryForCaller(
  context: BuiltinToolContext | undefined,
  cursor: unknown,
  read: (params: v2.ThreadListParams, maxWaitMs: number) => Promise<v2.ThreadListResponse>,
  maxWaitMs = MAX_WAIT_MS,
) {
  const owner = context?.verifiedCallerThreadId;
  if (!owner || !THREAD.test(owner) || context?.threadId !== owner ||
      context?.isSubagent || (context?.toolCallPath?.length ?? 0) > 0) {
    return unavailable('caller_unavailable');
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 1024 ||
      /[\x00-\x1f\x7f]/.test(cursor))) return unavailable('invalid_cursor');
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > MAX_WAIT_MS) {
    return unavailable('inventory_unavailable');
  }
  const deadline = performance.now() + maxWaitMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const withinDeadline = async (useStateDbOnly: boolean) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error('deadline');
    return Promise.race([
      read({ ...THREAD_LIST_DEFAULTS, limit: 100, useStateDbOnly,
        ...(cursor === undefined ? {} : { cursor }) }, remaining),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), remaining); }),
    ]).finally(() => { if (timer) clearTimeout(timer); timer = undefined; });
  };
  try {
    let page = await withinDeadline(true);
    // The native DB-only path may answer with an empty page after a failed read.
    if (Array.isArray(page.data) && page.data.length === 0) page = await withinDeadline(false);
    if (!Array.isArray(page.data) || page.data.length > 100 ||
        page.data.some(item => !item || !THREAD.test(item.id) ||
          !['notLoaded', 'idle', 'systemError', 'active'].includes(item.status?.type)) ||
        new Set(page.data.map(item => item.id)).size !== page.data.length ||
        (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor ||
          page.nextCursor === cursor || page.nextCursor.length > 1024 ||
          /[\x00-\x1f\x7f]/.test(page.nextCursor)))) {
      throw new Error('invalid native page');
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ available: true,
      scope: 'local-computer', observation: 'saved-native-thread-page-not-queue-or-process-custody',
      threads: page.data.map(item => ({ threadId: item.id, status: item.status.type })),
      nextCursor: page.nextCursor, pageExhausted: page.nextCursor === null,
    }) }] };
  } catch {
    // A timed-out native request may still finish later. Never claim an empty inventory.
    return unavailable('inventory_unavailable');
  } finally { if (timer) clearTimeout(timer); }
}

export const threadInventoryTool: BuiltinToolDefinition = {
  name: 'interpreter_thread_inventory',
  description: 'Read one bounded local native thread page (IDs and saved statuses only). Continue with its opaque cursor; this does not attest queues, live processes or fleet completeness.',
  inputSchema: { type: 'object', properties: { cursor: { type: 'string' } }, required: [] },
  mode: 'read', mainAgentOnly: true, annotations: { readOnlyHint: true },
  handler: (args, context) => readThreadInventoryForCaller(context, args.cursor,
    (params, remaining) => getCodexService().listThreads(params, remaining)),
};
