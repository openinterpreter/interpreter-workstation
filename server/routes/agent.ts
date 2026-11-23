import { Router, Request, Response, raw } from 'express';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { nativeSubmissionJournal, parseSubmissionSender, senderHeader,
  type SubmissionSender } from '../utils/nativeSubmissionJournal';
import { SubagentDirectInputError, type SubagentInputRefusal }
  from '../../src/lib/codex/subagent-input';
import { isAcceptedOffer, isWakeId, PausedCommandConflictError, THREAD_INPUT_SOURCE, threadInputCustody, WAKE_MESSAGE_LIMIT,
  WakeContentConflictError, WakeSourceCancelledError, wakeTokenValid, WakeUnsavedError, type WakeEvent }
  from '../utils/wakeSources';
import { readyWakeSources, wakeSources } from '../utils/wakeSourcesRuntime';
import { outcomeReturns, readyOutcomeReturns } from '../utils/outcomeReturnsRuntime';
import { stat } from 'node:fs/promises';
import { getCustomInstructions } from '../configStore';
import { getServerJWT } from '../lib/jwtStore';
import { AgentModelConfig } from '../../shared/types/model';
import { messageQueueStore } from '../utils/messageQueueStore';
import { enrichThreadTurnsFromRollout } from '../utils/threadRolloutEnrichment';
import { readCuaProcessLockCustody } from '../utils/cuaProcessLockMetadata';
import { cleanupACPProvider } from '../utils/acpProvider';
import { getCurrentWorkspace, requireExistingWorkspacePath } from '../utils/workspace';
import { setCurrentTurnMessageId } from '../utils/turnMessageIdRegistry';
import { registerPendingToolCall } from '../utils/codexMcpBridge';
import { parseToolName } from '../../shared/utils/mcpToolName';
import { closeWhatsAppBridgeSession } from '../services/whatsappBridge';
import { getServerPort } from '../utils/serverPort';
import { sanitizeGroqResponsesRequest } from '../utils/groqResponsesProxy';
import {
  updateTitle,
  loadConversation,
  listConversations,
  deleteConversation,
  clearFromCache,
} from '../utils/conversationStore';
import { getAllSubagentToolCalls, clearAllSubagentToolCalls } from '../utils/subagentToolStore';
import {
  registerRunningAgent,
  stopAgentAndDescendants,
  unregisterRunningAgent,
} from '../utils/runningAgentRegistry';
import { taskStore } from '../tools/builtin-tools/tasks/taskStore';
import { buildAgentTurnErrorTrace } from '../utils/agentTurnErrorTrace';
import {
  forkAgentTaskThread,
  coldBindAgentTaskThread,
  resumeAgentTaskThread,
  startAgentTask,
  resolveAgentModelConfig,
  type AgentTaskMode,
  type AgentTaskProgressEvent,
  type AgentTaskResult,
} from '../agentTaskService';
import {
  applyProgrammaticTaskRuntimeConfig,
  type ProgrammaticTaskDefaultProfileConfig,
} from '../programmaticTaskRuntimeConfig';
import { validateRuntimeModelId } from '../utils/runtimeModelValidation';
import type {
  BackgroundTerminalStopRequestBody,
  SteerRequestBody,
  StopRequestBody,
  StreamRequestBody,
} from '../../src/lib/codex/api-types';
import {
  mapNotificationToUiEvents,
  type UiStreamEvent,
} from '../../src/lib/codex/event-mapper';
import {
  formatLmStudioPromptTemplateFailure,
  isLmStudioPromptTemplateFailure,
} from '../../src/lib/codex/lmStudioErrors';
import {
  NativeCustodyPhaseError,
  NativeGlobalInventoryError,
  SavedThreadIdentityError,
  ThreadNotFoundError,
  type ThreadShell,
  NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS,
  NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS,
  getCodexService,
  getSteerErrorCode,
  THREAD_LIST_DEFAULTS,
} from '../../src/lib/codex/service';
import { GoalRevisionConflictError, goalCasExpectedParams,
  type ThreadGoalRevision } from '../../src/lib/codex/goal-revision';
import {
  buildProfileFromPreset,
  getCustomPreset,
  getProfile as getCodexProfile,
  type Profile as CodexProfile,
  withAuthToken,
} from '../../src/lib/codex/profiles';
import { inferProfileIdFromEndpoint } from '../../src/lib/codex/profile-options';
import type { JsonValue } from '../handlers/codex-generated-types/serde_json/JsonValue';
import { resolveLocalRuntimeModelId } from '../../shared/types/provider';
import {
  validateBackgroundTerminalStopRequestBody,
  validateSteerRequestBody,
  validateStopRequestBody,
  validateStreamRequestBody,
} from '../../src/lib/validators';
import {
  normalizeStreamRequestBody,
  type NormalizedStreamRequest,
} from './agentStreamRequest';
import { resolveLocalModelToolUseSupport } from '../handlers/providers';
import { renameThread } from '../handlers/agentThreads';
import { getActiveSimpleProject } from '../simpleProjects';

import { appendCustomInstructionsToPrompt } from '../utils/customInstructions';
import { isReasoningEffort } from '../../shared/types/reasoning';
import { transcribeWavWithQwenAsr } from '../utils/qwenAsr';
import {
  abortQwenAsrStreamSession,
  appendQwenAsrStreamChunk,
  extractRingBuffer,
  finishQwenAsrStreamSession,
  startQwenAsrStreamSession,
} from '../utils/qwenAsrStream';
import { inferSmartTurn } from '../utils/smartTurnService';
import { requiresFreshThread } from '../utils/codexThreadRecovery';
import {
  getMainAgentBaseInstructions,
  getMainAgentDeveloperPrompt,
} from '../utils/mainAgentPrompt';
import { agentTabManager } from '../agentTabManager';
import { approvalManager } from '../approvalManager';
import {
  buildInterpreterCliShellEnvironmentPolicy,
  ensureInterpreterCliLauncher,
} from '../utils/interpreterCliRuntime';
import {
  ensureOpenAIOAuthAccountReady,
  resolveCodexProfileForStreamRequest,
  resolveAgentModelConfigForStreamRequest,
  runCodexAgentTurn,
} from '../utils/codexRuntime';
import {
  getProgrammaticTaskWorkspaceError,
  normalizeHeadlessTaskWorkspace,
} from '../utils/headlessTaskWorkspace';
import type { v2 } from '../handlers/codex-generated-types/index';
import {
  isThreadHistoryCursor,
  parseThreadHistoryLimit,
} from '../utils/threadHistoryPagination';

/** Saved-history bytes the repeating history refresh may read per request. */
const PASSIVE_REFRESH_ROLLOUT_BYTE_BUDGET = 1024 * 1024;

const router = Router();

// This is intentionally separate from renderer-scoped lists: an empty result
// here means every in-process queue was checked, not merely the current tab.
router.get('/custody/global', (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    const appQueues = messageQueueStore.getCustodyInventory();
    const tabs = agentTabManager.getGlobalCustodyInventory();
    const approvalIds = approvalManager.getGlobalPendingRequestIds();
    return res.json({
      scope: 'all-in-process',
      appQueues,
      pendingTabRequests: { count: tabs.pendingRequestIds.length, requestIds: tabs.pendingRequestIds },
      pendingTabStartups: { count: tabs.pendingStartupIds.length, requestIds: tabs.pendingStartupIds },
      createdTabRequests: { count: tabs.createdRequestIds.length, requestIds: tabs.createdRequestIds },
      pendingApprovals: { count: approvalIds.length, requestIds: approvalIds },
      nativeQueueScope: 'thread-only',
    });
  } catch {
    return res.status(503).json({ error: 'Global custody inspection unavailable.' });
  }
});

router.get('/custody/native-global', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const inspectionId = randomUUID();
  const recordPhase = (phase: string, status: string) => {
    console.info(JSON.stringify({ event: 'native_global_custody_inspection', inspectionId, phase, status }));
  };
  recordPhase('request', 'received');
  let nativeReadComplete = false;
  try {
    const native = await getCodexService().readGlobalNativeCustody(
      NATIVE_CUSTODY_GLOBAL_OPERATOR_DEADLINE_MS, recordPhase);
    nativeReadComplete = true;
    const cua = readCuaProcessLockCustody();
    recordPhase('inspection', 'completed');
    return res.json({ native, cua, inspectionId });
  } catch (error) {
    const phase = error instanceof NativeCustodyPhaseError ? error.phase
      : error instanceof NativeGlobalInventoryError ? 'inventory'
      : nativeReadComplete ? 'cua_lock' : 'unknown';
    const category = error instanceof NativeCustodyPhaseError || error instanceof NativeGlobalInventoryError
      ? error.category : 'native_unavailable';
    recordPhase(phase, category);
    // An operator can correlate these digests with its own bounded native/DB
    // metadata without publishing a loaded thread UUID or exception prose.
    // This is diagnostic only: a mismatch is still an absolute custody failure.
    const missingLoadedThreadDigests = error instanceof NativeGlobalInventoryError &&
      error.category === 'loaded_missing' && error.missingLoadedThreadDigests &&
      error.missingLoadedThreadDigests.length > 0 && error.missingLoadedThreadDigests.length <= 500 &&
      error.missingLoadedThreadDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest))
      ? error.missingLoadedThreadDigests : undefined;
    return res.status(503).json({ error: 'Native or Computer Use custody inspection unavailable.',
      phase, category,
      custodyVerified: false, inspectionId, ...(missingLoadedThreadDigests && { missingLoadedThreadDigests }) });
  }
});

// An exact opaque ID is required. The thread must match its captured owner;
// a CLI request with no thread binding needs an explicit unbound query instead.
router.get('/custody/approvals/:approvalId', (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { approvalId } = req.params;
  const threadId = req.query.threadId;
  const cliUnbound = req.query.cliUnbound;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(approvalId) ||
      (threadId === undefined && cliUnbound !== '1') ||
      (threadId !== undefined && cliUnbound !== undefined) ||
      (threadId !== undefined && (typeof threadId !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId)))) {
    return res.status(400).json({ error: 'Exact approval and owner scope required.' });
  }
  try {
    const scope = threadId === undefined ? { cliUnbound: true as const } : { threadId: threadId as string };
    const metadata = approvalManager.getPendingApprovalCustody(approvalId, scope);
    if (!metadata) return res.status(404).json({ error: 'Pending approval not found in scope.' });
    return res.json(metadata);
  } catch {
    return res.status(503).json({ error: 'Approval custody inspection unavailable.' });
  }
});

// Operator-only exact-card disposition. This never grants a policy or resolves
// another tool's card; the ordinary approval manager resumes the original waiter.
router.post('/custody/approvals/:approvalId/decide', (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { approvalId } = req.params;
  const { threadId, toolName, decision, decisionRef } = req.body ?? {};
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(approvalId) ||
      typeof threadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ||
      typeof toolName !== 'string' || !/^cua_driver:[A-Za-z0-9_.:-]{1,100}$/.test(toolName) ||
      !['approve', 'deny'].includes(decision) ||
      typeof decisionRef !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(decisionRef)) {
    return res.status(400).json({ error: 'Exact scoped Computer Use decision required.' });
  }
  if (!approvalManager.decideOwnedCuaApproval({ id: approvalId, threadId, toolName, decision })) {
    return res.status(409).json({ error: 'Pending card or original owner changed.' });
  }
  console.info('[CUA approval disposition]', JSON.stringify({
    approvalId, threadId, toolName, decision, decisionRef, status: 'resolved',
  }));
  return res.json({ approvalId, threadId, toolName, decision, decisionRef, status: 'resolved',
    continuationStatus: 'not-verified' });
});

