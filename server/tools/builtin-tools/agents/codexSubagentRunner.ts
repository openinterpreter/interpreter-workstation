import { nanoid } from 'nanoid';
import type { v2 } from '../../../handlers/codex-generated-types/index';
import type { AgentModelConfig } from '../../../../shared/types/model';
import type { AgentPermissionOwnerReference } from '../../../../shared/types/approval';
import { getCodexService, type StreamEvent } from '../../../../src/lib/codex/service';
import type { Profile as CodexProfile } from '../../../../src/lib/codex/profiles';
import { agentTabManager } from '../../../agentTabManager';
import {
  ensureOpenAIOAuthAccountReady,
  resolveCodexProfileFromModelConfig,
  runCodexAgentTurn,
} from '../../../utils/codexRuntime';
import { buildGroqProxyBaseUrl, routeGroqProfileThroughProxy } from '../../../utils/groqResponsesProxy';
import { getServerPort } from '../../../utils/serverPort';
import { getCurrentWorkspace } from '../../../utils/workspace';
import type { StreamSkillReference } from '../../../../src/lib/codex/api-types';

export interface RunCodexSubagentOptions {
  message: string;
  system?: string;
  modelConfig: AgentModelConfig;
  skills?: StreamSkillReference[];
  threadId?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number | null;
  workspace?: string;
  allowedToolNames?: string[];
  parentOwner?: AgentPermissionOwnerReference;
  sandboxPolicy?: v2.SandboxPolicy;
  threadConfig?: Record<string, any>;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none';
  session?: CodexSubagentSession;
  onEvent?: (event: StreamEvent) => void;
}

export interface CodexSubagentSession {
  service: ReturnType<typeof getCodexService>;
  profile: CodexProfile;
  agentId: string;
  callerToken: string;
  allowedToolNames?: string[];
  parentOwner?: AgentPermissionOwnerReference;
  modelConfig: AgentModelConfig;
  threadId?: string;
  dispose: () => void;
}

type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function createAgentRuntimeId(prefix: string): string {
  return `${prefix}-${nanoid()}`;
}

function createCallerToken(): string {
  return `agtok_${nanoid()}`;
}

function resolveSessionProfile(modelConfig: AgentModelConfig): CodexProfile {
  const profile = resolveCodexProfileFromModelConfig(modelConfig);
  return routeGroqProfileThroughProxy(profile, buildGroqProxyBaseUrl(getServerPort()));
}

function extractAssistantText(thread: any, turnId: string): string {
  const targetTurn = thread?.turns?.find((turn: any) => turn.id === turnId)
    ?? thread?.turns?.[thread.turns.length - 1];
  if (!targetTurn) {
    return '';
  }

  return targetTurn.items
    .filter((item: any) => item.type === 'agentMessage')
    .map((item: any) => item.text || '')
    .join('')
    .trim();
}

function normalizeReasoningEffortForModel(
  runtimeModel: string,
  requestedEffort: CodexReasoningEffort | undefined | null,
): CodexReasoningEffort {
  const effort = requestedEffort ?? 'low';
  const normalizedModel = runtimeModel.toLowerCase();

  if (effort === 'minimal' && normalizedModel.includes('gpt-5.1-codex-mini')) {
    console.log(
      `[codex-subagent-timing] normalize_reasoning_effort model=${runtimeModel} from=minimal to=low`,
    );
    return 'low';
  }

  return effort;
}

export async function createCodexSubagentSession(options: {
  modelConfig: AgentModelConfig;
  allowedToolNames?: string[];
  parentOwner?: AgentPermissionOwnerReference;
}): Promise<CodexSubagentSession> {
  const callerToken = createCallerToken();

  return {
    service: getCodexService(),
    profile: resolveSessionProfile(options.modelConfig),
    agentId: createAgentRuntimeId('codex-agent'),
    callerToken,
    allowedToolNames: options.allowedToolNames && options.allowedToolNames.length > 0
      ? Array.from(new Set(options.allowedToolNames))
      : undefined,
    parentOwner: options.parentOwner,
    modelConfig: options.modelConfig,
    threadId: undefined,
    dispose: () => {
      agentTabManager.disposeBinding(callerToken);
    },
  };
}

export function closeCodexSubagentSession(session: CodexSubagentSession | null | undefined): void {
  session?.dispose();
}

