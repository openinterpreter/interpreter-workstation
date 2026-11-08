import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';
import { boundNativeTerminalStatus, validateNativeTerminalRequest, type NativeTerminalStatusRequest,
  type NativeTerminalStatusResponse } from '../../../../src/lib/codex/native-terminal-status';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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