function wakeMutationAllowed(req: Request): boolean {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) return false;
  const origin = req.header('origin');
  if (!origin) return true; // local CLI; remote hosts remain subject to workstationAccessMiddleware
  try { return new URL(origin).host === req.get('host'); }
  catch { return false; }
}

// Saved-thread identity includes local filesystem paths. Matching Origin to an
// arbitrary Host is not sufficient: a rebinding hostname can supply both.
function savedThreadIdentityReadAllowed(req: Request): boolean {
  if (!wakeMutationAllowed(req)) return false;
  const host = req.get('host');
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.host.toLowerCase() === host.toLowerCase() &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Inbound producers know the explicit secret; a normal browser session never
// receives it. This is not a public desktop or network ingress endpoint.
router.post('/threads/:threadId/wake-events', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { sourceId, eventId, message } = req.body ?? {};
  // Programmatic task input has its own source; a producer cannot claim its IDs.
  if (sourceId === THREAD_INPUT_SOURCE) return res.status(400).json({ error: 'Reserved source ID.' });
  if (!isWakeId(req.params.threadId)) return res.status(400).json({ error: 'Invalid thread ID.' });
  try { await readyWakeSources(); }
  catch { return res.status(503).json({ error: 'Wake sources unavailable.' }); }
  const thread = await readInputThread(req.params.threadId);
  if ('error' in thread) return res.status(thread.error.status).json({ error: thread.error.message });
  try {
    const event = await wakeSources.ingest(req.params.threadId, sourceId, eventId, message);
    res.status(202).json({ eventId: event.eventId, status: event.status });
    void wakeSources.tick().catch(console.error);
  } catch (error) {
    const failure = wakeIngestFailure(error);
    res.status(failure.status).json({ error: failure.status === 400 && error instanceof Error
      ? error.message : failure.message });
  }
});

/** Read a thread's shell for an input-path check: 404 only when the runtime
 * says the thread does not exist, 503 when it could not be read. */
async function readInputThread(threadId: string): Promise<{ thread: ThreadShell } |
  { error: { status: 404 | 503; message: string } }> {
  try { return { thread: await getCodexService().readThreadShell(threadId) }; }
  catch (error) {
    return error instanceof ThreadNotFoundError
      ? { error: { status: 404, message: 'Thread not found.' } }
      : { error: { status: 503, message: 'Thread could not be read; nothing was accepted. Retry later.' } };
  }
}

/** HTTP status for a failed wake ingestion. */
function wakeIngestFailure(error: unknown): { status: number; message: string } {
  if (error instanceof WakeContentConflictError) {
    return { status: 409, message: 'Client ID already used for different input.' };
  }
  if (error instanceof WakeUnsavedError) {
    return { status: 503, message: 'Input could not be saved; retry with the same ID.' };
  }
  if (error instanceof WakeSourceCancelledError) return { status: 400, message: 'Source is cancelled.' };
  if (error instanceof Error && error.message === 'Invalid wake event') return { status: 400, message: error.message };
  return { status: 503, message: 'Input could not be retained; nothing was accepted.' };
}

// Local operator diagnostic through the *existing* native client. Return only
// bounded queue identifiers and status, never the queued input or transcript.
router.get('/threads/:threadId/native-custody', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(req.params.threadId)) {
    return res.status(400).json({ error: 'Invalid thread ID.' });
  }
  // A response can be lost on transport; fixed, content-free phases distinguish
  // an absent request from a native read that has not yet returned.
  const inspectionId = randomUUID();
  const recordPhase = (phase: string, status: string) => {
    console.info(JSON.stringify({ event: 'native_custody_inspection', inspectionId, phase, status }));
  };
  recordPhase('request', 'received');
  try {
    const custody = await getCodexService().readNativeCustody(req.params.threadId,
      NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS, recordPhase);
    recordPhase('inspection', 'completed');
    res.json({ ...custody, inspectionId });
  } catch (error) {
    // Failure remains unknown custody; expose only the fixed phase/category.
    recordPhase(error instanceof NativeCustodyPhaseError ? error.phase : 'unknown',
      error instanceof NativeCustodyPhaseError ? error.category : 'native_unavailable');
    res.status(503).json(error instanceof NativeCustodyPhaseError
      ? { error: 'Native custody inspection unavailable.', phase: error.phase,
          category: error.category, custodyVerified: false, inspectionId }
      : { error: 'Native custody inspection unavailable.',
          phase: 'unknown', category: 'native_unavailable', custodyVerified: false, inspectionId });
  }
});

// Authenticated, exact-owner read. A POST keeps opaque native identity out of
// URL/access logs; it never sends a process action or exposes output text.
router.post('/threads/:threadId/native-terminal-status', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.threadId !== undefined && body.threadId !== req.params.threadId) {
    return res.status(400).json({ error: 'Exact native terminal owner required.' });
  }
  const request = { threadId: req.params.threadId, turnId: body.turnId,
    itemId: body.itemId, nativeProcessId: body.nativeProcessId,
    terminalGeneration: body.terminalGeneration, maxWaitMs: body.maxWaitMs };
  try {
    const { validateNativeTerminalRequest } = await import('../../src/lib/codex/native-terminal-status');
    validateNativeTerminalRequest(request);
  } catch {
    return res.status(400).json({ error: 'Exact native terminal owner required.' });
  }
  const inspectionId = randomUUID();
  const recordPhase = (phase: string, status: string) => {
    console.info(JSON.stringify({ event: 'native_terminal_status_inspection', inspectionId, phase, status }));
  };
  recordPhase('request', 'received');
  try {
    const observation = await getCodexService().readNativeTerminalStatus(request,
      NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS, recordPhase);
    recordPhase('inspection', 'completed');
    return res.json({ ...observation, inspectionId,
      custodyVerified: observation.phase !== 'unknown' });
  } catch (error) {
    recordPhase(error instanceof NativeCustodyPhaseError ? error.phase : 'terminal_status',
      error instanceof NativeCustodyPhaseError ? error.category : 'native_unavailable');
    return res.status(503).json({ error: 'Native terminal observation unavailable.',
      phase: 'terminal_status', category: error instanceof NativeCustodyPhaseError ? error.category : 'native_unavailable',
      custodyVerified: false, inspectionId });
  }
});

router.get('/threads/:threadId/native-terminal-owners', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(req.params.threadId) ||
      req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(req.query.cursor))) {
    return res.status(400).json({ error: 'Exact thread and bounded cursor required.' });
  }
  try {
    const owners = await getCodexService().listNativeTerminalOwners(req.params.threadId,
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
    return res.json(owners);
  } catch {
    return res.status(503).json({ error: 'Native terminal owners unavailable.', custodyVerified: false });
  }
});

router.get('/threads/:threadId/native-turn-receipt/:turnId', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (!uuid.test(req.params.threadId) || !uuid.test(req.params.turnId)) {
    return res.status(400).json({ error: 'Exact native thread and turn required.' });
  }
  const inspectionId = randomUUID();
  const recordPhase = (phase: string, status: string) => {
    console.info(JSON.stringify({ event: 'native_turn_receipt_inspection', inspectionId, phase, status }));
  };
  recordPhase('request', 'received');
  try {
    const receipt = await getCodexService().readNativeTurnReceipt(req.params.threadId, req.params.turnId,
      NATIVE_CUSTODY_OPERATOR_PHASE_DEADLINE_MS, recordPhase);
    recordPhase('inspection', 'completed');
    return receipt ? res.json({ ...receipt, inspectionId }) : res.status(404).json({ error: 'Native turn not found.', inspectionId });
  } catch (error) {
    recordPhase(error instanceof NativeCustodyPhaseError ? error.phase : 'unknown',
      error instanceof NativeCustodyPhaseError ? error.category : 'native_unavailable');
    return res.status(503).json({ error: 'Native turn receipt unavailable.',
      phase: error instanceof NativeCustodyPhaseError ? error.phase : 'unknown',
      category: error instanceof NativeCustodyPhaseError ? error.category : 'native_unavailable',
      custodyVerified: false, inspectionId });
  }
});

// Explicit local operator disposition of a terminal ambiguous offer. This is
// not an admission receipt: retain the original event for manual review.
router.post('/threads/:threadId/wake-events/:sourceId/:eventId/hold', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.body?.confirmedNoReplay !== true || typeof req.body?.turnId !== 'string') {
    return res.status(400).json({ error: 'Exact turn and no-replay confirmation required.' });
  }
  try {
    await readyWakeSources();
    const event = await wakeSources.holdOffered(req.params.threadId, req.params.sourceId, req.params.eventId, req.body.turnId);
    return res.json({ eventId: event.eventId, status: event.status, turnId: event.turnId });
  } catch {
    return res.status(409).json({ error: 'Native custody cannot establish a terminal ambiguous offer.' });
  }
});

// An old unbound offer may predate later native turns. The operator must make
// an explicit no-replay decision against a fresh exact client ID and latest
// terminal native turn; no time-based automatic skipping or admission claim.
router.post('/threads/:threadId/wake-events/:sourceId/:eventId/hold-historical', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.body?.confirmedNoReplay !== true || typeof req.body?.expectedClientId !== 'string' ||
      typeof req.body?.expectedLatestTurnId !== 'string' || typeof req.body?.decisionRef !== 'string') {
    return res.status(400).json({ error: 'Exact native custody and audited no-replay decision required.' });
  }
  try {
    await readyWakeSources();
    const event = await wakeSources.holdHistoricalOffered(req.params.threadId, req.params.sourceId,
      req.params.eventId, req.body.expectedClientId, req.body.expectedLatestTurnId, req.body.decisionRef);
    return res.json({ eventId: event.eventId, status: event.status, turnId: event.turnId });
  } catch {
    return res.status(409).json({ error: 'Historical native custody cannot support a no-replay hold.' });
  }
});

router.get('/threads/:threadId/wake-sources', async (req: Request, res: Response) => {
  try { await readyWakeSources(); res.json(wakeSources.view(req.params.threadId)); }
  catch { res.status(503).json({ error: 'Wake sources unavailable.' }); }
});

// Outcome-return status only; summaries are never listed.
router.get('/outcome-returns', async (_req: Request, res: Response) => {
  try { await readyOutcomeReturns(); res.json({ entries: outcomeReturns.list() }); }
  catch { res.status(503).json({ error: 'Outcome returns unavailable.' }); }
});

router.put('/threads/:threadId/wake-sources/:sourceId', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
  try { await readyWakeSources(); }
  catch { return res.status(503).json({ error: 'Wake sources unavailable.' }); }
  const thread = await readInputThread(req.params.threadId);
  if ('error' in thread) return res.status(thread.error.status).json({ error: thread.error.message });
  try {
    const source = await wakeSources.put({ ...req.body, id: req.params.sourceId, threadId: req.params.threadId });
    res.json({ source });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid source.' }); }
});

