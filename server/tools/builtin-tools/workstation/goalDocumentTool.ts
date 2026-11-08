import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { getCodexService } from '../../../../src/lib/codex/service';
import { ManagedGoalDocumentError,
  type ThreadGoalDocumentGetResponse, type ThreadGoalDocumentSetResponse } from '../../../../src/lib/codex/goal-document';
import { goalCasExpectedParams, type ThreadGoalRevision } from '../../../../src/lib/codex/goal-revision';
import { createSupervisorGoal, SupervisorGoalCreateError,
  type SupervisorGoalCreateInput } from '../../../utils/supervisorGoalCreate';
import { readStableSupervisorGoal } from '../../../utils/supervisorGoalRead';

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
  read: (threadId: string) => ReturnType<typeof readStableSupervisorGoal>,
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

/** One native explicit absent-or-completed CAS; never infer absence from a
 * failed read or fall back to legacy document/set insertion. */
export async function createGoalDocumentForCaller(context: BuiltinToolContext | undefined,
  input: SupervisorGoalCreateInput,
  service: Parameters<typeof createSupervisorGoal>[0],
  maxWaitMs = GOAL_CALL_DEADLINE_MS) {
  const id = owner(context);
  if (!id) return response({ created: false, category: 'caller_unavailable' }, true);
  try {
    const created = await createSupervisorGoal(service, id, input, maxWaitMs);
    return response({ created: true, ...created });
  } catch (error) {
    return response({ created: false, category: error instanceof SupervisorGoalCreateError ?
      error.category : 'mutation_unconfirmed' }, true);
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
  } catch (error) {
    return response({ updated: false, category:
      error instanceof ManagedGoalDocumentError && error.category === 'stale_revision'
        ? 'stale_revision' : 'mutation_unconfirmed' }, true);
  }
}

export const goalDocumentReadTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_document_get',
  description: 'Read the full native-managed mission of this verified conversation.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  mode: 'read', mainAgentOnly: true, annotations: { readOnlyHint: true },
  handler: (_args, context) => readGoalDocumentForCaller(context,
    id => readStableSupervisorGoal(getCodexService(), id)),
};

export const goalDocumentCreateTool: BuiltinToolDefinition = {
  name: 'interpreter_goal_document_create',
  description: 'Create this conversation’s distinct native-managed full mission after an explicit no-Goal read or exact completed predecessor.',
  inputSchema: { type: 'object', properties: {
    creationId: { type: 'string' }, objective: { type: 'string' }, document: { type: 'string' },
    precondition: { type: 'object', properties: {
      kind: { type: 'string', enum: ['absent', 'completed'] },
      admissionState: { type: 'string', enum: ['noGoal'] },
      expectedGoalId: { type: 'string' }, expectedStatus: { type: 'string', enum: ['complete'] },
      expectedMissionRevision: { type: 'integer' }, expectedLifecycleRevision: { type: 'integer' },
    }, required: ['kind'] },
  }, required: ['creationId', 'objective', 'document', 'precondition'] },
  mode: 'write', mainAgentOnly: true,
  handler: (args, context) => createGoalDocumentForCaller(context,
    args as SupervisorGoalCreateInput, getCodexService()),
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
