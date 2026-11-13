import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { GoalRevisionConflictError, goalCasExpectedParams, verifyThreadGoalRevision,
  type ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import type { v2 } from '../handlers/codex-generated-types/index';
import { type NativeTerminalStatusRequest, validateNativeTerminalRequest,
  boundNativeTerminalStatus, type NativeTerminalStatusResponse } from '../../src/lib/codex/native-terminal-status';
import { authorizeSupervisorPeer, type VerifiedSupervisorGrant,
  type SupervisorPeerTarget } from '../utils/supervisorPeerScope';
import { threadArtifactReceipts } from '../utils/threadArtifactReceipts';
import { nativeSubmissionJournal } from '../utils/nativeSubmissionJournal';
import { getCodexService } from '../../src/lib/codex/service';
import { createSupervisorGoal, SupervisorGoalCreateError,
  type SupervisorGoalCreateInput } from '../utils/supervisorGoalCreate';
import { ManagedGoalDocumentError, type ThreadGoalDocument } from '../../src/lib/codex/goal-document';
import { projectSupervisorTurn } from '../utils/supervisorTurnObservation';

type Capability = SupervisorPeerTarget['capability'];
type GoalState = { goal: v2.ThreadGoal | null; revision: ThreadGoalRevision | null;
  document: { content: string; sha256: string; byteLength: number; missionRevision: number } | null };

/** Mount only behind a verifier of enrolled supervisor identity and machine scope.
 * HTTP headers, bodies, and an operator session are not a verifier. */
export function createSupervisorPeerRouter(options: Readonly<{
  targetComputer: string;
  verify: (request: Request) => Promise<VerifiedSupervisorGrant | null>;
  readGoal: (threadId: string) => Promise<GoalState>;
  createGoal?: (threadId: string, input: SupervisorGoalCreateInput) =>
    ReturnType<typeof createSupervisorGoal>;
  resumeGoal: (threadId: string, expected: ThreadGoalRevision) => Promise<ThreadGoalRevision>;
  updateGoalStatus?: (threadId: string, expected: ThreadGoalRevision,
    status: 'paused' | 'blocked') => Promise<ThreadGoalRevision>;
  updateGoalObjective?: (threadId: string, expected: ThreadGoalRevision,
    objective: string) => Promise<ThreadGoalRevision>;
  updateGoalDocument?: (threadId: string, expected: ThreadGoalRevision,
    document: string) => Promise<{ revision: ThreadGoalRevision; document: ThreadGoalDocument }>;
  readTerminal: (request: NativeTerminalStatusRequest) => Promise<NativeTerminalStatusResponse>;
  listTerminalOwners?: (threadId: string, cursor?: string | null) =>
    ReturnType<ReturnType<typeof getCodexService>['listNativeTerminalOwners']>;
  readSubmission?: (threadId: string, clientUserMessageId: string) =>
    ReturnType<ReturnType<typeof getCodexService>['readNativeSubmissionCustody']>;
  readJournal?: typeof nativeSubmissionJournal.lookup;
  readArtifact?: typeof threadArtifactReceipts.get;
  readThread?: (threadId: string) => Promise<v2.Thread>;
}>): Router {
  const router = Router();
  async function authorize(request: Request, capability: Capability) {
    // A verifier failure cannot fall back to the supplied thread or host name.
    const grant = await options.verify(request);
    return authorizeSupervisorPeer(grant, {
      sourceComputer: grant?.sourceComputer ?? '',
      targetComputer: options.targetComputer,
      threadId: request.params.threadId,
      capability,
    });
  }
  const denied = (category: string) => ({ available: false, category });
  router.get('/threads/:threadId/turns/current', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'task:read');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const read = options.readThread ?? ((id: string) => getCodexService().readSupervisorThreadSnapshot(id));
      // A deadline does not cancel the native RPC or establish an empty queue.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const thread = await Promise.race([read(req.params.threadId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('deadline')), 3_000); })])
        .finally(() => { if (timer) clearTimeout(timer); });
      return void res.json({ available: true, ...projectSupervisorTurn(thread, req.params.threadId) });
    } catch { return void res.status(503).json(denied('observation_unavailable')); }
  });
  router.get('/threads/:threadId/goal', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'goal:read');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const state = await options.readGoal(req.params.threadId);
      if (!state || (state.goal === null) !== (state.revision === null)) throw new Error('unavailable');
      verifyThreadGoalRevision(state.goal, state.revision, req.params.threadId);
      if ((state.goal === null) !== (state.document === null) ||
          state.document && (state.document.missionRevision !== state.revision?.missionRevision ||
            Buffer.byteLength(state.document.content, 'utf8') !== state.document.byteLength ||
            state.document.byteLength > 1_048_576 ||
            createHash('sha256').update(state.document.content, 'utf8').digest('hex') !==
              state.document.sha256)) throw new Error('unavailable');
      // Never return a partially observed mission or a revision from a different Goal.
      if (state.goal && JSON.stringify(state.goal).length > 256 * 1024) throw new Error('too large');
      return void res.json({ available: true, ...state });
    } catch { return void res.status(503).json(denied('read_unavailable')); }
  });
  router.post('/threads/:threadId/goal/create', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'goal:create');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const create = options.createGoal ?? ((id: string, input: SupervisorGoalCreateInput) =>
        createSupervisorGoal(getCodexService(), id, input));
      const state = await create(req.params.threadId, req.body);
      return void res.json({ available: true, ...state });
    } catch (error) {
      const category = error instanceof SupervisorGoalCreateError ? error.category : 'mutation_unconfirmed';
      return void res.status(category === 'invalid_request' ? 400 :
        category === 'stale_predecessor' ? 409 : 503)
        .json(denied(category));
    }
  });
  router.post('/threads/:threadId/goal/resume', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'goal:resume');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const expected = req.body?.expected as ThreadGoalRevision;
      goalCasExpectedParams(expected);
      if (expected.status !== 'paused' && expected.status !== 'blocked') {
        return void res.status(400).json(denied('invalid_revision'));
      }
      // Native CAS owns the mutation. A transport failure is UNKNOWN, never a retry authorization.
      const revision = await options.resumeGoal(req.params.threadId, expected);
      return void res.json({ available: true, revision });
    } catch (error) {
      if (error instanceof GoalRevisionConflictError) {
        return void res.status(409).json(denied('stale_revision'));
      }
      return void res.status(503).json(denied('mutation_unconfirmed'));
    }
  });
  router.post('/threads/:threadId/goal/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // An exact enrolled source/target/thread/capability grant, not HTTP input,
      // owns this change. Native CAS still decides the current revision.
      const scope = await authorize(req, 'goal:status-update');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const expected = req.body?.expected as ThreadGoalRevision;
      const status = req.body?.status;
      try { goalCasExpectedParams(expected); } catch {
        return void res.status(400).json(denied('invalid_revision'));
      }
      if (expected.status !== 'active' || (status !== 'paused' && status !== 'blocked') ||
          !req.body || Object.keys(req.body).some(key => key !== 'expected' && key !== 'status')) {
        return void res.status(400).json(denied('invalid_request'));
      }
      if (!options.updateGoalStatus) return void res.status(503).json(denied('mutation_unconfirmed'));
      // No fallback to old, unconditional Goal/set. Native revision CAS owns the effect.
      const revision = await options.updateGoalStatus(req.params.threadId, expected, status);
      return void res.json({ available: true, revision });
    } catch (error) {
      if (error instanceof GoalRevisionConflictError) {
        return void res.status(409).json(denied('stale_revision'));
      }
      return void res.status(503).json(denied('mutation_unconfirmed'));
    }
  });
  router.post('/threads/:threadId/goal/objective', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'goal:objective-update');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const expected = req.body?.expected as ThreadGoalRevision;
      const objective = req.body?.objective;
      try { goalCasExpectedParams(expected); } catch {
        return void res.status(400).json(denied('invalid_revision'));
      }
      if (typeof objective !== 'string' || !objective.trim() ||
          [...objective.trim()].length > 4_000 ||
          Object.keys(req.body).some(key => key !== 'expected' && key !== 'objective')) {
        return void res.status(400).json(denied('invalid_request'));
      }
      if (!options.updateGoalObjective) return void res.status(503).json(denied('mutation_unconfirmed'));
      const revision = await options.updateGoalObjective(req.params.threadId, expected, objective.trim());
      return void res.json({ available: true, revision });
    } catch (error) {
      if (error instanceof GoalRevisionConflictError) return void res.status(409).json(denied('stale_revision'));
      return void res.status(503).json(denied('mutation_unconfirmed'));
    }
  });
  router.post('/threads/:threadId/goal/document', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'goal:document-update');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const expected = req.body?.expected as ThreadGoalRevision;
      const document = req.body?.document;
      try { goalCasExpectedParams(expected); } catch {
        return void res.status(400).json(denied('invalid_revision'));
      }
      if (typeof document !== 'string' || !document.trim() ||
          Buffer.byteLength(document, 'utf8') > 1_048_576 ||
          Object.keys(req.body).some(key => key !== 'expected' && key !== 'document')) {
        return void res.status(400).json(denied('invalid_request'));
      }
      if (!options.updateGoalDocument) return void res.status(503).json(denied('mutation_unconfirmed'));
      const result = await options.updateGoalDocument(req.params.threadId, expected, document);
      if (result.document.missionRevision !== result.revision.missionRevision ||
          result.document.byteLength !== Buffer.byteLength(document, 'utf8') ||
          result.document.sha256 !== createHash('sha256').update(document, 'utf8').digest('hex')) {
        throw Error('invalid native document receipt');
      }
      // The mission is read back only through the separately scoped Goal read.
      return void res.json({ available: true, revision: result.revision,
        document: { sha256: result.document.sha256, byteLength: result.document.byteLength,
          missionRevision: result.document.missionRevision } });
    } catch (error) {
      if (error instanceof ManagedGoalDocumentError && error.category === 'stale_revision') {
        return void res.status(409).json(denied('stale_revision'));
      }
      return void res.status(503).json(denied('mutation_unconfirmed'));
    }
  });
  router.post('/threads/:threadId/terminals/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'command:read');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const input = { ...req.body, threadId: req.params.threadId } as NativeTerminalStatusRequest;
      validateNativeTerminalRequest(input);
      const status = boundNativeTerminalStatus(await options.readTerminal(input), input.terminalGeneration);
      return void res.json({ available: true, ...status });
    } catch { return void res.status(503).json(denied('observation_unavailable')); }
  });
  router.get('/threads/:threadId/terminals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'command:read');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const cursor = req.query.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' ||
          !/^[A-Za-z0-9_-]{1,160}$/.test(cursor))) {
        return void res.status(400).json(denied('invalid_cursor'));
      }
      const list = options.listTerminalOwners ?? ((id: string, after?: string | null) =>
        getCodexService().listNativeTerminalOwners(id, after));
      const result = await list(req.params.threadId, cursor);
      if (result.data.length > 100 || result.data.some(owner => owner.threadId !== req.params.threadId)) {
        throw new Error('wrong owner');
      }
      return void res.json({ available: true, threadId: req.params.threadId,
        data: result.data, nextCursor: result.nextCursor,
        observation: 'native-terminal-owners-only-not-process-status' });
    } catch { return void res.status(503).json(denied('observation_unavailable')); }
  });
  router.get('/threads/:threadId/submissions/:clientUserMessageId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'task:read');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      const clientId = req.params.clientUserMessageId;
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(clientId)) {
        return void res.status(400).json(denied('invalid_client_id'));
      }
      const journal = await (options.readJournal ?? nativeSubmissionJournal.lookup.bind(nativeSubmissionJournal))(
        req.params.threadId, clientId);
      const native = await (options.readSubmission ?? ((threadId, id) =>
        getCodexService().readNativeSubmissionCustody(threadId, id)))(req.params.threadId, clientId);
      if (native.threadId !== req.params.threadId || native.clientUserMessageId !== clientId ||
          native.custodyVerified !== true) throw new Error('unavailable');
      // A missing journal or native match remains an unknown admission outcome.
      return void res.json({ available: true, journal: journal ? {
        requestId: journal.requestId, phase: journal.phase, turnId: journal.turnId,
      } : null, native, observation: 'native-thread-read-not-live-process-custody' });
    } catch { return void res.status(503).json(denied('observation_unavailable')); }
  });
  router.get('/threads/:threadId/artifacts/:receiptId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = await authorize(req, 'artifact:read');
      if (scope !== 'allowed') return void res.status(403).json(denied(scope));
      if (req.query.content !== undefined && req.query.content !== 'true') {
        return void res.status(400).json(denied('invalid_request'));
      }
      const read = options.readArtifact ?? threadArtifactReceipts.get.bind(threadArtifactReceipts);
      const result = await read(req.params.threadId, req.params.receiptId, req.query.content === 'true');
      // The private storage path never crosses the supervisor transport.
      return void res.json({ available: true, threadId: result.threadId,
        receiptId: result.receiptId, sha256: result.sha256, size: result.size,
        ...(req.query.content === 'true' ? { content: result.content } : {}) });
    } catch { return void res.status(503).json(denied('artifact_unavailable')); }
  });
  return router;
}