router.get('/threads/:threadId/wake-sources/:sourceId/paused-command', async (req: Request, res: Response) => {
  if (!savedThreadIdentityReadAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
  try {
    await readyWakeSources();
    await getCodexService().readSavedThreadIdentity(req.params.threadId);
    return res.json(await wakeSources.pausedCommandMetadata(req.params.threadId, req.params.sourceId));
  } catch {
    return res.status(503).json({ error: 'Exact command source metadata unavailable.' });
  }
});

router.patch('/threads/:threadId/wake-sources/:sourceId/paused-command', async (req: Request, res: Response) => {
  if (!savedThreadIdentityReadAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
  try {
    await readyWakeSources();
    await getCodexService().readSavedThreadIdentity(req.params.threadId);
    const body = req.body;
    if (!body || Object.keys(body).sort().join(',') !== 'expectedArgvSha256,pathComponentFrom,pathComponentTo') {
      return res.status(400).json({ error: 'Expected command arguments required.' });
    }
    const source = await wakeSources.retargetPausedCommand(req.params.threadId, req.params.sourceId,
      body.expectedArgvSha256, body.pathComponentFrom, body.pathComponentTo);
    return res.json({ sourceId: source.id, threadId: source.threadId, paused: source.paused === true,
      status: source.status, sequence: source.sequence,
      argvSha256: createHash('sha256').update(JSON.stringify(source.argv)).digest('hex') });
  } catch (error) {
    return res.status(error instanceof PausedCommandConflictError ? 409 : 503)
      .json({ error: error instanceof PausedCommandConflictError
        ? 'Paused command precondition rejected.' : 'Paused command outcome unavailable; inspect custody before retry.' });
  }
});

for (const action of ['pause', 'resume'] as const) {
  router.post(`/threads/:threadId/wake-sources/:sourceId/${action}`, async (req: Request, res: Response) => {
    if (!wakeMutationAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
    try { await readyWakeSources(); }
    catch { return res.status(503).json({ error: 'Wake sources unavailable.' }); }
    const thread = await readInputThread(req.params.threadId);
    if ('error' in thread) return res.status(thread.error.status).json({ error: thread.error.message });
    try {
      if (action === 'pause') {
        return res.json(await wakeSources.pause(req.params.threadId, req.params.sourceId));
      }
      return res.json({ source: await wakeSources.resume(req.params.threadId, req.params.sourceId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid source.';
      res.status(message.startsWith('Wake source drain') ? 409 : 400).json({ error: message });
    }
  });
}

router.delete('/threads/:threadId/wake-sources/:sourceId', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
  try { await readyWakeSources(); await wakeSources.cancel(req.params.threadId, req.params.sourceId); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid source.' }); }
});

function isAgentTaskMode(value: unknown): value is AgentTaskMode {
  return value === 'headed' || value === 'headless';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseProgrammaticTaskDefaultProfileConfig(
  value: unknown,
): ProgrammaticTaskDefaultProfileConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const provider = value.provider;
  const modelId = value.modelId;
  if (
    (provider !== 'hosted'
      && provider !== 'local'
      && provider !== 'openai-oauth'
      && provider !== 'agent'
      && provider !== 'api'
      && provider !== 'terminal')
    || typeof modelId !== 'string'
  ) {
    return undefined;
  }

  const apiFormat =
    value.apiFormat === 'openai' || value.apiFormat === 'anthropic'
      ? value.apiFormat
      : undefined;
  const wireApi =
    value.wireApi === 'responses' || value.wireApi === 'chat'
      ? value.wireApi
      : undefined;

  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    provider,
    modelId,
    providerId: typeof value.providerId === 'string' ? value.providerId : undefined,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : undefined,
    environmentKey:
      typeof value.environmentKey === 'string'
      && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.environmentKey.trim())
        ? value.environmentKey.trim()
        : undefined,
    baseURL: typeof value.baseURL === 'string' ? value.baseURL : undefined,
    apiFormat,
    wireApi,
    codexProfileId: typeof value.codexProfileId === 'string' ? value.codexProfileId : undefined,
    useResponsesApi: typeof value.useResponsesApi === 'boolean' ? value.useResponsesApi : undefined,
    reasoningEffort: isReasoningEffort(value.reasoningEffort) ? value.reasoningEffort : undefined,
  };
}

function pathsEqualForAgentWorkspace(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  return path.resolve(a) === path.resolve(b);
}

function resolveStreamWorkspacePathForAgentRequest(request: NormalizedStreamRequest): string | null {
  const requestedWorkspacePath = request.workspacePath ?? getCurrentWorkspace();
  if (!request.callerToken) {
    return requestedWorkspacePath;
  }

  const binding = agentTabManager.getBindingForCallerToken(request.callerToken);
  if (!binding?.workspacePath) {
    return requestedWorkspacePath;
  }

  if (
    request.agentId
    && binding.agentId !== request.agentId
  ) {
    throw new Error(`Caller token is bound to agent '${binding.agentId}', not '${request.agentId}'.`);
  }

  if (
    request.workspacePath
    && !pathsEqualForAgentWorkspace(binding.workspacePath, request.workspacePath)
  ) {
    console.warn('[Agent API] Ignoring stream workspacePath that conflicts with caller token binding.', {
      agentId: request.agentId ?? null,
      boundWorkspacePath: binding.workspacePath,
      requestedWorkspacePath: request.workspacePath,
    });
  }

  return binding.workspacePath;
}

const FRESH_THREAD_REQUIRED_MESSAGE = 'This chat needs a fresh thread. Codex failed while replaying earlier reasoning history. Start a new chat, or use "Start new chat with history".';

function isLmStudioProviderId(provider: string | null): boolean {
  return provider === 'lmstudio' || provider?.startsWith('lmstudio-') === true;
}

// Global cache for tool call args - keyed by agentId, stores array of {toolCallId, toolName, args}
// This is needed because Claude/ACP doesn't stream tool-input events properly
export const toolArgsCache: Map<string, Array<{ toolCallId: string; toolName: string; args: any }>> = new Map();

// MESSAGE QUEUE ROUTES

// Add message to queue
router.post("/queue", (req: Request, res: Response) => {
  const { agentId, message } = req.body;

  if (!agentId || !message) {
    return res.status(400).json({ error: 'agentId and message required' });
  }

  messageQueueStore.add(agentId, message);

  res.json({
    success: true,
    text: messageQueueStore.peek(agentId),
  });
});

router.post('/tasks', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (getProgrammaticClientIdError(body.clientUserMessageId)) {
    return res.status(400).json({ success: false, error: 'Invalid clientUserMessageId.' });
  }
  const senderError = getProgrammaticSenderError(body);
  if (senderError) return res.status(400).json({ success: false, error: senderError });
  try {
    const task = parseProgrammaticTaskBody(body);
    const {
      message,
      system,
      timeoutMs,
      idleTimeoutMs,
      workspace,
      threadId,
      mode,
      modelConfig,
      model,
      reasoningEffort,
      runtimeConfig,
    } = task;

    if (!isAgentTaskMode(mode)) {
      return res.status(400).json({
        success: false,
        error: 'mode must be "headed" or "headless"',
      });
    }

    const transportError = getProgrammaticTaskHttpError({
      isElectronRuntime: Boolean(process.versions.electron),
      mode,
    });
    if (transportError) {
      return res.status(403).json({
        success: false,
        error: transportError,
      });
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required for headless tasks',
      });
    }

    const workspaceError = getProgrammaticTaskWorkspaceError(mode, workspace);
    if (workspaceError) {
      return res.status(400).json({
        success: false,
        error: workspaceError,
      });
    }

    // Input to an existing thread is retained and queued; it never waits for the turn.
    if (threadId) {
      const custody = await enqueueThreadInput(body, { ...task, threadId });
      if ('error' in custody) {
        return res.status(custody.error.status).json({ success: false, error: custody.error.message });
      }
      void wakeSources.tick().catch(console.error);
      const { event } = custody;
      return res.status(202).json({ threadId, clientUserMessageId: event.eventId, status: event.status,
        ...(event.refusal && { code: event.refusal.code, parentThreadId: event.refusal.parentThreadId }) });
    }

    await applyProgrammaticTaskRuntimeConfigFromBody(runtimeConfig);
    const resolvedModelConfig = await resolveAgentModelConfig(modelConfig, {
      modelId: model,
      reasoningEffort,
    });

    const result = await startAgentTask({
      mode: 'headless',
      message,
      system,
      timeoutMs,
      idleTimeoutMs,
      workspace,
      modelConfig: resolvedModelConfig,
      notifyStarted: true,
    });

    return res.json({
      success: result.completed,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

router.post('/tasks/stream', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (getProgrammaticClientIdError(body.clientUserMessageId)) {
    return res.status(400).json({ error: 'Invalid clientUserMessageId.' });
  }
  const senderError = getProgrammaticSenderError(body);
  if (senderError) return res.status(400).json({ error: senderError });
  const task = parseProgrammaticTaskBody(body);
  const {
    message,
    system,
    timeoutMs,
    idleTimeoutMs,
    workspace,
    threadId,
    clientUserMessageId,
    mode,
    modelConfig,
    model,
    reasoningEffort,
    runtimeConfig,
  } = task;

  if (!isAgentTaskMode(mode)) {
    return res.status(400).json({
      error: 'mode must be "headed" or "headless"',
    });
  }

  const transportError = getProgrammaticTaskHttpError({
    isElectronRuntime: Boolean(process.versions.electron),
    mode,
  });
  if (transportError) {
    return res.status(403).json({
      error: transportError,
    });
  }

  if (!message) {
    return res.status(400).json({
      error: 'message is required for headless streaming tasks',
    });
  }

  const workspaceError = getProgrammaticTaskWorkspaceError(mode, workspace);
  if (workspaceError) {
    return res.status(400).json({
      error: workspaceError,
    });
  }

  // Input to an existing thread is retained and queued; the stream observes it.
  if (threadId) {
    const custody = await enqueueThreadInput(body, { ...task, threadId });
    if ('error' in custody) return res.status(custody.error.status).json({ error: custody.error.message });
    return streamThreadInput(res, custody.event);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let streamClosed = false;
  let observedTurn = false;
  res.on('close', () => {
    streamClosed = true;
  });

  const emit = (event: string, payload: unknown) => {
    if (streamClosed) return;
    const wrote = writeCodexSse(res, event, payload);
    if (!wrote) {
      streamClosed = true;
    }
  };

  try {
    await applyProgrammaticTaskRuntimeConfigFromBody(runtimeConfig);
    const resolvedModelConfig = await resolveAgentModelConfig(modelConfig, {
      modelId: model,
      reasoningEffort,
    });

    const result = await startAgentTask({
      mode: 'headless',
      message,
      system,
      timeoutMs,
      idleTimeoutMs,
      workspace,
      modelConfig: resolvedModelConfig,
      clientUserMessageId,
      notifyStarted: true,
      onProgress: (progress) => {
        if (progress.kind === 'turn') observedTurn = true;
        for (const event of toProgrammaticTaskProgressSseEvents(progress)) {
          emit(event.event, event.payload);
        }
      },
    });

    const refusal = !observedTurn ? result.refusal : undefined;
    emit('result', result);
    if (refusal) emit('error', { message: result.error, ...subagentRefusalFields(refusal) });
    else {
      const unacknowledged = getUnacknowledgedTaskError(result, observedTurn);
      if (unacknowledged) emit('error', unacknowledged);
    }
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!observedTurn && error instanceof SubagentDirectInputError) {
      emit('error', { message, ...subagentRefusalFields(error) });
    } else emit('error', { message });
    res.end();
  }
});

/** How long a thread-targeted task stream observes its input before reporting
 * it as still queued. The input stays retained either way. */
export const threadInputTiming = { admissionWaitMs: 90_000 };

/** Per-request task settings that cannot apply to input queued for an existing thread. */
const THREAD_INPUT_REJECTED_FIELDS = ['model', 'reasoningEffort', 'modelConfig', 'runtimeConfig', 'system',
  'timeoutMs', 'idleTimeoutMs'] as const;

type ThreadInputError = { error: { status: number; message: string } };

/**
 * Take durable custody of programmatic input to an existing thread. All such
 * input goes through the thread's one wake queue: retained before any
 * acknowledgement, delivered in order with schedules, commands and channel
 * input, steering an active turn or starting an idle one, and recovered after
 * a restart. The client message ID is the event ID, so a repeat returns the
 * stored event instead of submitting again.
 */
async function enqueueThreadInput(
  body: Record<string, unknown>,
  task: ReturnType<typeof parseProgrammaticTaskBody> & { threadId: string },
): Promise<ThreadInputError | { event: WakeEvent }> {
  const fail = (status: number, message: string): ThreadInputError => ({ error: { status, message } });
  const rejected = THREAD_INPUT_REJECTED_FIELDS.find(key => body[key] !== undefined && body[key] !== null);
  if (rejected) return fail(400, `${rejected} cannot be set for input to an existing thread.`);
  if (!isWakeId(task.threadId)) return fail(400, 'Invalid threadId.');
  if (!task.clientUserMessageId) return fail(400, 'clientUserMessageId is required for input to an existing thread.');
  // The receiving thread sees who handed it this work; the body is unchanged.
  const message = withSenderHeader(task.sender, task.message);
  if (message.length > WAKE_MESSAGE_LIMIT) {
    return fail(400, `message is longer than ${WAKE_MESSAGE_LIMIT} characters (including any sender line).`);
  }
  try { await readyWakeSources(); }
  catch { return fail(503, 'Thread input is unavailable; nothing was accepted.'); }
  // A repeat of a stored ID is answered from the stored input, before any
  // thread read or workspace check, so it works while the runtime is down.
  // While a state write is outstanding or failed it is not answered here: it
  // goes through ingestion below, which writes before it acknowledges.
  try {
    const stored = wakeSources.storedInput(task.threadId, THREAD_INPUT_SOURCE, task.clientUserMessageId,
      message, task.sender);
    if (stored) return { event: stored };
  } catch (error) {
    if (error instanceof WakeContentConflictError) return fail(409, 'Client ID already used for different input.');
    return fail(400, 'Invalid thread input.');
  }
  const read = await readInputThread(task.threadId);
  if ('error' in read) return fail(read.error.status, read.error.message);
  if (!pathsEqualForAgentWorkspace(read.thread.cwd, task.workspace)) {
    return fail(400, 'workspace does not match the thread workspace.');
  }
  try {
    return { event: await wakeSources.ingest(task.threadId, THREAD_INPUT_SOURCE, task.clientUserMessageId,
      message, task.sender) };
  } catch (error) {
    const failure = wakeIngestFailure(error);
    return fail(failure.status, failure.status === 409 ? failure.message
      : failure.status === 400 ? 'Invalid thread input.'
      : error instanceof WakeUnsavedError ? 'Thread input could not be saved; retry with the same clientUserMessageId.'
      : 'Thread input could not be retained; nothing was accepted.');
  }
}

/** Server-Sent Events for one retained thread input: `submission` at once,
 * `accepted` once the runtime has taken it into a turn, then its admission
 * (`thread`, `turn`, `admitted`), its refusal (`error`), `held`, or, when it
 * is not settled within the wait, `queued`. A client that disconnects changes
 * nothing; the input remains queued, and no waiter outlives the connection.
 * Exported for tests. */
export async function streamThreadInput(res: Response, event: WakeEvent): Promise<void> {
  const { threadId, eventId: clientUserMessageId } = event;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const observer = new AbortController();
  let closed = false;
  const close = () => { closed = true; observer.abort(); };
  res.on('close', close);
  // A client that disconnected while the input was being retained has
  // already fired 'close'; a failed write means the same.
  if (res.destroyed || res.writableEnded) close();
  const emit = (name: string, payload: unknown) => {
    if (!closed && !writeCodexSse(res, name, payload)) close();
  };
  void wakeSources.tick().catch(console.error);
  emit('submission', { threadId, clientUserMessageId, status: event.status });
  if (closed) return;
  const deadline = Date.now() + threadInputTiming.admissionWaitMs;
  let current = await wakeSources.whenAccepted(threadId, THREAD_INPUT_SOURCE, clientUserMessageId,
    threadInputTiming.admissionWaitMs, observer.signal) ?? event;
  if (closed) return;
  // `accepted` always precedes `admitted` when a turn is known, also when the
  // receipt was observed before the acceptance could be reported.
  if (current.turnId && (isAcceptedOffer(current) || current.status === 'admitted')) {
    emit('accepted', { threadId, turnId: current.turnId, clientUserMessageId });
  }
  if (isAcceptedOffer(current)) {
    current = await wakeSources.whenSettled(threadId, THREAD_INPUT_SOURCE, clientUserMessageId,
      Math.max(0, deadline - Date.now()), observer.signal) ?? current;
    if (closed) return;
  }
  if (current.status === 'admitted') {
    emit('thread', { threadId });
    // The turn holding the receipt; its status is not known here, so none is claimed.
    if (current.turnId) emit('turn', { threadId, turnId: current.turnId });
    emit('admitted', { threadId, turnId: current.turnId ?? null, clientUserMessageId });
  } else if (current.status === 'refused' && current.refusal) {
    const refusal = new SubagentDirectInputError(threadId, current.refusal.parentThreadId);
    emit('error', { message: refusal.message, ...subagentRefusalFields(refusal) });
  } else if (current.status === 'held') {
    emit('held', { threadId, clientUserMessageId, status: current.status });
  } else {
    emit('queued', { threadId, clientUserMessageId, status: current.status });
  }
  res.end(); // An admitted turn continues after the observer disconnects.
}

// Operator-only custody of one thread input: status and turn, never its text.
router.get('/threads/:threadId/submissions/:clientUserMessageId/custody', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { threadId, clientUserMessageId } = req.params;
  // The same thread and client ID checks as the enqueue path.
  if (!isWakeId(threadId) || !isWakeId(clientUserMessageId)) {
    return res.status(400).json({ error: 'Invalid submission scope.' });
  }
  try { await readyWakeSources(); }
  catch { return res.status(503).json({ error: 'Thread input custody unavailable.' }); }
  const event = wakeSources.find(threadId, THREAD_INPUT_SOURCE, clientUserMessageId);
  if (!event) return res.status(404).json({ error: 'Submission not found.', threadId, clientUserMessageId });
  return res.json({ threadId, clientUserMessageId, ...threadInputCustody(event) });
});

/** Fixed, content-free fields of a sub-agent input refusal. The parent thread
 * ID lets the caller send the work to the thread that can take it. */
function subagentRefusalFields(refusal: SubagentInputRefusal) {
  return { code: refusal.code, threadId: refusal.threadId, parentThreadId: refusal.parentThreadId };
}

/** A terminal result is not an admission receipt unless a native turn was observed. */
export function getUnacknowledgedTaskError(
  result: AgentTaskResult,
  observedTurn: boolean,
): { code: 'turn_not_acknowledged'; message: string } | null {
  if (observedTurn) return null;
  return {
    code: 'turn_not_acknowledged',
    message: result.error?.trim() || 'Agent task ended without a native turn acknowledgement.',
  };
}

// Get queue status (for UI display)
router.get("/queue/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;
  const text = messageQueueStore.peek(agentId);

  res.json({
    agentId,
    text,
    hasQueue: text !== null,
  });
});

// Clear queue (user cancelled)
router.delete("/queue/:agentId", (req: Request, res: Response) => {
  const { agentId } = req.params;
  messageQueueStore.clear(agentId);

  res.json({ success: true });
});

// Cleanup endpoint - called when agent tab closes
router.delete('/session/:agentId', (req, res) => {
  const { agentId } = req.params;
  cleanupACPProvider(agentId); // Synchronous - just removes from Map and calls cleanup()
  res.json({ success: true });
});

// STOP endpoint - called when user clicks stop button
// This is the EXPLICIT channel for stopping agents, not connection close detection
router.post('/stop/:agentId', async (req, res) => {
  const { agentId } = req.params;
  console.log(`[Agent API] STOP request received for agent: ${agentId}`);

  try {
    // Stop this agent AND all nested subagents
    // This calls onStop callbacks for any runtime-owned subprocess cleanup.
    await stopAgentAndDescendants(agentId);
    console.log(`[Agent API] Successfully stopped agent ${agentId} and all descendants`);
    res.json({ success: true, message: 'Agent and all subagents stopped' });
  } catch (error) {
    console.error(`[Agent API] Error stopping agent ${agentId}:`, error);
    res.json({ success: true, message: 'Stop attempted (agent may have already finished)' });
  }
});

function writeCodexSse(
  res: Response,
  event: string,
  payload: unknown,
): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

const PROGRAMMATIC_TASK_HTTP_IN_ELECTRON_ERROR =
  'Programmatic task HTTP is disabled in the Electron app. Use IPC for in-app headed tasks, or use the standalone headless server for HTTP task execution.';

const HEADED_TASK_HTTP_ERROR =
  'Headed programmatic tasks are only available via IPC. Use the standalone headless server for headless HTTP execution.';

export function getProgrammaticTaskHttpError(params: {
  isElectronRuntime: boolean;
  mode: AgentTaskMode;
}): string | null {
  if (params.isElectronRuntime) {
    return PROGRAMMATIC_TASK_HTTP_IN_ELECTRON_ERROR;
  }

  if (params.mode === 'headed') {
    return HEADED_TASK_HTTP_ERROR;
  }

  return null;
}

export function toProgrammaticTaskProgressSseEvents(
  progress: AgentTaskProgressEvent,
): Array<{ event: string; payload: unknown }> {
  if (progress.kind === 'thread') {
    return [{ event: 'thread', payload: { threadId: progress.threadId } }];
  }

  if (progress.kind === 'turn') {
    return [{
      event: 'turn',
      payload: {
        threadId: progress.threadId,
        turnId: progress.turnId,
        status: progress.status,
      },
    }];
  }

  return [{
    event: progress.event.event,
    payload: progress.event.payload,
  }];
}

export function createAgentStreamErrorPayload(
  message: string,
  additionalDetails: string | null,
): Extract<UiStreamEvent, { event: 'error' }>['payload'] {
  return {
    errorInfo: {
      kind: 'raw',
      text: message,
    },
    additionalDetails,
  };
}

async function applyProgrammaticTaskRuntimeConfigFromBody(
  runtimeConfig: Record<string, unknown> | undefined,
): Promise<void> {
  if (!runtimeConfig) {
    return;
  }

  const defaultProfile = parseProgrammaticTaskDefaultProfileConfig(runtimeConfig.defaultProfile);

  await applyProgrammaticTaskRuntimeConfig({
    codexApprovalPolicy:
      runtimeConfig.codexApprovalPolicy === 'never'
      || runtimeConfig.codexApprovalPolicy === 'on-failure'
      || runtimeConfig.codexApprovalPolicy === 'on-request'
      || runtimeConfig.codexApprovalPolicy === 'untrusted'
        ? runtimeConfig.codexApprovalPolicy
        : undefined,
    codexSandboxMode:
      runtimeConfig.codexSandboxMode === 'read-only'
      || runtimeConfig.codexSandboxMode === 'workspace-write'
      || runtimeConfig.codexSandboxMode === 'danger-full-access'
        ? runtimeConfig.codexSandboxMode
        : undefined,
    codexNetworkAccess:
      typeof runtimeConfig.codexNetworkAccess === 'boolean'
        ? runtimeConfig.codexNetworkAccess
        : undefined,
    defaultProfile,
  });
}

export function parseProgrammaticTaskBody(body: Record<string, unknown>) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const system = typeof body.system === 'string' ? body.system : undefined;
  const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
  const idleTimeoutMs = typeof body.idleTimeoutMs === 'number' ? body.idleTimeoutMs : undefined;
  const workspace = normalizeHeadlessTaskWorkspace(
    typeof body.workspace === 'string' ? body.workspace : undefined,
  );
  const threadId = typeof body.threadId === 'string' && body.threadId.trim()
    ? body.threadId.trim()
    : undefined;
  const clientUserMessageId = typeof body.clientUserMessageId === 'string'
    ? body.clientUserMessageId : undefined;
  const sender = body.sender === undefined ? undefined : parseSubmissionSender(body.sender) ?? undefined;
  const mode = body.mode === undefined ? 'headless' : body.mode;
  const modelConfig = body.modelConfig && typeof body.modelConfig === 'object'
    ? body.modelConfig as AgentModelConfig
    : undefined;
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : undefined;
  const reasoningEffort = isReasoningEffort(body.reasoningEffort)
    ? body.reasoningEffort
    : undefined;
  const runtimeConfig = body.runtimeConfig && typeof body.runtimeConfig === 'object'
    ? body.runtimeConfig as Record<string, unknown>
    : undefined;

  return {
    message,
    system,
    timeoutMs,
    idleTimeoutMs,
    workspace,
    threadId,
    clientUserMessageId,
    sender,
    mode,
    modelConfig,
    model,
    reasoningEffort,
    runtimeConfig,
  };
}

/** A client message ID is a wake event ID, so it uses exactly that alphabet. */
export function getProgrammaticClientIdError(value: unknown): boolean {
  return value !== undefined && !isWakeId(value);
}

/** A sender is attribution for input to an existing thread; reject any other
 * shape before anything is retained. (Input to an existing thread always
 * carries a client message ID; the task routes require it.) */
export function getProgrammaticSenderError(body: Record<string, unknown>): string | null {
  if (body.sender === undefined) return null;
  if (!parseSubmissionSender(body.sender)) return 'Invalid sender.';
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
  if (!threadId) return 'sender requires threadId.';
  return null;
}

/** The exact text submitted to the native thread for a sender-attributed task. */
export function withSenderHeader(sender: SubmissionSender | undefined, message: string): string {
  return sender ? `${senderHeader(sender)}\n${message}` : message;
}
function toGroqProxyBaseUrl(): string {
  return `http://localhost:${getServerPort()}/api/agent/groq-proxy`;
}

function routeGroqThroughProxy(profile: CodexProfile): CodexProfile {
  if (profile.modelProvider !== 'groq' || !profile.providerConfig) {
    return profile;
  }

  return {
    ...profile,
    providerConfig: {
      ...profile.providerConfig,
      base_url: toGroqProxyBaseUrl(),
    },
  };
}

export function getAgentServiceTierConfig(
  agentId?: string,
): Record<string, JsonValue> | undefined {
  return agentId === 'simple-primary-agent'
    ? { service_tier: 'fast' }
    : undefined;
}

router.get('/threads', async (req: Request, res: Response) => {
  try {
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) {
      return res.status(400).json({ error: 'Invalid pagination cursor.' });
    }
    const result = await getCodexService().listThreads({
      ...THREAD_LIST_DEFAULTS,
      archived,
      ...(cursor ? { cursor } : {}),
    });
    res.json(result);
  } catch (error) {
    const category = error instanceof NativeCustodyPhaseError ? error.category : 'native_unavailable';
    console.warn('[Agent API] Native thread list unavailable.', category);
    return res.status(503).json({
      error: 'Native thread list unavailable.',
      phase: 'thread_list',
      category,
      available: false,
    });
  }
});

router.post('/threads/:threadId/resume', async (req: Request, res: Response) => {
  const threadId = req.params.threadId.trim();
  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required.' });
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspace = normalizeHeadlessTaskWorkspace(
      typeof body.workspace === 'string' ? body.workspace : undefined,
    );
    const workspaceError = getProgrammaticTaskWorkspaceError('headless', workspace);
    if (workspaceError) {
      return res.status(400).json({ error: workspaceError });
    }
    const runtimeConfig = isRecord(body.runtimeConfig) ? body.runtimeConfig : undefined;
    const modelConfig = body.modelConfig && typeof body.modelConfig === 'object'
      ? body.modelConfig as AgentModelConfig
      : undefined;

    await applyProgrammaticTaskRuntimeConfigFromBody(runtimeConfig);
    const result = await resumeAgentTaskThread({
      threadId,
      workspace,
      modelConfig,
    });
    return res.json({ resumed: true, ...result });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to resume thread.',
    });
  }
});

