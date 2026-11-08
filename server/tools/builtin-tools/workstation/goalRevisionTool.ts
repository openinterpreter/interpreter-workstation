import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Only a server-verified in-thread caller can inspect its native CAS identity. */
export async function readGoalRevisionForCaller(
  context: BuiltinToolContext | undefined,
  read: (threadId: string) => Promise<{ goal: unknown; revision: unknown }>,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      (context?.toolCallPath?.length ?? 0) > 0 || context?.isSubagent) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'caller_unavailable' }) }], isError: true };
  }
  try {
    const { goal, revision } = await read(threadId);
    return { content: [{ type: 'text', text: JSON.stringify({ available: true,
      goalPresent: goal !== null, revision }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'read_unavailable' }) }], isError: true };
  }
}

export const goalRevisionTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_revision_get',
  description: 'Inspect the current conversation’s exact native Goal CAS identity and revision without reading mission content.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  mode: 'read',
  mainAgentOnly: true,
  annotations: { readOnlyHint: true },
  handler: (_args, context) => readGoalRevisionForCaller(context,
    threadId => getCodexService().getThreadGoalWithRevision(threadId)),
};
