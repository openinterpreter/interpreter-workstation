// Agent Tab Manager
// Manages in-memory agent tab creation requests for UI-based agent execution

import { nanoid } from 'nanoid';
import path from 'node:path';
import { broadcastEvent } from './handlers/broadcast';
import type { AgentModelConfig } from '../shared/types/model';
import type { MessageSendSource } from '../shared/types/messageSendSource';
import type { AgentActivityState } from '../shared/utils/agentAttention';
import type { StreamImageAttachment } from '../src/lib/codex/api-types';
import { getCurrentWindowSessionKey } from './utils/windowSessions';
import type { AgentPermissionOwnerReference } from '../shared/types/approval';

export interface PendingAgentTabRequest {
  requestId: string;
  agentId: string;
  callerToken: string;
  initialMessage?: string;
  systemPrompt?: string;
  workspacePath?: string;
  targetWindowSessionKey?: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
  timeout: number;
  createdAt: number;
  threadId?: string;
  modelConfig?: AgentModelConfig;
  activate?: boolean;
  startupAttachments?: StreamImageAttachment[];
  completionDisposition: AgentCompletionDisposition;
  resolve: (result: CompletedAgentTabResult) => void;
  reject: (error: Error) => void;
}

export type AgentCompletionDisposition = 'keep_open' | 'close_tab';

export interface PendingAgentTabStartup {
  startupId: string;
  agentId: string;
  initialMessage?: string;
  attachments?: StreamImageAttachment[];
  completionDisposition: AgentCompletionDisposition;
  createdAt: number;
}

export interface CompletedAgentTabResult {
  agentId: string;
  callerToken: string;
  requestId?: string;
  startupId?: string;
  threadId?: string;
  messages: any[];
}

export interface AgentTabCompletionEvent extends CompletedAgentTabResult {
  error?: string;
}

export type AgentTabCompletionListener = (event: AgentTabCompletionEvent) => void;

export interface ConsumeAgentTabStartupResult {
  startupId: string;
  initialMessage?: string;
  attachments?: StreamImageAttachment[];
  completionDisposition: AgentCompletionDisposition;
}

export interface CreateAgentTaskOptions {
  agentId?: string;
  callerToken?: string;
  initialMessage?: string;
  systemPrompt?: string;
  timeout?: number;
  threadId?: string;
  workspacePath?: string;
  modelConfig?: AgentModelConfig;
  activate?: boolean;
  targetWindowSessionKey?: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
  startupAttachments?: StreamImageAttachment[];
  completionDisposition?: AgentCompletionDisposition;
  broadcastCreateRequestToAllWindows?: boolean;
}

export interface AgentThreadBinding {
  agentId: string;
  callerToken: string;
  threadId?: string;
  windowSessionKey?: string | null;
  workspacePath?: string;
  allowedToolNames?: string[];
  modelConfig?: AgentModelConfig;
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
}

export interface AgentWindowBindingSnapshot {
  agentId: string;
  threadId?: string;
  windowSessionKey?: string | null;
  workspacePath?: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
  model?: {
    provider: AgentModelConfig['provider'];
    modelId: string;
    profileId?: string;
  };
  activity?: AgentActivityState;
}

export interface AgentWindowSendRequest {
  agentId: string;
  threadId?: string;
  message: string;
  workspacePath?: string | null;
  messageSource?: MessageSendSource | null;
}

export interface WorkspaceSwitchBlocker {
  agentId: string;
  callerToken: string;
  threadId?: string;
  workspacePath: string;
}

export interface BindAgentRuntimeOptions {
  agentId: string;
  callerToken: string;
  threadId?: string;
  windowSessionKey?: string | null;
  workspacePath?: string;
  allowedToolNames?: string[];
  modelConfig?: AgentModelConfig;
  toolProfileId?: string;
  parentOwner?: AgentPermissionOwnerReference;
}

