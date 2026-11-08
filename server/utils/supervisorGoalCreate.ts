import { getCodexService } from '../../src/lib/codex/service';
import { ManagedGoalDocumentError, verifyGoalDocument,
  type ThreadGoalDocumentCreateParams } from '../../src/lib/codex/goal-document';
import { goalCasExpectedParams, verifyThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import { readStableSupervisorGoal } from './supervisorGoalRead';

type Service = Pick<ReturnType<typeof getCodexService>,
  'getThreadGoalWithRevision' | 'getThreadGoalDocument' | 'createThreadGoalDocument'>;

/** Exact OIX tree 22d6ff263964: one new Goal after a completed predecessor. */
export type SupervisorGoalCreateInput = Omit<ThreadGoalDocumentCreateParams, 'threadId' | 'status'>;

export class SupervisorGoalCreateError extends Error {
  constructor(readonly category: 'invalid_request' | 'stale_predecessor' |
    'create_unavailable' | 'read_unavailable' | 'mutation_unconfirmed') {
    super(category);
  }
}

const creationIdPattern = /^[A-Za-z0-9_-]{1,160}$/;

/** Native owns atomic predecessor CAS and creation-ID replay. Never read-then-set
 * a missing Goal, or automatically reissue an uncertain native mutation. */
export async function createSupervisorGoal(service: Service, threadId: string,
  input: SupervisorGoalCreateInput, maxWaitMs = 3_000) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.document !== 'string' || !input.document.trim() ||
      Buffer.byteLength(input.document, 'utf8') > 1_048_576 ||
      typeof input.objective !== 'string' || !input.objective.trim() ||
      input.objective.length > 4_000 ||
      typeof input.creationId !== 'string' || !creationIdPattern.test(input.creationId) ||
      input.expectedStatus !== 'complete' ||
      !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 3_000) {
    throw new SupervisorGoalCreateError('invalid_request');
  }
  try {
    goalCasExpectedParams({ goalId: input.expectedGoalId, status: input.expectedStatus,
      missionRevision: input.expectedMissionRevision,
      lifecycleRevision: input.expectedLifecycleRevision });
    verifyGoalDocument(threadId, null, null);
  } catch { throw new SupervisorGoalCreateError('invalid_request'); }

  const objective = input.objective.trim();
  const params: ThreadGoalDocumentCreateParams = {
    threadId, creationId: input.creationId, objective,
    document: input.document, status: 'active',
    expectedGoalId: input.expectedGoalId, expectedStatus: 'complete',
    expectedMissionRevision: input.expectedMissionRevision,
    expectedLifecycleRevision: input.expectedLifecycleRevision,
  };
  let result: Awaited<ReturnType<Service['createThreadGoalDocument']>>;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      service.createThreadGoalDocument(params, maxWaitMs),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new SupervisorGoalCreateError('mutation_unconfirmed')),
          maxWaitMs);
      }),
    ]);
  }
  catch (error) {
    if (error instanceof ManagedGoalDocumentError &&
        (error.category === 'stale_predecessor' || error.category === 'create_unavailable')) {
      throw new SupervisorGoalCreateError(error.category);
    }
    throw new SupervisorGoalCreateError('mutation_unconfirmed');
  } finally { if (deadline) clearTimeout(deadline); }

  // A receipt with another creation ID, predecessor, owner, or document is not
  // an acknowledgment for this request. Do not expose native private errors.
  try {
    if (result.creationId !== input.creationId || typeof result.replayed !== 'boolean' ||
        result.goal.threadId !== threadId || result.goal.status !== 'active' ||
        result.goal.objective !== objective ||
        result.previousRevision.goalId !== input.expectedGoalId ||
        result.previousRevision.status !== 'complete' ||
        result.previousRevision.missionRevision !== input.expectedMissionRevision ||
        result.previousRevision.lifecycleRevision !== input.expectedLifecycleRevision ||
        result.revision.goalId === input.expectedGoalId) throw Error('receipt mismatch');
    verifyThreadGoalRevision(result.goal, result.revision, threadId);
    verifyGoalDocument(threadId, result.document, input.document);
    const state = await readStableSupervisorGoal(service, threadId, maxWaitMs);
    if (!state.goal || !state.revision || !state.document ||
        JSON.stringify(state.revision) !== JSON.stringify(result.revision) ||
        state.document.content !== input.document ||
        state.document.sha256 !== result.document.sha256) throw Error('readback mismatch');
    return { ...state, creationId: result.creationId,
      previousRevision: result.previousRevision, replayed: result.replayed };
  } catch { throw new SupervisorGoalCreateError('mutation_unconfirmed'); }
}
