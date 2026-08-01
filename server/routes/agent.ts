import { Router, Request, Response, raw } from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { getCustomInstructions } from '../configStore';
import { getServerJWT } from '../lib/jwtStore';
import { AgentModelConfig } from '../../shared/types/model';
import { messageQueueStore } from '../utils/messageQueueStore';
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
  startAgentTask,
  type AgentTaskMode,
  type AgentTaskProgressEvent,
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
  getCodexService,
  getSteerErrorCode,
  THREAD_LIST_DEFAULTS,
} from '../../src/lib/codex/service';
import { enrichThreadWithReasoning } from '../../src/lib/codex/enrich-thread-reasoning';
import {
  buildProfileFromPreset,
  getCustomPreset,
  getProfile as getCodexProfile,
  type Profile as CodexProfile,
  withAuthToken,
} from '../../src/lib/codex/profiles';
import { inferProfileIdFromEndpoint } from '../../src/lib/codex/profile-options';
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
import { isThreadUnavailableError, requiresFreshThread } from '../utils/codexThreadRecovery';
import {
  getMainAgentBaseInstructions,
  getMainAgentDeveloperPrompt,
} from '../utils/mainAgentPrompt';
import { agentTabManager } from '../agentTabManager';
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

const router = Router();

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
  try {
    const {
      message,
      system,
      timeoutMs,
      workspace,
      threadId,
      mode,
      modelConfig,
      runtimeConfig,
    } = parseProgrammaticTaskBody((req.body ?? {}) as Record<string, unknown>);

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

    await applyProgrammaticTaskRuntimeConfigFromBody(runtimeConfig);

    const result = await startAgentTask({
      mode: 'headless',
      message,
      system,
      timeoutMs,
      workspace,
      modelConfig,
      threadId,
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
  const {
    message,
    system,
    timeoutMs,
    workspace,
    threadId,
    mode,
    modelConfig,
    runtimeConfig,
  } = parseProgrammaticTaskBody((req.body ?? {}) as Record<string, unknown>);

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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let streamClosed = false;
  req.on('close', () => {
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

    const result = await startAgentTask({
      mode: 'headless',
      message,
      system,
      timeoutMs,
      workspace,
      modelConfig,
      threadId,
      notifyStarted: true,
      onProgress: (progress) => {
        for (const event of toProgrammaticTaskProgressSseEvents(progress)) {
          emit(event.event, event.payload);
        }
      },
    });

    emit('result', result);
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('error', { message });
    res.end();
  }
});

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

function parseProgrammaticTaskBody(body: Record<string, unknown>) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const system = typeof body.system === 'string' ? body.system : undefined;
  const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
  const workspace = normalizeHeadlessTaskWorkspace(
    typeof body.workspace === 'string' ? body.workspace : undefined,
  );
  const threadId = typeof body.threadId === 'string' && body.threadId.trim()
    ? body.threadId.trim()
    : undefined;
  const mode = body.mode === undefined ? 'headless' : body.mode;
  const modelConfig = body.modelConfig && typeof body.modelConfig === 'object'
    ? body.modelConfig as AgentModelConfig
    : undefined;
  const runtimeConfig = body.runtimeConfig && typeof body.runtimeConfig === 'object'
    ? body.runtimeConfig as Record<string, unknown>
    : undefined;

  return {
    message,
    system,
    timeoutMs,
    workspace,
    threadId,
    mode,
    modelConfig,
    runtimeConfig,
  };
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

router.get('/threads', async (req: Request, res: Response) => {
  try {
    const archived = req.query.archived === '1' || req.query.archived === 'true';
    const result = await getCodexService().listThreads({
      ...THREAD_LIST_DEFAULTS,
      archived,
    });
    res.json(result);
  } catch (error) {
    console.warn(
      '[Agent API] Failed to list threads; returning empty thread list.',
      error instanceof Error ? error.message : error,
    );
    res.json({
      data: [],
      nextCursor: null,
    });
  }
});

router.get('/threads/:threadId', async (req: Request, res: Response) => {
  try {
    let thread = await getCodexService().readThread(req.params.threadId);
    thread = enrichThreadWithReasoning(thread);
    res.json({ thread });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read thread.',
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
    abortController.abort();
    streamClosed = true;
  });

  const emit = (event: string, payload: unknown) => {
    if (streamClosed) return;
    const wrote = writeCodexSse(res, event, payload);
    if (!wrote) {
      streamClosed = true;
      abortController.abort();
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
    if (targetThreadId) {
      try {
        const existingThread = await service.readThread(targetThreadId);
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
        if (isThreadUnavailableError(error)) {
          console.warn('[Agent API] Starting fresh Codex thread after stale thread id.', {
            staleThreadId: targetThreadId,
          });
          targetThreadId = undefined;
          // Continue with a fresh thread for this turn.
        } else {
          console.warn(
            '[Agent API] Failed to inspect Codex thread before send; continuing with normal resume flow.',
            error instanceof Error ? error.message : error,
          );
        }
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
      workspacePath,
      message: rawMessage,
      system: request.system,
      attachments,
      skills: explicitSkills,
      threadId: targetThreadId,
      binding: request.agentId
        ? {
          agentId: request.agentId,
          callerToken: request.callerToken,
          workspacePath,
          modelConfig: bindingModelConfig,
          toolProfileId: request.selection === 'stored-profile' ? request.profileId : undefined,
        }
        : {
          agentId: request.agentId ?? `stream-${Date.now()}`,
          callerToken: request.callerToken,
          workspacePath,
          modelConfig: bindingModelConfig,
        },
      reasoningEffort: request.reasoningEffort,
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

  try {
    const turnId = await getCodexService().steer(body.threadId as string, {
      turnId: body.turnId,
      message: body.message,
      attachments: body.attachments,
      skills: body.skills,
    });
    res.json({ ok: true, turnId });
  } catch (error) {
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