// A saved native thread may acquire a new CLI carrier only while cold. This
// does not start a user turn or dispose any durable wake event.
router.post('/threads/:threadId/caller/cold-bind', async (req: Request, res: Response) => {
  if (!wakeMutationAllowed(req) ||
      !wakeTokenValid(process.env.WORKSTATION_WAKE_TOKEN, req.header('authorization')?.replace(/^Bearer /i, ''))) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const threadId = req.params.threadId;
  const workspace = req.body?.workspace;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId) ||
      typeof workspace !== 'string') return res.status(400).json({ error: 'Exact thread and workspace required.' });
  try {
    await readyWakeSources();
    const appQueues = messageQueueStore.getCustodyInventory();
    const tabs = agentTabManager.getGlobalCustodyInventory();
    const events = wakeSources.list(threadId).events;
    if (appQueues.count || tabs.pendingRequestIds.length || tabs.pendingStartupIds.length ||
        tabs.createdRequestIds.length || approvalManager.getGlobalPendingRequestIds().length ||
        events.some(event => event.status === 'pending' || event.status === 'offered')) {
      return res.status(409).json({ error: 'In-process or durable input custody is not idle.' });
    }
    return res.json(await coldBindAgentTaskThread({ threadId, workspace }));
  } catch {
    return res.status(409).json({ error: 'Cold caller custody or native resume failed; no turn was submitted.' });
  }
});