class AgentTabManager {
  private pendingRequests: Map<string, PendingAgentTabRequest> = new Map();
  private pendingStartups: Map<string, PendingAgentTabStartup> = new Map();
  private createdRequests: Map<string, {
    agentId: string;
    callerToken: string;
    threadId?: string;
  }> = new Map();
  private completionListeners: Set<AgentTabCompletionListener> = new Set();
  private threadBindings: Map<string, AgentThreadBinding> = new Map();
  private callerTokenBindings: Map<string, AgentThreadBinding> = new Map();
  private agentIdBindings: Map<string, AgentThreadBinding> = new Map();
  private agentActivities: Map<string, AgentActivityState> = new Map();
  private defaultTimeout: number = 120000; // 2 minutes

  private createAgentId(): string {
    return `agent-${nanoid()}`;
  }

  private createCallerToken(): string {
    return `agtok_${nanoid()}`;
  }

  private createBinding(
    options: BindAgentRuntimeOptions,
    existingBinding?: AgentThreadBinding,
  ): AgentThreadBinding {
    const windowSessionKey = options.windowSessionKey
      ?? existingBinding?.windowSessionKey
      ?? getCurrentWindowSessionKey()
      ?? undefined;
    const parentOwner = options.parentOwner
      ? { ...options.parentOwner }
      : existingBinding?.parentOwner
        ? { ...existingBinding.parentOwner }
        : undefined;

    return {
      agentId: options.agentId,
      callerToken: options.callerToken,
      threadId: options.threadId ?? existingBinding?.threadId,
      ...(windowSessionKey !== undefined ? { windowSessionKey } : {}),
      workspacePath: options.workspacePath !== undefined
        ? options.workspacePath
        : existingBinding?.workspacePath,
      allowedToolNames: options.allowedToolNames && options.allowedToolNames.length > 0
        ? Array.from(new Set(options.allowedToolNames))
        : existingBinding?.allowedToolNames,
      modelConfig: options.modelConfig ?? existingBinding?.modelConfig,
      toolProfileId: options.toolProfileId ?? existingBinding?.toolProfileId,
      ...(parentOwner ? { parentOwner } : {}),
    };
  }

  private setBinding(options: BindAgentRuntimeOptions): AgentThreadBinding {
    const existingBinding = this.callerTokenBindings.get(options.callerToken)
      ?? (options.threadId ? this.threadBindings.get(options.threadId) : undefined);
    if (
      existingBinding
      && existingBinding.callerToken === options.callerToken
      && existingBinding.agentId !== options.agentId
    ) {
      throw new Error(`Caller token is already bound to agent '${existingBinding.agentId}', not '${options.agentId}'.`);
    }
    const nextBinding = this.createBinding(options, existingBinding);
    this.callerTokenBindings.set(options.callerToken, nextBinding);
    this.agentIdBindings.set(options.agentId, nextBinding);

    for (const [threadId, threadBinding] of this.threadBindings.entries()) {
      if (threadBinding.callerToken === options.callerToken && threadId !== options.threadId) {
        this.threadBindings.delete(threadId);
      }
    }

    if (options.threadId) {
      this.threadBindings.set(options.threadId, nextBinding);
    }
    return nextBinding;
  }

  private matchesPendingScope(
    request: PendingAgentTabRequest,
    scope?: { windowSessionKey?: string | null; workspacePath?: string | null },
  ): boolean {
    if (!scope) {
      return true;
    }

    if (request.targetWindowSessionKey) {
      return request.targetWindowSessionKey === (scope.windowSessionKey ?? null);
    }

    if (request.workspacePath !== undefined) {
      return request.workspacePath === scope.workspacePath;
    }

    return true;
  }

