import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { goalCasExpectedParams, verifyThreadGoalRevision,
  type ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import type { v2 } from '../handlers/codex-generated-types/index';
import { type NativeTerminalStatusRequest, validateNativeTerminalRequest,
  boundNativeTerminalStatus, type NativeTerminalStatusResponse } from '../../src/lib/codex/native-terminal-status';
import { authorizeSupervisorPeer, type VerifiedSupervisorGrant,
  type SupervisorPeerTarget } from '../utils/supervisorPeerScope';
import { threadArtifactReceipts } from '../utils/threadArtifactReceipts';
import { nativeSubmissionJournal } from '../utils/nativeSubmissionJournal';
import { getCodexService } from '../../src/lib/codex/service';
import { createSupervisorGoal, SupervisorGoalCreateError } from '../utils/supervisorGoalCreate';

type Capability = SupervisorPeerTarget['capability'];
type GoalState = { goal: v2.ThreadGoal | null; revision: ThreadGoalRevision | null;
  document: { content: string; sha256: string; byteLength: number; missionRevision: number } | null };

/** Mount only behind a verifier of enrolled supervisor identity and machine scope.
 * HTTP headers, bodies, and an operator session are not a verifier. */
export function createSupervisorPeerRouter(options: Readonly<{
  targetComputer: string;
  verify: (request: Request) => Promise<VerifiedSupervisorGrant | null>;
  readGoal: (threadId: string) => Promise<GoalState>;
  createGoal?: (threadId: string, document: string) => Promise<GoalState>;
  resumeGoal: (threadId: string, expected: ThreadGoalRevision) => Promise<ThreadGoalRevision>;
  readTerminal: (request: NativeTerminalStatusRequest) => Promise<NativeTerminalStatusResponse>;
  readSubmission?: (threadId: string, clientUserMessageId: string) =>
    ReturnType<ReturnType<typeof getCodexService>['readNativeSubmissionCustody']>;
  readJournal?: typeof nativeSubmissionJournal.lookup;
  readArtifact?: typeof threadArtifactReceipts.get;
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
      const create = options.createGoal ?? ((id: string, document: string) =>
        createSupervisorGoal(getCodexService(), id, document));
      const state = await create(req.params.threadId, req.body?.document);
      return void res.json({ available: true, ...state });
    } catch (error) {
      const category = error instanceof SupervisorGoalCreateError ? error.category : 'mutation_unconfirmed';
      return void res.status(category === 'invalid_document' ? 400 : category === 'goal_exists' ? 409 : 503)
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
    } catch { return void res.status(503).json(denied('mutation_unconfirmed')); }
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