export async function runCodexSubagent(options: RunCodexSubagentOptions): Promise<any> {
  const subagentStart = Date.now();
  const timingTag = '[codex-subagent-timing]';
  const workspace = options.workspace || getCurrentWorkspace();

  if (!workspace) {
    return {
      agentId: createAgentRuntimeId('codex-agent'),
      messages: [],
      completed: false,
      timestamp: new Date().toISOString(),
      error: 'No workspace set. Open a folder first.',
      hitMaxSteps: false,
    };
  }

  const ownsSession = !options.session;
  const session = options.session ?? await createCodexSubagentSession({
    modelConfig: options.modelConfig,
    allowedToolNames: options.allowedToolNames ?? [],
    parentOwner: options.parentOwner,
  });

  console.log(`${timingTag} start workspace=${workspace} timeoutMs=${options.timeoutMs ?? 0}`);
  console.log(`${timingTag} session=${ownsSession ? 'new' : 'reused'} callerToken=${session.callerToken}`);

  const runAbortController = new AbortController();
  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', () => runAbortController.abort(), { once: true });
  }

  let timeoutId: NodeJS.Timeout | undefined;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeoutId = setTimeout(() => runAbortController.abort(), options.timeoutMs);
  }

  try {
    const runtimeModel = options.modelConfig.modelId;
    if (!runtimeModel) {
      throw new Error('Codex subagent model is required.');
    }
    console.log(`${timingTag} model=${runtimeModel}`);

    const normalizedReasoningEffort = normalizeReasoningEffortForModel(
      runtimeModel,
      options.reasoningEffort,
    );

    // Programmatic/headless turns use the same persisted ChatGPT account as
    // the interactive stream route. Refresh and validate it before thread
    // creation so OIX selects the ChatGPT Codex endpoint instead of falling
    // back to an unauthenticated OpenAI API request.
    await ensureOpenAIOAuthAccountReady(
      session.service,
      session.modelConfig.provider === 'openai-oauth',
    );

    let threadId = '';
    let turnId = '';
    const runTurnStart = Date.now();
    const result = await runCodexAgentTurn({
      service: session.service,
      profile: session.profile,
      requestedModel: runtimeModel,
      usesChatGptAuth: session.modelConfig.provider === 'openai-oauth',
      workspacePath: workspace,
      message: options.message,
      skills: options.skills,
      threadId: options.threadId ?? session.threadId,
      binding: {
        agentId: session.agentId,
        callerToken: session.callerToken,
        workspacePath: workspace,
        allowedToolNames: session.allowedToolNames,
        modelConfig: session.modelConfig,
        toolProfileId: session.modelConfig.profileId,
        parentOwner: session.parentOwner,
      },
      sandboxPolicy: options.sandboxPolicy,
      reasoningEffort: normalizedReasoningEffort,
      reasoningSummary: options.reasoningSummary ?? 'none',
      system: options.system,
      config: (options.threadConfig ?? {}) as Record<string, any>,
      idleTimeoutMs: options.idleTimeoutMs,
      signal: runAbortController.signal,
      onEvent: (event) => {
        options.onEvent?.(event);
        if (event.kind === 'thread') {
          threadId = event.threadId;
        } else if (event.kind === 'turn') {
          turnId = event.turnId;
        }
      },
    });
    console.log(`${timingTag} runTurn in ${Date.now() - runTurnStart}ms status=${result.completion.status}`);

    if (!threadId || !turnId) {
      session.threadId = undefined;
      return {
        agentId: session.agentId,
        messages: [],
        completed: false,
        timestamp: new Date().toISOString(),
        error: 'Codex subagent did not produce thread/turn identifiers.',
        hitMaxSteps: false,
      };
    }

    const readThreadStart = Date.now();
    const thread = await session.service.readThread(threadId);
    console.log(`${timingTag} readThread in ${Date.now() - readThreadStart}ms`);
    const assistantText = extractAssistantText(thread, turnId);
    const completed = result.completion.status === 'completed';
    session.threadId = completed ? threadId : undefined;

    return {
      agentId: session.agentId,
      messages: [
        {
          id: `subagent-user-${turnId}`,
          role: 'user',
          parts: [{ type: 'text', text: options.message }],
        },
        {
          id: `subagent-assistant-${turnId}`,
          role: 'assistant',
          parts: [{ type: 'text', text: assistantText }],
        },
      ],
      completed,
      timestamp: new Date().toISOString(),
      error: completed ? undefined : `Codex subagent turn ended with status "${result.completion.status}"`,
      hitMaxSteps: false,
      threadId,
      threadPath: thread.path ?? undefined,
    };
  } catch (error: any) {
    session.threadId = undefined;
    console.log(`${timingTag} error after ${Date.now() - subagentStart}ms: ${error?.message || String(error)}`);
    return {
      agentId: session.agentId,
      messages: [],
      completed: false,
      timestamp: new Date().toISOString(),
      error: error?.message || String(error),
      hitMaxSteps: false,
    };
  } finally {
    console.log(`${timingTag} end total=${Date.now() - subagentStart}ms`);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (ownsSession) {
      closeCodexSubagentSession(session);
    }
  }
}
