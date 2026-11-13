import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import type { v2 } from '../../../handlers/codex-generated-types/index';
import { getCodexService } from '../../../../src/lib/codex/service';
import { projectSupervisorTurn } from '../../../utils/supervisorTurnObservation';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** A saved native turn observation is not live OS process custody. The same
 * server-verified main-agent binding that gates Goal and terminal tools also
 * gates this bounded projection; never return rollout content or private text. */
export async function readCurrentTaskForCaller(
  context: BuiltinToolContext | undefined,
  read: (threadId: string) => Promise<v2.Thread>,
  maxWaitMs = 3_000,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      context?.isSubagent || (context?.toolCallPath?.length ?? 0) > 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'caller_unavailable' }) }], isError: true };
  }
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 3_000) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'observation_unavailable' }) }], isError: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const thread = await Promise.race([read(threadId), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('observation deadline')), maxWaitMs);
    })]);
    return { content: [{ type: 'text', text: JSON.stringify({ available: true,
      ...projectSupervisorTurn(thread, threadId) }) }] };
  } catch {
    // Timeout does not cancel native work or prove an absent task or command.
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'observation_unavailable' }) }], isError: true };
  } finally { if (timer) clearTimeout(timer); }
}

export const currentTaskTool: BuiltinToolDefinition = {
  name: 'interpreter_task_current',
  description: 'Read this thread’s bounded saved native turn and command metadata. Historical messages are labeled; saved command state is not live process status.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  mode: 'read', mainAgentOnly: true, annotations: { readOnlyHint: true },
  handler: (_args, context) => readCurrentTaskForCaller(context,
    threadId => getCodexService().readSupervisorThreadSnapshot(threadId)),
};