router.post('/threads/:threadId/fork', async (req: Request, res: Response) => {
  const threadId = req.params.threadId.trim();
  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required.' });
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lastTurnId = typeof body.lastTurnId === 'string'
      ? body.lastTurnId.trim()
      : '';
    if (!lastTurnId) {
      return res.status(400).json({ error: 'lastTurnId is required.' });
    }
    const workspace = normalizeHeadlessTaskWorkspace(
      typeof body.workspace === 'string' ? body.workspace : undefined,
    );
    const workspaceError = getProgrammaticTaskWorkspaceError('headless', workspace);
    if (workspaceError) {
      return res.status(400).json({ error: workspaceError });
    }
    const runtimeConfig = isRecord(body.runtimeConfig) ? body.runtimeConfig : undefined;
    const modelConfig = body.modelConfig && typeof body.modelConfig === 'object'
      ? body.modelConfig as AgentModelConfig
      : undefined;

    await applyProgrammaticTaskRuntimeConfigFromBody(runtimeConfig);
    const result = await forkAgentTaskThread({
      threadId,
      lastTurnId,
      workspace,
      modelConfig,
    });
    return res.json({ forked: true, sourceThreadId: threadId, ...result });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fork thread.',
    });
  }
});

/** Metadata-only exact binding for authenticated/local saved-thread sends.
 * No transcript, queue observation, or application active/idle gate. */
router.get('/threads/:threadId/identity', async (req: Request, res: Response) => {
  if (!savedThreadIdentityReadAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
  const threadId = req.params.threadId;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(threadId)) {
    return res.status(400).json({ error: 'Exact native thread ID required.' });
  }
  try {
    return res.json(await getCodexService().readSavedThreadIdentity(threadId));
  } catch (error) {
    return res.status(error instanceof SavedThreadIdentityError ? 404 : 503)
      .json({ error: 'Exact saved-thread identity unavailable.' });
  }
});

router.get('/threads/:threadId', async (req: Request, res: Response) => {
  const limit = parseThreadHistoryLimit(req.query.limit);
  const before = req.query.before;
  if (before !== undefined && !isThreadHistoryCursor(before)) {
    res.status(400).json({ error: 'Invalid history cursor.' });
    return;
  }
  try {
    if (limit === null) {
      const thread = await getCodexService().readThread(req.params.threadId);
      // Saved tool source and older reasoning are restored for the newest
      // turns only, as far back as the fixed read budget reaches.
      const { thread: enriched } = await enrichThreadTurnsFromRollout(thread, { partial: true });
      res.json({ thread: enriched });
      return;
    }

    // A page costs one bounded native read regardless of how long the
    // conversation is; `before` is the runtime's opaque cursor.
    const page = await getCodexService().readThreadPage(req.params.threadId, { limit, cursor: before });
    // Restores saved tool source and older reasoning for this page by reading
    // only the end of the saved history, within a fixed budget. The passive
    // refresh poll repeats every few seconds, and a single turn can itself be
    // very long, so it gets a much smaller budget and keeps whatever newest
    // turns that budget covers.
    const passiveRefresh = req.query.bestEffort === '1' || req.query.bestEffort === 'true';
    const { thread: pageThread } = await enrichThreadTurnsFromRollout(
      page.thread,
      passiveRefresh ? { byteBudget: PASSIVE_REFRESH_ROLLOUT_BYTE_BUDGET, partial: true } : undefined,
    );
    res.json({
      thread: pageThread,
      historyPage: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    });
  } catch (error) {
    if (req.query.bestEffort === '1' || req.query.bestEffort === 'true') {
      // A resumed conversation polls while runtimes and profiles may be
      // restarting. Treat that passive refresh as optional: the already
      // rendered transcript remains authoritative and a later poll retries.
      // Interactive/initial reads deliberately retain their normal 500.
      console.warn(
        '[Agent API] Best-effort thread refresh unavailable; keeping existing history.',
        error instanceof Error ? error.message : error,
      );
      res.json({ thread: null, available: false });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read thread.',
    });
  }
});

