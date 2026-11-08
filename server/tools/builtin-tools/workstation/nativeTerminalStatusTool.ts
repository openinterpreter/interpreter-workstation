import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';
import { boundNativeTerminalStatus, validateNativeTerminalRequest, type NativeTerminalStatusRequest,
  type NativeTerminalStatusResponse } from '../../../../src/lib/codex/native-terminal-status';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,160}$/;

type TerminalOwnerPage = { data: Array<{ threadId: string; turnId?: string | null; itemId: string;
  nativeProcessId?: string | null; terminalGeneration?: number | null }>; nextCursor: string | null };

/** Enumerate only this thread's native process owner keys; no command or OS PID. */
export async function listTerminalsForCaller(
  context: BuiltinToolContext | undefined,
  cursor: unknown,
  read: (threadId: string, cursor?: string) => Promise<TerminalOwnerPage>,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      context?.isSubagent || (context?.toolCallPath?.length ?? 0) > 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'caller_unavailable' }) }], isError: true };
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR.test(cursor))) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'invalid_cursor' }) }], isError: true };
  }
  try {
    const page = await read(threadId, cursor as string | undefined);
    if (!page || !Array.isArray(page.data) || page.data.length > 100 ||
        page.nextCursor !== null && (typeof page.nextCursor !== 'string' ||
        !CURSOR.test(page.nextCursor) || page.nextCursor === cursor)) throw new Error('Invalid page');
    const data = page.data.map(owner => {
      if (owner.threadId !== threadId) throw new Error('Cross-thread owner');
      const validated = owner as NativeTerminalStatusRequest;
      validateNativeTerminalRequest(validated);
      return { turnId: validated.turnId, itemId: validated.itemId,
        nativeProcessId: validated.nativeProcessId, terminalGeneration: validated.terminalGeneration };
    });
    return { content: [{ type: 'text', text: JSON.stringify({ available: true,
      data, nextCursor: page.nextCursor }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'observation_unavailable' }) }], isError: true };
  }
}

export const nativeTerminalListTool: BuiltinToolDefinition = {
  name: 'interpreter_native_terminal_list',
  description: 'List bounded native background-process owner IDs for this thread without command or output text.',
  inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } },
  mode: 'read', mainAgentOnly: true, annotations: { readOnlyHint: true },
  handler: (args, context) => listTerminalsForCaller(context, args.cursor,
    (threadId, cursor) => getCodexService().listNativeTerminalOwners(threadId, cursor)),
};

/** The caller observes only its own exact OIX process identity, not saved turn prose. */
export async function readTerminalForCaller(
  context: BuiltinToolContext | undefined,
  args: Record<string, unknown>,
  read: (request: NativeTerminalStatusRequest) => Promise<NativeTerminalStatusResponse>,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      context?.isSubagent || (context?.toolCallPath?.length ?? 0) > 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'caller_unavailable' }) }], isError: true };
  }
  const request = { threadId, turnId: args.turnId, itemId: args.itemId,
    nativeProcessId: args.nativeProcessId, terminalGeneration: args.terminalGeneration,
    ...(args.maxWaitMs === undefined ? {} : { maxWaitMs: args.maxWaitMs }),
  } as NativeTerminalStatusRequest;
  try { validateNativeTerminalRequest(request); }
  catch {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'invalid_owner' }) }], isError: true };
  }
  try {
    const status = boundNativeTerminalStatus(await read(request), request.terminalGeneration);
    return { content: [{ type: 'text', text: JSON.stringify({ available: true,
      ...status }) }] };
  } catch {
    // A deadline does not cancel native work or prove a process exited.
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'observation_unavailable' }) }], isError: true };
  }
}

export const nativeTerminalStatusTool: BuiltinToolDefinition = {
  name: 'interpreter_native_terminal_status',
  description: 'Read bounded live native background-process status for an exact process owned by this thread. Does not return output text.',
  inputSchema: { type: 'object', properties: {
    turnId: { type: 'string' }, itemId: { type: 'string' },
    nativeProcessId: { type: 'string' }, terminalGeneration: { type: 'integer' },
    maxWaitMs: { type: 'integer', minimum: 0, maximum: 1000 },
  }, required: ['turnId', 'itemId', 'nativeProcessId', 'terminalGeneration'] },
  mode: 'read', mainAgentOnly: true, annotations: { readOnlyHint: true },
  handler: (args, context) => readTerminalForCaller(context, args,
    request => getCodexService().readNativeTerminalStatus(request)),
};
