import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';
import { goalCasExpectedParams, type ThreadGoalRevision } from '../../../../src/lib/codex/goal-revision';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Only a server-verified in-thread caller can inspect its native CAS identity. */
export async function readGoalRevisionForCaller(
  context: BuiltinToolContext | undefined,
  read: (threadId: string) => Promise<{ goal: unknown; revision: unknown }>,
  maxWaitMs = 3_000,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      (context?.toolCallPath?.length ?? 0) > 0 || context?.isSubagent) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'caller_unavailable' }) }], isError: true };
  }
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 3_000) {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'read_unavailable' }) }], isError: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Expiring this observation never cancels, retries or interprets the native RPC.
    const { goal, revision } = await Promise.race([read(threadId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Goal read deadline exceeded')), maxWaitMs);
      })]);
    // A present Goal without its native CAS identity (or an absent Goal with
    // a revision) cannot authorize same-Goal control or a new Goal insertion.
    if ((goal === null) !== (revision === null)) throw new Error('Inconsistent Goal revision');
    if (goal !== null) goalCasExpectedParams(revision as ThreadGoalRevision);
    return { content: [{ type: 'text', text: JSON.stringify({ available: true,
      goalPresent: goal !== null, revision }) }] };
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ available: false,
      category: 'read_unavailable' }) }], isError: true };
  } finally {
    if (timer) clearTimeout(timer);
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

/** Resume this Goal only if native still owns precisely the observed four-field revision. */
export async function resumeGoalForCaller(
  context: BuiltinToolContext | undefined,
  expected: unknown,
  resume: (threadId: string, revision: ThreadGoalRevision) => Promise<{
    revision: ThreadGoalRevision;
  }>,
) {
  const threadId = context?.verifiedCallerThreadId;
  if (!threadId || !THREAD.test(threadId) || context?.threadId !== threadId ||
      (context?.toolCallPath?.length ?? 0) > 0 || context?.isSubagent) {
    return { content: [{ type: 'text', text: JSON.stringify({ resumed: false,
      category: 'caller_unavailable' }) }], isError: true };
  }
  let revision: ThreadGoalRevision;
  try {
    revision = expected as ThreadGoalRevision;
    goalCasExpectedParams(revision);
    if (revision.status !== 'paused' && revision.status !== 'blocked') throw new Error('Not resumable');
  } catch {
    return { content: [{ type: 'text', text: JSON.stringify({ resumed: false,
      category: 'invalid_revision' }) }], isError: true };
  }
  try {
    const result = await resume(threadId, revision);
    return { content: [{ type: 'text', text: JSON.stringify({ resumed: true,
      revision: result.revision }) }] };
  } catch {
    // Transport loss can mean the write committed. Never retry or claim rejection.
    return { content: [{ type: 'text', text: JSON.stringify({ resumed: false,
      category: 'mutation_unconfirmed' }) }], isError: true };
  }
}

export const goalResumeTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_resume',
  description: 'Conditionally resume this conversation’s paused or blocked native Goal using its exact observed identity and revision.',
  inputSchema: { type: 'object', properties: {
    expected: { type: 'object', properties: {
      goalId: { type: 'string' }, status: { type: 'string', enum: ['paused', 'blocked'] },
      missionRevision: { type: 'integer' }, lifecycleRevision: { type: 'integer' },
    }, required: ['goalId', 'status', 'missionRevision', 'lifecycleRevision'] },
  }, required: ['expected'] },
  mode: 'write',
  mainAgentOnly: true,
  handler: (args, context) => resumeGoalForCaller(context, args.expected,
    async (threadId, revision) => getCodexService().setThreadGoalWithRevision(threadId,
      revision, { status: 'active' })),
};