router.put('/threads/:threadId/name', async (req: Request, res: Response) => {
  const threadId = req.params.threadId.trim();
  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required.' });
  }

  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!name.trim()) {
    return res.status(400).json({ error: 'name is required.' });
  }
  if (name.trim().length > 200) {
    return res.status(400).json({ error: 'name must be 200 characters or fewer.' });
  }

  try {
    return res.json(await renameThread(threadId, name));
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to rename thread.',
    });
  }
});

/** An exact native CAS identity for the existing authenticated loopback
 * operator path. A legacy /goal read must never be promoted to a revision. */
router.get('/threads/:threadId/goal/revision', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!savedThreadIdentityReadAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(req.params.threadId))
    return res.status(400).json({ error: 'Exact native thread ID required.' });
  try {
    return res.json(await getCodexService().getThreadGoalWithRevision(req.params.threadId));
  } catch {
    return res.status(503).json({ error: 'Native Goal revision unavailable.' });
  }
});

router.get('/threads/:threadId/goal', async (req: Request, res: Response) => {
  try {
    const goal = await getCodexService().getThreadGoal(req.params.threadId);
    res.json({ goal });
  } catch (error) {
    // Goals are an optional OIX capability. Older or deterministic test
    // backends may not implement the RPC yet; keep ordinary thread viewing
    // compatible while leaving goal mutations explicit and fail-closed.
    console.warn(
      '[Agent API] Goal read unavailable; returning no goal.',
      error instanceof Error ? error.message : error,
    );
    res.json({ goal: null, available: false });
  }
});

router.put('/threads/:threadId/goal', async (req: Request, res: Response) => {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'expected')) {
    res.setHeader('Cache-Control', 'no-store');
    if (!savedThreadIdentityReadAllowed(req)) return res.status(403).json({ error: 'Local same-origin request required.' });
    const expected = req.body.expected as ThreadGoalRevision;
    const status = req.body.status;
    try {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(req.params.threadId) ||
          Object.keys(req.body).sort().join() !== 'expected,status' ||
          !expected || typeof expected !== 'object' || Array.isArray(expected) ||
          Object.keys(expected).sort().join() !== 'goalId,lifecycleRevision,missionRevision,status' ||
          !((expected.status === 'paused' || expected.status === 'blocked') && status === 'active' ||
            expected.status === 'active' && (status === 'paused' || status === 'blocked'))) {
        return res.status(400).json({ error: 'Exact native Goal transition required.' });
      }
      goalCasExpectedParams(expected);
    } catch {
      return res.status(400).json({ error: 'Exact native Goal revision required.' });
    }
    try {
      const service = getCodexService();
      // A resume also makes sure a live thread owns the active Goal.
      const result = status === 'active'
        ? await service.resumeThreadGoalWithRevision(req.params.threadId, expected)
        : await service.setThreadGoalWithRevision(req.params.threadId, expected, { status });
      return res.json(result);
    } catch (error) {
      return res.status(error instanceof GoalRevisionConflictError ? 409 : 503)
        .json({ error: error instanceof GoalRevisionConflictError ?
          'Native Goal revision changed.' : 'Native Goal mutation unconfirmed.' });
    }
  }
  const objective = typeof req.body?.objective === 'string'
    ? req.body.objective.trim()
    : undefined;
  const status = req.body?.status;
  const allowedStatuses: v2.ThreadGoalStatus[] = [
    'active',
    'paused',
    'blocked',
    'usageLimited',
    'budgetLimited',
    'complete',
  ];

  if (objective !== undefined && objective.length === 0) {
    return res.status(400).json({ error: 'Goal objective cannot be empty.' });
  }
  if (status !== undefined && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid goal status.' });
  }
  if (objective === undefined && status === undefined && !('tokenBudget' in (req.body ?? {}))) {
    return res.status(400).json({ error: 'Goal objective, status, or tokenBudget is required.' });
  }

  const tokenBudget = req.body?.tokenBudget;
  if (
    tokenBudget !== undefined
    && tokenBudget !== null
    && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
  ) {
    return res.status(400).json({ error: 'tokenBudget must be a positive integer or null.' });
  }

  try {
    const goal = await getCodexService().setThreadGoal(req.params.threadId, {
      ...(objective !== undefined ? { objective } : {}),
      ...(status !== undefined ? { status } : {}),
      ...('tokenBudget' in (req.body ?? {}) ? { tokenBudget } : {}),
    });
    return res.json({ goal });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update thread goal.',
    });
  }
});

router.delete('/threads/:threadId/goal', async (req: Request, res: Response) => {
  try {
    const cleared = await getCodexService().clearThreadGoal(req.params.threadId);
    res.json({ cleared });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to clear thread goal.',
    });
  }
});

router.all('/groq-proxy/*', async (req: Request, res: Response) => {
  const suffix = req.params[0];
  const targetPath = suffix ? `/${suffix}` : '';
  const targetUrl = `https://api.groq.com/openai/v1${targetPath}`;

  const incomingHeaders = req.headers as Record<string, string | string[] | undefined>;
  const outboundHeaders = new Headers();
  for (const [key, rawValue] of Object.entries(incomingHeaders)) {
    if (!rawValue) continue;
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length') continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
    outboundHeaders.set(key, value);
  }

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const rawBody = hasBody ? req.body : undefined;
  const bodyForGroq =
    targetPath === '/responses'
      ? sanitizeGroqResponsesRequest(rawBody)
      : rawBody;

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: outboundHeaders,
      body: hasBody ? JSON.stringify(bodyForGroq ?? {}) : undefined,
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'content-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Groq proxy failed',
    });
  }
});

router.post('/chat/stream', async (req: Request, res: Response) => {
  let body: StreamRequestBody;
  let request: NormalizedStreamRequest;
  let activeProfileProvider: string | null = null;
  let activeModelId: string | null = null;
  const streamStartedAt = Date.now();

  if (!validateStreamRequestBody(req.body)) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }
  body = req.body;
  request = normalizeStreamRequestBody(body);
  console.log(
    `[AGENT] turn_start selection=${request.selection} profileId=${request.selection === 'stored-profile' ? request.profileId : 'none'} agentId=${request.agentId ?? 'none'} threadId=${request.threadId ?? 'new'} model=${request.model ?? 'default'} attachmentCount=${request.attachments.length} skillCount=${request.skills.length}`,
  );

  const rawMessage = request.message?.trim();
  const attachments = request.attachments;
  const explicitSkills = request.skills;
  if (!rawMessage && attachments.length === 0 && explicitSkills.length === 0) {
    return res.status(400).json({ error: 'Message, skill, or attachment is required.' });
  }

  const abortController = new AbortController();
  let streamClosed = false;
  let turnMessageId: string | null = null;
  let activeThreadId: string | undefined = request.threadId ?? undefined;
  const runningAgentId = `chat:${request.agentId ?? 'stream'}:${randomUUID()}`;
  let targetThreadId: string | undefined = request.threadId ?? undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.on('close', () => {
    // The renderer is an observer of the turn, not its owner. Closing a tab,
    // reloading the window, or losing the network connection must not interrupt
    // work that OIX is already performing. Explicit stop requests still abort
    // through /chat/stop and the running-agent registry.
    streamClosed = true;
  });

  const emit = (event: string, payload: unknown) => {
    if (streamClosed) return;
    const wrote = writeCodexSse(res, event, payload);
    if (!wrote) {
      streamClosed = true;
    }
  };

  registerRunningAgent(runningAgentId, abortController, null, async () => {
    if (!activeThreadId) {
      return;
    }
    await getCodexService().interrupt(activeThreadId, turnMessageId ?? undefined);
  });

  try {
    const resolvedRequest = await resolveCodexProfileForStreamRequest(request);
    const workspacePath = requireExistingWorkspacePath(
      resolveStreamWorkspacePathForAgentRequest(request),
    );
    const service = getCodexService();
    const simpleProject = request.agentId === 'simple-primary-agent'
      ? await getActiveSimpleProject()
      : null;
    const agentWorkspacePath = simpleProject?.path ?? workspacePath;
    const simpleProjectInstruction = simpleProject
      ? `Simple mode's active project is ${simpleProject.path}; it is the working directory and the interface to edit. The control workspace is ${workspacePath} and is a second writable root. Read the active project's AGENTS.md and then read .interpreter/skills/interface-design/SKILL.md completely before changing visible React UI. This is ordinary Next.js project development: use native shell and filesystem commands, source editing, and the package manager for files, dependencies, builds, and assets. Do not search Interpreter app tools for ordinary coding or filesystem work. Use the maintained @interpreter/interface and @interpreter/motion capabilities described there. Update the existing interface in place, compile it, inspect diagnostics, preserve user state, and preserve the last good build. Never create an interface inside the control workspace. Preserve the ingress channel: desktop requests may use the visible interface; GPT Live requests must reply in voice.`
      : null;
    if (targetThreadId) {
      try {
        // Only the latest turn decides whether the thread can be resumed.
        const { thread: existingThread } = await service.readThreadPage(targetThreadId, { limit: 1 });
        if (requiresFreshThread(existingThread)) {
          console.warn('[Agent API] Blocking resume of known-bad Codex thread.', {
            threadId: existingThread.id,
            modelProvider: existingThread.modelProvider,
            status: existingThread.status.type,
          });
          throw new Error(FRESH_THREAD_REQUIRED_MESSAGE);
        }
      } catch (error) {
        if (error instanceof Error && error.message === FRESH_THREAD_REQUIRED_MESSAGE) {
          throw error;
        }
        // The next native resume reports the precise failure. Never replace a
        // supplied saved-thread ID with a new chat merely because preflight
        // could not read it; durable inputs belong to that same thread.
        console.warn('[Agent API] Existing thread preflight unavailable; retaining thread identity.',
          error instanceof Error ? error.message : error);
      }
    }

    const bindingModelConfig = await resolveAgentModelConfigForStreamRequest(request);
    activeThreadId = targetThreadId;
    activeProfileProvider = resolvedRequest.profile.modelProvider;
    const turnErrorContext = {
      isChatGptProfile: resolvedRequest.isChatGptProfile,
      modelId: resolvedRequest.requestedModel ?? resolvedRequest.profile.model,
      modelProvider: resolvedRequest.profile.modelProvider,
      providerLabel: resolvedRequest.profile.label,
    };
    await ensureOpenAIOAuthAccountReady(service, resolvedRequest.isChatGptProfile);
    console.log(
      `[AGENT] runtime_resolved selection=${request.selection} profileId=${request.selection === 'stored-profile' ? request.profileId : 'none'} agentId=${request.agentId ?? 'none'} threadId=${targetThreadId ?? 'new'} model=${resolvedRequest.requestedModel ?? resolvedRequest.profile.model ?? 'unknown'} provider=${resolvedRequest.profile.modelProvider} workspacePath=${JSON.stringify(workspacePath)}`,
    );
    const runtimeResult = await runCodexAgentTurn({
      service,
      profile: resolvedRequest.profile,
      requestedModel: resolvedRequest.requestedModel,
      usesChatGptAuth: resolvedRequest.isChatGptProfile,
      workspacePath: agentWorkspacePath,
      message: rawMessage,
      system: [request.system, simpleProjectInstruction].filter(Boolean).join('\n\n') || undefined,
      attachments,
      skills: explicitSkills,
      threadId: targetThreadId,
      clientUserMessageId: request.clientUserMessageId,
      binding: request.agentId
        ? {
          agentId: request.agentId,
          callerToken: request.callerToken,
          workspacePath: agentWorkspacePath,
          modelConfig: bindingModelConfig,
          toolProfileId: request.selection === 'stored-profile' ? request.profileId : undefined,
        }
        : {
          agentId: request.agentId ?? `stream-${Date.now()}`,
          callerToken: request.callerToken,
          workspacePath: agentWorkspacePath,
          modelConfig: bindingModelConfig,
        },
      additionalWritableRoots: simpleProject && simpleProject.path !== workspacePath ? [workspacePath] : undefined,
      reasoningEffort: request.reasoningEffort,
      // Simple mode is the quick, conversational surface. Codex/OpenAI accepts
      // this as the request-level fast/priority processing tier. Keep Advanced
      // mode on its existing account default unless it opts in separately.
      config: getAgentServiceTierConfig(request.agentId),
      signal: abortController.signal,
      inspectExistingThread: Boolean(targetThreadId),
      turnErrorContext,
      onEvent: (event) => {
        if (event.kind === 'thread') {
          activeThreadId = event.threadId;
          emit('thread', { threadId: event.threadId });
          return;
        }
        if (event.kind === 'turn') {
          turnMessageId = event.turnId;
          activeThreadId = event.threadId;
          setCurrentTurnMessageId(turnMessageId);
          emit('turn', {
            threadId: event.threadId,
            turnId: event.turnId,
            status: event.status,
          });
          return;
        }
        if (event.notification.method === 'item/started') {
          const item = (event.notification as any).params?.item;
          if (item?.type === 'mcpToolCall' && item.tool) {
            const parsed = parseToolName(item.tool);
            if (parsed) {
              registerPendingToolCall(
                parsed.serverId,
                parsed.toolName,
                item.id,
                item.arguments,
                { threadId: event.notification.params.threadId },
              );
            }
          }
        }
        if (event.notification.method === 'thread/name/updated') {
          emit('threadName', {
            threadId: event.notification.params.threadId,
            name: event.notification.params.threadName ?? null,
          });
          return;
        }
        const uiEvents = mapNotificationToUiEvents(event.notification, turnErrorContext);
        for (const uiEvent of uiEvents) {
          emit(uiEvent.event, uiEvent.payload);
        }
      },
    });
    activeProfileProvider = runtimeResult.profile.modelProvider;
    activeModelId = runtimeResult.resolvedModel;
    console.log(
      `[AGENT] turn_end threadId=${runtimeResult.completion.threadId} turnId=${runtimeResult.completion.turnId} status=${runtimeResult.completion.status} model=${runtimeResult.resolvedModel} durationMs=${Date.now() - streamStartedAt}`,
    );
  } catch (error) {
    const durationMs = Date.now() - streamStartedAt;
    const rawMessage = error instanceof Error ? error.message : 'Unknown error';
    const formattedMessage = isLmStudioProviderId(activeProfileProvider) &&
      isLmStudioPromptTemplateFailure(rawMessage, null)
      ? formatLmStudioPromptTemplateFailure(rawMessage, null)
      : rawMessage;
    const errorTrace = buildAgentTurnErrorTrace(error, {
      agentId: request.agentId ?? null,
      durationMs,
      model: activeModelId ?? request.model ?? 'unknown',
      profileId: request.selection === 'stored-profile' ? request.profileId : null,
      provider: activeProfileProvider ?? 'unknown',
      requestThreadId: request.threadId ?? null,
      resolvedThreadId: targetThreadId ?? null,
      selection: request.selection,
      turnId: turnMessageId,
    });
    console.error(
      `[AGENT] turn_error threadId=${targetThreadId ?? request.threadId ?? 'new'} turnId=${turnMessageId ?? 'none'} model=${activeModelId ?? request.model ?? 'unknown'} provider=${activeProfileProvider ?? 'unknown'} durationMs=${durationMs} message=${JSON.stringify(formattedMessage)} trace=${errorTrace}`,
    );
    emit('error', createAgentStreamErrorPayload(formattedMessage, errorTrace));
  } finally {
    unregisterRunningAgent(runningAgentId);
    setCurrentTurnMessageId(null);
    if (!streamClosed) {
      res.end();
    }
  }
});