  private enqueueAgentTask(
    options: CreateAgentTaskOptions,
  ): {
    immediateResult: CompletedAgentTabResult;
    completionPromise: Promise<CompletedAgentTabResult>;
  } {
    const requestId = nanoid();
    const timeoutMs = options.timeout ?? this.defaultTimeout;
    const agentId = options.agentId ?? this.createAgentId();
    const callerToken = options.callerToken ?? this.createCallerToken();
    const completionDisposition = options.completionDisposition ?? 'keep_open';
    const startupId = options.initialMessage?.trim() ? requestId : undefined;
    const initialBinding = this.setBinding({
      agentId,
      callerToken,
      threadId: options.threadId,
      windowSessionKey: options.targetWindowSessionKey,
      workspacePath: options.workspacePath,
      allowedToolNames: options.allowedToolNames,
      modelConfig: options.modelConfig,
      toolProfileId: options.toolProfileId,
      parentOwner: options.parentOwner,
    });
    const targetWindowSessionKey = initialBinding.windowSessionKey ?? undefined;

    const completionPromise = new Promise<CompletedAgentTabResult>((resolve, reject) => {
      const request: PendingAgentTabRequest = {
        requestId,
        agentId,
        callerToken,
        initialMessage: options.initialMessage,
        systemPrompt: options.systemPrompt,
        workspacePath: options.workspacePath,
        targetWindowSessionKey,
        allowedToolNames: options.allowedToolNames,
        toolProfileId: options.toolProfileId,
        parentOwner: options.parentOwner,
        timeout: timeoutMs,
        createdAt: Date.now(),
        threadId: options.threadId,
        modelConfig: options.modelConfig,
        activate: options.activate,
        startupAttachments: options.startupAttachments,
        completionDisposition,
        resolve,
        reject,
      };

      this.pendingRequests.set(requestId, request);
      if (startupId) {
        this.pendingStartups.set(requestId, {
          startupId: requestId,
          agentId,
          initialMessage: options.initialMessage,
          ...(options.startupAttachments ? { attachments: options.startupAttachments } : {}),
          completionDisposition,
          createdAt: request.createdAt,
        });
      }

      const createRequestScope = options.broadcastCreateRequestToAllWindows === true
        ? undefined
        : targetWindowSessionKey
          ? { windowSessionKey: targetWindowSessionKey }
          : request.workspacePath !== undefined
            ? { workspacePath: request.workspacePath ?? null }
            : undefined;

      broadcastEvent('agent-tab:create-requested', {
        requestId,
        agentId,
        callerToken,
        startupId,
        initialMessage: options.initialMessage,
        systemPrompt: options.systemPrompt,
        timeout: timeoutMs,
        threadId: options.threadId,
        workspacePath: options.workspacePath,
        modelConfig: options.modelConfig,
        activate: options.activate,
        completionDisposition,
      }, createRequestScope);
      console.log('[AgentTabManager] Sent create-requested event:', requestId);

      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          const pendingRequest = this.pendingRequests.get(requestId)!;
          this.pendingRequests.delete(requestId);
          this.pendingStartups.delete(requestId);
          pendingRequest.reject(new Error(`Agent tab creation timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });

    return {
      immediateResult: {
        agentId,
        callerToken,
        requestId,
        startupId,
        threadId: options.threadId,
        messages: [],
      },
      completionPromise,
    };
  }

  /**
   * Request a new agent tab from the UI.
   * Resolves when the renderer acknowledges that the tab was opened.
   */
  async createAgentTab(
    initialMessage?: string,
    systemPrompt?: string,
    timeout?: number,
    threadId?: string,
    workspacePath?: string,
  ): Promise<any[]> {
    const result = await this.createAgentTask({
      initialMessage,
      systemPrompt,
      timeout,
      threadId,
      workspacePath,
    });
    return result.messages;
  }

  /**
   * Request a new agent task from the UI and resolve once the tab exists.
   */
  async createAgentTask(
    options: CreateAgentTaskOptions,
  ): Promise<CompletedAgentTabResult> {
    return this.enqueueAgentTask(options).completionPromise;
  }

  /**
   * Register a headed agent task and return immediately.
   * UI projection/acknowledgement happens asynchronously.
   */
  requestAgentTask(
    options: CreateAgentTaskOptions,
  ): CompletedAgentTabResult {
    const queuedTask = this.enqueueAgentTask(options);
    void queuedTask.completionPromise.catch(() => {});
    return queuedTask.immediateResult;
  }

  /**
   * UI confirms tab was created
   * @param requestId The request ID
   * @param agentId The ID of the created agent
   */
  onTabCreated(requestId: string, agentId: string) {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      this.pendingRequests.delete(requestId);
      this.createdRequests.set(requestId, {
        agentId: request.agentId,
        callerToken: request.callerToken,
        threadId: request.threadId,
      });
      request.resolve({
        agentId,
        callerToken: request.callerToken,
        requestId,
        startupId: this.pendingStartups.has(requestId) ? requestId : undefined,
        threadId: request.threadId,
        messages: [],
      });
      console.log('[AgentTabManager] Tab created:', { requestId, agentId });
    }
  }

  onCompletion(listener: AgentTabCompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => {
      this.completionListeners.delete(listener);
    };
  }

  consumeStartup(startupId: string, agentId: string): ConsumeAgentTabStartupResult | null {
    const pendingStartup = this.pendingStartups.get(startupId);
    if (!pendingStartup) {
      return null;
    }
    if (pendingStartup.agentId !== agentId) {
      throw new Error(`Startup ${startupId} does not belong to agent ${agentId}.`);
    }
    this.pendingStartups.delete(startupId);
    return {
      startupId: pendingStartup.startupId,
      initialMessage: pendingStartup.initialMessage,
      ...(pendingStartup.attachments ? { attachments: pendingStartup.attachments } : {}),
      completionDisposition: pendingStartup.completionDisposition,
    };
  }

  registerAgentRuntime(options: BindAgentRuntimeOptions): AgentThreadBinding {
    const binding = this.setBinding(options);
    console.log('[AgentTabManager] Registered agent runtime:', {
      agentId: options.agentId,
      hasCallerToken: true,
      windowSessionKey: binding.windowSessionKey ?? null,
      threadId: options.threadId ?? null,
      workspacePath: binding.workspacePath ?? null,
      allowedToolCount: binding.allowedToolNames?.length ?? 0,
      toolProfileId: binding.toolProfileId ?? null,
      parentOwnerAgentId: binding.parentOwner?.agentId ?? null,
      hasModelConfig: Boolean(binding.modelConfig),
    });
    return binding;
  }

  bindThread(options: BindAgentRuntimeOptions & { threadId: string }): AgentThreadBinding {
    const binding = this.setBinding(options);
    console.log('[AgentTabManager] Bound thread to agent:', {
      agentId: options.agentId,
      threadId: options.threadId,
      hasCallerToken: true,
      windowSessionKey: binding.windowSessionKey ?? null,
      workspacePath: binding.workspacePath ?? null,
      allowedToolCount: binding.allowedToolNames?.length ?? 0,
      toolProfileId: binding.toolProfileId ?? null,
      parentOwnerAgentId: binding.parentOwner?.agentId ?? null,
      hasModelConfig: Boolean(binding.modelConfig),
    });
    return binding;
  }

  bindAuxiliaryThread(options: { ownerThreadId: string; threadId: string }): AgentThreadBinding | undefined {
    const ownerBinding = this.threadBindings.get(options.ownerThreadId);
    if (!ownerBinding) {
      console.warn('[AgentTabManager] Unable to bind auxiliary thread: owner thread is not bound', {
        ownerThreadId: options.ownerThreadId,
        threadId: options.threadId,
      });
      return undefined;
    }

    const binding: AgentThreadBinding = {
      ...ownerBinding,
      threadId: options.threadId,
    };
    this.threadBindings.set(options.threadId, binding);
    console.log('[AgentTabManager] Bound auxiliary thread to agent:', {
      agentId: binding.agentId,
      ownerThreadId: options.ownerThreadId,
      threadId: options.threadId,
      hasCallerToken: true,
      windowSessionKey: binding.windowSessionKey ?? null,
      workspacePath: binding.workspacePath ?? null,
      allowedToolCount: binding.allowedToolNames?.length ?? 0,
      toolProfileId: binding.toolProfileId ?? null,
      parentOwnerAgentId: binding.parentOwner?.agentId ?? null,
      hasModelConfig: Boolean(binding.modelConfig),
    });
    return binding;
  }

  getBindingForThread(threadId: string): AgentThreadBinding | undefined {
    return this.threadBindings.get(threadId);
  }

  getBindingForCallerToken(callerToken: string): AgentThreadBinding | undefined {
    return this.callerTokenBindings.get(callerToken);
  }

  getBindingForAgentId(agentId: string): AgentThreadBinding | undefined {
    return this.agentIdBindings.get(agentId);
  }

  listAgentWindowBindings(scope?: {
    windowSessionKey?: string | null;
    workspacePath?: string | null;
  }): AgentWindowBindingSnapshot[] {
    return Array.from(this.agentIdBindings.values())
      .filter((binding) => {
        if (scope?.windowSessionKey !== undefined && (binding.windowSessionKey ?? null) !== scope.windowSessionKey) {
          return false;
        }
        if (scope?.workspacePath !== undefined && (binding.workspacePath ?? null) !== scope.workspacePath) {
          return false;
        }
        return true;
      })
      .sort((left, right) => left.agentId.localeCompare(right.agentId))
      .map((binding) => ({
        agentId: binding.agentId,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
        windowSessionKey: binding.windowSessionKey ?? null,
        ...(binding.workspacePath ? { workspacePath: binding.workspacePath } : {}),
        ...(binding.allowedToolNames ? { allowedToolNames: [...binding.allowedToolNames] } : {}),
        ...(binding.toolProfileId ? { toolProfileId: binding.toolProfileId } : {}),
        ...(binding.parentOwner ? { parentOwner: { ...binding.parentOwner } } : {}),
        ...(binding.modelConfig ? {
          model: {
            provider: binding.modelConfig.provider,
            modelId: binding.modelConfig.modelId,
            ...(binding.modelConfig.profileId ? { profileId: binding.modelConfig.profileId } : {}),
          },
        } : {}),
        ...(this.agentActivities.has(binding.agentId) ? {
          activity: this.agentActivities.get(binding.agentId)!,
        } : {}),
      }));
  }

  reportAgentWindowActivity(agentId: string, activity: Partial<AgentActivityState>): void {
    const previous = this.agentActivities.get(agentId);
    this.agentActivities.set(agentId, {
      label: activity.label ?? previous?.label ?? '',
      isRunning: activity.isRunning ?? previous?.isRunning ?? false,
      messageCount: activity.messageCount ?? previous?.messageCount ?? 0,
      unreadCount: activity.unreadCount ?? previous?.unreadCount ?? 0,
      lastMessagePreview: activity.lastMessagePreview ?? previous?.lastMessagePreview ?? '',
      updatedAt: activity.updatedAt ?? previous?.updatedAt ?? null,
    });
  }

  requestAgentWindowMessage(request: AgentWindowSendRequest): AgentThreadBinding {
    const binding = this.agentIdBindings.get(request.agentId);
    if (!binding) {
      throw new Error(`No Interpreter agent window is registered for agent_id=${JSON.stringify(request.agentId)}.`);
    }
    if (request.threadId && binding.threadId && binding.threadId !== request.threadId) {
      throw new Error(`Agent ${request.agentId} is bound to thread ${binding.threadId}, not ${request.threadId}.`);
    }

    const scope = binding.windowSessionKey
      ? { windowSessionKey: binding.windowSessionKey }
      : binding.workspacePath !== undefined
        ? { workspacePath: binding.workspacePath ?? null }
        : undefined;

    broadcastEvent('agent-tab:send-requested', {
      agentId: binding.agentId,
      threadId: binding.threadId,
      message: request.message,
      workspacePath: request.workspacePath ?? binding.workspacePath ?? null,
      messageSource: request.messageSource ?? null,
    }, scope);
    return binding;
  }

  requestAgentWindowReveal(agentId: string): AgentThreadBinding {
    const binding = this.agentIdBindings.get(agentId);
    if (!binding) {
      throw new Error(`No Interpreter agent window is registered for agent_id=${JSON.stringify(agentId)}.`);
    }

    const scope = binding.windowSessionKey
      ? { windowSessionKey: binding.windowSessionKey }
      : binding.workspacePath !== undefined
        ? { workspacePath: binding.workspacePath ?? null }
        : undefined;

    broadcastEvent('workstation:focus-tab', { id: binding.agentId }, scope);
    return binding;
  }

  requestAgentWindowStop(agentId: string): AgentThreadBinding {
    const binding = this.agentIdBindings.get(agentId);
    if (!binding) {
      throw new Error(`No Interpreter agent window is registered for agent_id=${JSON.stringify(agentId)}.`);
    }

    const scope = binding.windowSessionKey
      ? { windowSessionKey: binding.windowSessionKey }
      : binding.workspacePath !== undefined
        ? { workspacePath: binding.workspacePath ?? null }
        : undefined;

    broadcastEvent('agent-tab:stop-requested', {
      agentId: binding.agentId,
      threadId: binding.threadId,
    }, scope);
    return binding;
  }

  requestAgentWindowClose(agentId: string): AgentThreadBinding {
    const binding = this.agentIdBindings.get(agentId);
    if (!binding) {
      throw new Error(`No Interpreter agent window is registered for agent_id=${JSON.stringify(agentId)}.`);
    }

    const scope = binding.windowSessionKey
      ? { windowSessionKey: binding.windowSessionKey }
      : binding.workspacePath !== undefined
        ? { workspacePath: binding.workspacePath ?? null }
        : undefined;

    broadcastEvent('workstation:close-tab', { id: binding.agentId }, scope);
    return binding;
  }

  getWorkspaceSwitchBlockers(scope: {
    windowSessionKey?: string | null;
    nextWorkspacePath: string;
  }): WorkspaceSwitchBlocker[] {
    const blockers = new Map<string, WorkspaceSwitchBlocker>();

    const addBinding = (binding: AgentThreadBinding, threadId?: string) => {
      if (!binding.workspacePath) {
        return;
      }
      if ((binding.windowSessionKey ?? null) !== (scope.windowSessionKey ?? null)) {
        return;
      }
      if (path.resolve(binding.workspacePath) === path.resolve(scope.nextWorkspacePath)) {
        return;
      }
      if (!threadId && blockers.has(binding.callerToken)) {
        return;
      }
      blockers.set(binding.callerToken, {
        agentId: binding.agentId,
        callerToken: binding.callerToken,
        ...(threadId ? { threadId } : {}),
        workspacePath: binding.workspacePath,
      });
    };

    for (const [threadId, binding] of this.threadBindings.entries()) {
      addBinding(binding, threadId);
    }
    for (const binding of this.callerTokenBindings.values()) {
      addBinding(binding);
    }

    return Array.from(blockers.values());
  }

  disposeBinding(callerToken: string): void {
    const binding = this.callerTokenBindings.get(callerToken);
    if (!binding) {
      return;
    }

    this.callerTokenBindings.delete(callerToken);
    const currentAgentBinding = this.agentIdBindings.get(binding.agentId);
    if (currentAgentBinding?.callerToken === callerToken) {
      this.agentIdBindings.delete(binding.agentId);
      this.agentActivities.delete(binding.agentId);
    }
    for (const [threadId, threadBinding] of this.threadBindings.entries()) {
      if (threadBinding.callerToken === callerToken) {
        this.threadBindings.delete(threadId);
      }
    }
  }

  /**
   * UI reports agent execution completed
   * @param requestId The request ID
   * @param messages The full message array from the agent
   * @param error Optional error message if execution failed
   */
  onTabCompleted(requestId: string, messages: any[], error?: string, threadId?: string) {
    const request = this.pendingRequests.get(requestId);
    const createdRequest = this.createdRequests.get(requestId);
    const completionEvent: AgentTabCompletionEvent | null = request
      ? {
          agentId: request.agentId,
          callerToken: request.callerToken,
          requestId,
          startupId: this.pendingStartups.has(requestId) ? requestId : undefined,
          threadId: threadId ?? request.threadId,
          messages,
          ...(error ? { error } : {}),
        }
      : createdRequest
        ? {
            agentId: createdRequest.agentId,
            callerToken: createdRequest.callerToken,
            requestId,
            threadId: threadId ?? createdRequest.threadId,
            messages,
            ...(error ? { error } : {}),
          }
        : null;

    if (completionEvent) {
      this.createdRequests.delete(requestId);
      for (const listener of this.completionListeners) {
        try {
          listener(completionEvent);
        } catch (error) {
          console.warn('[AgentTabManager] Completion listener failed:', error);
        }
      }
    }

    if (request) {
      this.pendingRequests.delete(requestId);

      if (error) {
        request.reject(new Error(error));
      } else {
        request.resolve({
          agentId: request.agentId,
          callerToken: request.callerToken,
          startupId: this.pendingStartups.has(requestId) ? requestId : undefined,
          threadId: threadId ?? request.threadId,
          messages,
        });
      }

      console.log('[AgentTabManager] Tab completed:', { requestId, messageCount: messages.length });
    } else if (completionEvent) {
      console.log('[AgentTabManager] Tab completed:', { requestId, messageCount: messages.length });
    }
  }

  /**
   * Get all pending requests (for debugging)
   * @returns Array of pending requests (without resolve/reject functions)
   */
  getPendingRequests(scope?: {
    windowSessionKey?: string | null;
    workspacePath?: string | null;
  }): Omit<PendingAgentTabRequest, 'resolve' | 'reject'>[] {
    return Array.from(this.pendingRequests.values())
      .filter((request) => this.matchesPendingScope(request, scope))
      .map(req => ({
      requestId: req.requestId,
      agentId: req.agentId,
      callerToken: req.callerToken,
      initialMessage: req.initialMessage,
      systemPrompt: req.systemPrompt,
      workspacePath: req.workspacePath,
      targetWindowSessionKey: req.targetWindowSessionKey,
      allowedToolNames: req.allowedToolNames,
      toolProfileId: req.toolProfileId,
      ...(req.parentOwner ? { parentOwner: { ...req.parentOwner } } : {}),
      timeout: req.timeout,
      createdAt: req.createdAt,
      threadId: req.threadId,
      modelConfig: req.modelConfig,
      activate: req.activate,
      startupAttachments: req.startupAttachments,
      completionDisposition: req.completionDisposition,
    }));
  }

  /**
   * Check if a request exists
   * @param requestId The request ID
   */
  hasRequest(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  /**
   * Clear all pending requests (for testing/cleanup)
   */
  clearAll(): void {
    // Reject all pending requests
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error('Request cleared during cleanup'));
    }
    this.pendingRequests.clear();
    this.pendingStartups.clear();
    this.createdRequests.clear();
    this.threadBindings.clear();
    this.callerTokenBindings.clear();
    this.agentIdBindings.clear();
    this.agentActivities.clear();

    console.log('[AgentTabManager] Cleared all pending requests');
  }
}

// Export singleton instance
export const agentTabManager = new AgentTabManager();
