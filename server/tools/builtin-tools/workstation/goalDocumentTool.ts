import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';
import type { ThreadGoalDocumentGetResponse, ThreadGoalDocumentSetResponse } from '../../../../src/lib/codex/goal-document';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const owner = (context: BuiltinToolContext | undefined) => {
  const id = context?.verifiedCallerThreadId;
  return id && THREAD.test(id) && context?.threadId === id && !context?.isSubagent &&
    (context?.toolCallPath?.length ?? 0) === 0 ? id : null;
};
const response = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}),
});

/** Read only the verified caller's native-owned full mission, never another thread's file. */
export async function readGoalDocumentForCaller(context: BuiltinToolContext | undefined,
  read: (threadId: string) => Promise<ThreadGoalDocumentGetResponse>) {
  const id = owner(context);
  if (!id) return response({ available: false, category: 'caller_unavailable' }, true);
  try {
    const result = await read(id);
    return response({ available: true, ...result });
  } catch {
    return response({ available: false, category: 'read_unavailable' }, true);
  }
}

/** Create once only after a confirmed absence; the native insert is unique across races. */
export async function createGoalDocumentForCaller(context: BuiltinToolContext | undefined,
  document: unknown,
  goalPresence: (threadId: string) => Promise<{ goal: unknown }>,
  read: (threadId: string) => Promise<ThreadGoalDocumentGetResponse>,
  create: (threadId: string, document: string) => Promise<ThreadGoalDocumentSetResponse>) {
  const id = owner(context);
  if (!id) return response({ created: false, category: 'caller_unavailable' }, true);
  if (typeof document !== 'string' || !document.trim() ||
      Buffer.byteLength(document, 'utf8') > 1_048_576) {
    return response({ created: false, category: 'invalid_document' }, true);
  }
  let present: { goal: unknown };
  try { present = await goalPresence(id); } catch {
    return response({ created: false, category: 'read_unavailable' }, true);
  }
  if (present.goal !== null) {
    return response({ created: false, category: 'goal_exists' }, true);
  }
  try {
    const created = await create(id, document);
    const confirmed = await read(id);
    if (confirmed.goal?.threadId !== id || confirmed.content !== document ||
        confirmed.document?.sha256 !== created.document.sha256 ||
        confirmed.document?.missionRevision !== created.document.missionRevision) {
      throw new Error('Unconfirmed native readback');
    }
    return response({ created: true, goal: confirmed.goal, document: confirmed.document });
  } catch {
    // A lost response may follow a committed insert. Never submit again automatically.
    return response({ created: false, category: 'mutation_unconfirmed' }, true);
  }
}

export const goalDocumentReadTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_document_get',
  description: 'Read the full native-managed mission of this verified conversation.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  mode: 'read', mainAgentOnly: true, annotations: { readOnlyHint: true },
  handler: (_args, context) => readGoalDocumentForCaller(context,
    id => getCodexService().getThreadGoalDocument(id)),
};

export const goalDocumentCreateTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_document_create',
  description: 'Create this conversation’s native-managed full mission only when its Goal is absent.',
  inputSchema: { type: 'object', properties: { document: { type: 'string' } },
    required: ['document'] },
  mode: 'write', mainAgentOnly: true,
  handler: (args, context) => createGoalDocumentForCaller(context, args.document,
    id => getCodexService().getThreadGoalWithRevision(id),
    id => getCodexService().getThreadGoalDocument(id),
    (id, document) => getCodexService().setThreadGoalDocument({ threadId: id, document,
      status: 'active' })),
};