router.post('/chat/stop', async (req: Request, res: Response) => {
  let body: StopRequestBody;

  if (!validateStopRequestBody(req.body)) {
    return res.status(400).json({ error: 'threadId is required.' });
  }
  body = req.body;

  try {
    await getCodexService().interrupt(body.threadId as string, body.turnId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to stop turn.',
    });
  }
});

router.post('/chat/steer', async (req: Request, res: Response) => {
  let body: SteerRequestBody;

  if (!validateSteerRequestBody(req.body)) {
    return res.status(400).json({ error: 'threadId, turnId, and message, attachments, or skills are required.' });
  }
  body = req.body;

  // A client ID is a durable reservation even when the HTTP response drops
  // before native queue/user-item observation. Never retry an uncertain steer.
  let receipt: Awaited<ReturnType<typeof nativeSubmissionJournal.begin>> = null;
  if (body.clientUserMessageId) {
    try {
      receipt = await nativeSubmissionJournal.begin(body.threadId as string, body.clientUserMessageId);
      if (!receipt) return res.status(409).json({ code: 'submission_already_recorded' });
    } catch { return res.status(503).json({ code: 'submission_receipt_unavailable' }); }
  }

  try {
    const turnId = await getCodexService().steer(body.threadId as string, {
      turnId: body.turnId,
      clientUserMessageId: body.clientUserMessageId,
      message: body.message,
      attachments: body.attachments,
      skills: body.skills,
    });
    if (receipt) await nativeSubmissionJournal.advance(receipt, 'turn_started', turnId);
    res.json({ ok: true, turnId });
  } catch (error) {
    // A native transport error can follow acceptance. Keep the durable
    // reservation in received state until exact native custody resolves it.
    const code = getSteerErrorCode(error);
    const status = code === 'other' ? 500 : 409;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to steer turn.',
      code,
    });
  }
});

router.post('/chat/background/stop', async (req: Request, res: Response) => {
  let body: BackgroundTerminalStopRequestBody;

  if (!validateBackgroundTerminalStopRequestBody(req.body)) {
    return res.status(400).json({ error: 'threadId is required.' });
  }
  body = req.body;

  try {
    await getCodexService().cleanBackgroundTerminals(body.threadId as string);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to stop background terminal.',
    });
  }
});

router.get('/voice/moonshine-assets/*', async (req: Request, res: Response) => {
  const assetRoot = process.env.MOONSHINE_ASSET_DIR?.trim();
  if (!assetRoot) {
    return res.status(500).json({ error: 'Moonshine asset directory is not configured.' });
  }

  const requestedPath = req.params[0];
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    return res.status(400).json({ error: 'Missing Moonshine asset path.' });
  }

  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    return res.status(400).json({ error: 'Invalid Moonshine asset path encoding.' });
  }

  const resolvedRoot = path.resolve(assetRoot);
  const resolvedAssetPath = path.resolve(resolvedRoot, decodedPath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;

  if (resolvedAssetPath !== resolvedRoot && !resolvedAssetPath.startsWith(rootPrefix)) {
    return res.status(400).json({ error: 'Invalid Moonshine asset path.' });
  }

  try {
    const assetStat = await stat(resolvedAssetPath);
    if (!assetStat.isFile()) {
      return res.status(404).json({ error: 'Moonshine asset not found.' });
    }
  } catch {
    return res.status(404).json({ error: 'Moonshine asset not found.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(resolvedAssetPath, (error) => {
    if (error && !res.headersSent) {
      res.status(500).json({ error: 'Failed to serve Moonshine asset.' });
    }
  });
});

router.post('/voice/stream/start', async (req: Request, res: Response) => {
  try {
    const nativeRecognizer = req.body?.nativeRecognizer === true;
    console.log(`[VoiceStream] Starting stream session... (native=${nativeRecognizer})`);
    const sessionId = await startQwenAsrStreamSession({ nativeRecognizer });
    console.log(`[VoiceStream] Session started: ${sessionId}`);
    return res.json({ sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start voice stream.';
    console.error('[VoiceStream] Failed to start voice stream:', error);
    return res.status(500).json({ error: message });
  }
});

router.post(
  '/voice/stream/chunk/:sessionId',
  raw({ type: 'application/octet-stream', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'Missing stream sessionId.' });
    }

    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Expected non-empty PCM chunk payload.' });
      }

      const result = await appendQwenAsrStreamChunk(sessionId, req.body);
      return res.json({ text: result.text, isSpeech: result.isSpeech });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to append voice stream chunk.';
      const statusCode = message.startsWith('Unknown voice stream session:') ? 404 : 500;
      console.error('[VoiceStream] Failed to append qwen_asr stream chunk:', error);
      return res.status(statusCode).json({ error: message });
    }
  },
);

router.post('/voice/stream/endofturn/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'Missing stream sessionId.' });
  }

  try {
    const pcm = extractRingBuffer(sessionId);
    if (pcm.length === 0) {
      return res.json({ done: true, confidence: 1.0 });
    }
    const result = await inferSmartTurn(pcm);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run end-of-turn detection.';
    console.error('[VoiceStream] Smart Turn inference failed:', error);
    return res.status(500).json({ error: message });
  }
});

router.post('/voice/stream/finish/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'Missing stream sessionId.' });
  }

  try {
    const text = await finishQwenAsrStreamSession(sessionId);
    return res.json({ text });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to finish voice stream.';
    const statusCode = message.startsWith('Unknown voice stream session:') ? 404 : 500;
    console.error('[VoiceStream] Failed to finish qwen_asr stream:', error);
    return res.status(statusCode).json({ error: message });
  }
});

router.post('/voice/stream/abort/:sessionId', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return res.status(400).json({ error: 'Missing stream sessionId.' });
  }

  try {
    await abortQwenAsrStreamSession(sessionId);
    return res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to abort voice stream.';
    console.error('[VoiceStream] Failed to abort qwen_asr stream:', error);
    return res.status(500).json({ error: message });
  }
});

router.post(
  '/voice/transcribe',
  raw({ type: 'audio/wav', limit: '25mb' }),
  async (req: Request, res: Response) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Expected non-empty audio/wav request body.' });
      }

      const text = await transcribeWavWithQwenAsr(req.body);
      return res.json({ text });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to transcribe voice message.';
      console.error('[Voice] Transcription failed:', error);
      return res.status(500).json({ error: message });
    }
  },
);

