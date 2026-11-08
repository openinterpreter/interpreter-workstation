import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';
import type { ThreadGoalDocumentGetResponse, ThreadGoalDocumentSetResponse } from '../../../../src/lib/codex/goal-document';
import { goalCasExpectedParams, type ThreadGoalRevision } from '../../../../src/lib/codex/goal-revision';

const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const owner = (context: BuiltinToolContext | undefined) => {
  const id = context?.verifiedCallerThreadId;
  return id && THREAD.test(id) && context?.threadId === id && !context?.isSubagent &&
    (context?.toolCallPath?.length ?? 0) === 0 ? id : null;
};
const response = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}),
});
const GOAL_CALL_DEADLINE_MS = 3_000;

/** Expiry only stops waiting; it never cancels or resubmits the native RPC. */
async function bounded<T>(request: () => Promise<T>, maxWaitMs: number): Promise<T> {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > GOAL_CALL_DEADLINE_MS) {
    throw new Error('Invalid native Goal deadline.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native Goal response deadline exceeded.')),
        maxWaitMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Read only the verified caller's native-owned full mission, never another thread's file. */
export async function readGoalDocumentForCaller(context: BuiltinToolContext | undefined,
  read: (threadId: string) => Promise<ThreadGoalDocumentGetResponse>,
  maxWaitMs = GOAL_CALL_DEADLINE_MS) {
  const id = owner(context);
  if (!id) return response({ available: false, category: 'caller_unavailable' }, true);
  try {
    const result = await bounded(() => read(id), maxWaitMs);
    return response({ available: true, ...result });
  } catch {
    return response({ available: false, category: 'read_unavailable' }, true);
  }
}

/** Create once only after a confirmed absence; the native insert is unique across races. */
export async function createGoalDocumentForCaller(context: BuiltinToolContext | undefined,
  document: unknown,
  goalPresence: (threadId: string) => Promise<{ goal: unknown; revision?: unknown }>,
  read: (threadId: string) => Promise<ThreadGoalDocumentGetResponse>,
  create: (threadId: string, document: string) => Promise<ThreadGoalDocumentSetResponse>,
  maxWaitMs = GOAL_CALL_DEADLINE_MS) {
  const id = owner(context);
  if (!id) return response({ created: false, category: 'caller_unavailable' }, true);
  if (typeof document !== 'string' || !document.trim() ||
      Buffer.byteLength(document, 'utf8') > 1_048_576) {
    return response({ created: false, category: 'invalid_document' }, true);
  }
  let present: { goal: unknown; revision?: unknown };
  try { present = await bounded(() => goalPresence(id), maxWaitMs); } catch {
    return response({ created: false, category: 'read_unavailable' }, true);
  }
  if (present.goal !== null) {
    return response({ created: false, category: 'goal_exists' }, true);
  }
  if (present.revision !== undefined && present.revision !== null) {
    return response({ created: false, category: 'read_unavailable' }, true);
  }
  try {
    const created = await bounded(() => create(id, document), maxWaitMs);
    const confirmed = await bounded(() => read(id), maxWaitMs);
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

/** Existing missions can change only under the native four-field identity CAS. */
export async function updateGoalDocumentForCaller(context: BuiltinToolContext | undefined,
  document: unknown, expected: unknown,
  update: (threadId: string, document: string, revision: ThreadGoalRevision) => Promise<{
    goal: { threadId: string }; document: ThreadGoalDocumentSetResponse['document'];
    revision: ThreadGoalRevision;
  }>,
  read: (threadId: string) => Promise<ThreadGoalDocumentGetResponse>,
  maxWaitMs = GOAL_CALL_DEADLINE_MS) {
  const id = owner(context);
  if (!id) return response({ updated: false, category: 'caller_unavailable' }, true);
  if (typeof document !== 'string' || !document.trim() ||
      Buffer.byteLength(document, 'utf8') > 1_048_576) {
    return response({ updated: false, category: 'invalid_document' }, true);
  }
  let revision: ThreadGoalRevision;
  try {
    revision = expected as ThreadGoalRevision;
    goalCasExpectedParams(revision);
  } catch {
    return response({ updated: false, category: 'invalid_revision' }, true);
  }
  try {
    const result = await bounded(() => update(id, document, revision), maxWaitMs);
    const confirmed = await bounded(() => read(id), maxWaitMs);
    if (confirmed.goal?.threadId !== id || confirmed.content !== document ||
        confirmed.document?.sha256 !== result.document.sha256 ||
        confirmed.document?.missionRevision !== result.revision.missionRevision) {
      throw new Error('Unconfirmed native readback');
    }
    return response({ updated: true, document: confirmed.document, revision: result.revision });
  } catch {
    return response({ updated: false, category: 'mutation_unconfirmed' }, true);
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

export const goalDocumentUpdateTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_document_update',
  description: 'Conditionally edit this conversation’s existing managed mission under its exact native Goal identity and revision.',
  inputSchema: { type: 'object', properties: {
    document: { type: 'string' },
    expected: { type: 'object', properties: {
      goalId: { type: 'string' }, status: { type: 'string' },
      missionRevision: { type: 'integer' }, lifecycleRevision: { type: 'integer' },
    }, required: ['goalId', 'status', 'missionRevision', 'lifecycleRevision'] },
  }, required: ['document', 'expected'] },
  mode: 'write', mainAgentOnly: true,
  handler: (args, context) => updateGoalDocumentForCaller(context, args.document, args.expected,
    (id, document, expected) => getCodexService().setThreadGoalDocumentWithRevision({
      threadId: id, document,
    }, expected), id => getCodexService().getThreadGoalDocument(id)),
};