async function testModelViaCodex(
  profile: CodexProfile,
  modelId: string,
): Promise<{ success: boolean; response?: string; error?: string }> {
  const runtimeModelValidationError = validateRuntimeModelId(profile.modelProvider, modelId);
  if (runtimeModelValidationError) {
    throw new Error(runtimeModelValidationError);
  }

  const service = getCodexService();
  const workspace = getCurrentWorkspace() || '/tmp';
  let threadId = '';
  let turnId = '';
  await service.runTurn({
    message: 'Say "Hello" and nothing else.',
    model: modelId,
    modelProvider: profile.modelProvider!,
    providerConfig: profile.providerConfig,
    cwd: workspace,
    signal: AbortSignal.timeout(15000),
    onEvent: (event) => {
      if (event.kind === 'thread') threadId = event.threadId;
      if (event.kind === 'turn') turnId = event.turnId;
    },
  });
  if (!threadId) {
    return { success: false, error: 'Test failed: no thread created' };
  }
  const thread = await service.readThread(threadId);
  const targetTurn = thread?.turns?.find((t: any) => t.id === turnId) ?? thread?.turns?.[thread.turns.length - 1];
  const text = targetTurn?.items
    ?.filter((item: any) => item.type === 'agentMessage')
    ?.map((item: any) => item.text || '')
    ?.join('') || '';
  return { success: true, response: text.trim() };
}

type TestModelRuntimeProvider = 'hosted' | 'openai' | 'groq' | 'local';

function isTestModelRuntimeProvider(value: unknown): value is TestModelRuntimeProvider {
  return value === 'hosted'
    || value === 'openai'
    || value === 'groq'
    || value === 'local';
}

export function resolveTestModelRuntime({
  provider,
  modelId,
  apiKey,
  baseURL,
}: {
  provider: TestModelRuntimeProvider;
  modelId: string;
  apiKey?: string;
  baseURL?: string;
}): { profile: CodexProfile; modelId: string } {
  if (provider === 'hosted') {
    const jwtToken = getServerJWT();
    let hostedProfile = getCodexProfile('interpreter');
    if (jwtToken) {
      hostedProfile = withAuthToken(hostedProfile, jwtToken);
    }
    return { profile: hostedProfile, modelId };
  }

  if (provider === 'openai') {
    const preset = getCustomPreset('openai-api');
    if (!preset) throw new Error('OpenAI preset not found');
    const profile = buildProfileFromPreset(preset, { baseUrl: baseURL, apiKey, model: modelId });
    return { profile, modelId };
  }

  if (provider === 'groq') {
    const preset = getCustomPreset('groq');
    if (!preset) throw new Error('Groq preset not found');
    const profile = buildProfileFromPreset(preset, { baseUrl: baseURL, apiKey, model: modelId });
    return { profile, modelId };
  }

  if (provider === 'local') {
    const localBaseURL = typeof baseURL === 'string' && baseURL.trim()
      ? baseURL.trim()
      : 'http://localhost:11434/v1';
    const inferredProfileId = inferProfileIdFromEndpoint(localBaseURL);
    const localRuntime = inferredProfileId === 'lmstudio' ? 'lmstudio' : 'ollama';
    const preset = getCustomPreset(localRuntime);
    if (!preset) throw new Error(`${localRuntime === 'lmstudio' ? 'LM Studio' : 'Ollama'} preset not found`);
    const runtimeModelId = resolveLocalRuntimeModelId(modelId, localRuntime);
    const profile = buildProfileFromPreset(preset, {
      baseUrl: localBaseURL,
      model: runtimeModelId,
    });
    return { profile, modelId: runtimeModelId };
  }

  throw new Error(`Unhandled test model provider: ${provider}`);
}

router.post('/test-model', async (req, res) => {
  const { provider } = req.body;
  if (!isTestModelRuntimeProvider(provider)) {
    return res.status(400).json({ success: false, error: 'Unknown provider' });
  }

  try {
    const { profile, modelId } = resolveTestModelRuntime({
      ...req.body,
      provider,
    });
    return res.json(await testModelViaCodex(profile, modelId));
  } catch (error) {
    console.error('[Test] Model test failed:', error);
    res.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Ollama endpoints for local model support

// Check if Ollama is running
router.get('/ollama/status', async (req, res) => {
  try {
    const baseURL = typeof req.query.baseURL === 'string' && req.query.baseURL.trim()
      ? req.query.baseURL.trim()
      : undefined;
    const apiKey = typeof req.query.apiKey === 'string' && req.query.apiKey.trim()
      ? req.query.apiKey.trim()
      : undefined;
    const { getOllamaStatus } = await import('../handlers/providers');
    const status = await getOllamaStatus(baseURL, apiKey);
    res.json(status);
  } catch {
    res.json({ running: false, error: 'Ollama not reachable' });
  }
});

// List available Ollama models
router.get('/ollama/models', async (req, res) => {
  try {
    const baseURL = typeof req.query.baseURL === 'string' && req.query.baseURL.trim()
      ? req.query.baseURL.trim()
      : undefined;
    const apiKey = typeof req.query.apiKey === 'string' && req.query.apiKey.trim()
      ? req.query.apiKey.trim()
      : undefined;
    const { getOllamaStatus } = await import('../handlers/providers');
    const status = await getOllamaStatus(baseURL, apiKey);

    if (!status.running) {
      return res.status(503).json({ error: status.error || 'Ollama not available' });
    }

    const models = (status.models || []).map((modelId) => ({
      id: modelId,
      name: modelId,
      size: 0,
      modified: '',
    }));
    res.json({ models });
  } catch {
    res.status(503).json({ error: 'Ollama not reachable' });
  }
});

// Pull (download) an Ollama model - streams progress via SSE
router.post('/ollama/pull', async (req, res) => {
  const { model, baseURL, apiKey } = req.body;

  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'Model name is required' });
  }

  // Set up SSE for streaming progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // Import and use the handler
    const { pullOllamaModel } = await import('../handlers/providers');
    const localBaseURL = typeof baseURL === 'string' && baseURL.trim() ? baseURL.trim() : undefined;
    const localApiKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;

    for await (const progress of pullOllamaModel(model, localBaseURL, localApiKey)) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);

      // If there's an error with OLLAMA_NOT_RUNNING, end the stream
      if (progress.code === 'OLLAMA_NOT_RUNNING') {
        res.end();
        return;
      }
    }

    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: String(error), code: 'UNEXPECTED_ERROR' })}\n\n`);
    res.end();
  }
});

// LM Studio endpoints for local model support

// Check if LM Studio is running
router.get('/lmstudio/status', async (req, res) => {
  try {
    const baseURL = typeof req.query.baseURL === 'string' && req.query.baseURL.trim()
      ? req.query.baseURL.trim()
      : undefined;
    const { getLmStudioStatus } = await import('../handlers/providers');
    const status = await getLmStudioStatus(baseURL);
    res.json(status);
  } catch {
    res.json({ running: false, error: 'LM Studio not reachable' });
  }
});

// List available LM Studio models
router.get('/lmstudio/models', async (req, res) => {
  try {
    const baseURL = typeof req.query.baseURL === 'string' && req.query.baseURL.trim()
      ? req.query.baseURL.trim()
      : undefined;
    const { getLmStudioStatus } = await import('../handlers/providers');
    const status = await getLmStudioStatus(baseURL);

    if (!status.running) {
      return res.status(503).json({ error: status.error || 'LM Studio not available' });
    }

    const models = (status.models || []).map((modelId) => ({
      id: modelId,
      name: modelId,
      size: 0,
      modified: '',
    }));
    res.json({ models });
  } catch {
    res.status(503).json({ error: 'LM Studio not reachable' });
  }
});

// Download an LM Studio model - streams progress via SSE
router.post('/lmstudio/download', async (req, res) => {
  const { model, baseURL } = req.body;

  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'Model key is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { downloadLmStudioModel } = await import('../handlers/providers');
    const localBaseURL = typeof baseURL === 'string' && baseURL.trim() ? baseURL.trim() : undefined;

    for await (const progress of downloadLmStudioModel(model, localBaseURL)) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);

      if (progress.code === 'LM_STUDIO_NOT_RUNNING') {
        res.end();
        return;
      }
    }

    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: String(error), code: 'UNEXPECTED_ERROR' })}\n\n`);
    res.end();
  }
});

// Get cached tool args for an agent
// Used by the client to inject args into saved conversations (since Claude/ACP doesn't stream them)
router.get('/tool-args/:agentId', (req, res) => {
  const { agentId } = req.params;
  const args = toolArgsCache.get(agentId) || [];
  console.log(`[Agent API] Returning ${args.length} cached tool args for agent ${agentId}`);
  res.json({ success: true, toolArgs: args });
});

// Clear cached tool args for an agent (called when conversation is saved or agent is closed)
router.delete('/tool-args/:agentId', (req, res) => {
  const { agentId } = req.params;
  toolArgsCache.delete(agentId);
  console.log(`[Agent API] Cleared cached tool args for agent ${agentId}`);
  res.json({ success: true });
});

// ============================================================================
// CONVERSATION STORAGE ENDPOINTS
// Server-side storage that captures raw data as it streams through
// ============================================================================

// Load a conversation
router.get('/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const conversation = loadConversation(conversationId);
  if (!conversation) {
    return res.status(404).json({ success: false, error: 'Conversation not found' });
  }
  res.json({ success: true, conversation });
});

// List all conversations
router.get('/conversations', (_req, res) => {
  const conversations = listConversations();
  res.json({ success: true, conversations });
});

// Delete a conversation
router.delete('/conversations/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const success = deleteConversation(conversationId);
  res.json({ success });
});

// Update conversation title
router.patch('/conversations/:conversationId/title', (req, res) => {
  const { conversationId } = req.params;
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, error: 'Title required' });
  }

  updateTitle(conversationId, title);
  res.json({ success: true });
});

// Clear conversation from memory cache (when agent tab closes)
router.post('/conversations/:conversationId/close', (req, res) => {
  const { conversationId } = req.params;
  clearFromCache(conversationId);
  res.json({ success: true });
});

// Clear active WhatsApp bridge session on agent tab close.
router.post('/whatsapp/close', (req, res) => {
  const { agentId, conversationId } = req.body ?? {};
  if (typeof agentId === 'string' && agentId) {
    taskStore.clear(agentId);
  }
  const closed = closeWhatsAppBridgeSession({ agentId, conversationId });
  res.json({ success: true, closed });
});

// GET /api/agent/subagent-tools/:agentId
// Returns all subagent tool calls for the given agent (from in-memory staging)
router.get('/subagent-tools/:agentId', (_req, res) => {
  // Return all staged subagent tool calls using the exported helper
  // Frontend will filter by toolCallId as needed
  const allCalls = getAllSubagentToolCalls();
  res.json({ success: true, toolCalls: allCalls });
});

// DELETE /api/agent/subagent-tools/:agentId
// Clear staging after save completes
router.delete('/subagent-tools/:agentId', (_req, res) => {
  clearAllSubagentToolCalls();
  res.json({ success: true });
});

export default router;
