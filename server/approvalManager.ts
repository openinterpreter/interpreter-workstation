/**
 * Approval Manager - Unified Question System
 *
 * All user interactions flow through createQuestion().
 * Simple approve/deny is just the simplest case with two options.
 *
 * NOTE(approval-flow): Central approval queue. Native runtime callbacks enter
 * through `server/utils/codexServerRequestApprovals.ts`, filesystem prompts
 * enter through `server/tools/filesystemGuard.ts`, and renderer responses enter
 * through `server/handlers/approvals.ts`. Keep idempotency, session approvals,
 * window/workspace scoping, and broadcasts single-source here.
 */

import { nanoid } from 'nanoid';
import { broadcastEvent, type BroadcastScope } from './handlers/broadcast';
import { agentTabManager } from './agentTabManager';
import { getToolCallMetadata } from './utils/codexMcpBridge';
import { getCurrentWorkspace } from './utils/workspace';
import { getCurrentWindowSessionKey, getWindowSessionWorkspace } from './utils/windowSessions';
import { getBooleanUISettingSync } from './configStore';
import type {
  ApprovalOwnerKind,
  ApprovalOwnerSnapshot,
  Question,
  QuestionRequest,
  QuestionRequestInternal,
  QuestionResponse,
  QuestionResult,
} from '../shared/types/approval';

type ApprovalVisibilityContext = {
  windowSessionKey: string | null;
  workspacePath: string | null;
};

const OWNER_COLOR_PALETTE = [
  '#2563eb',
  '#0891b2',
  '#16a34a',
  '#ca8a04',
  '#dc2626',
  '#9333ea',
  '#c2410c',
  '#0f766e',
];

class ApprovalManager {
  private requests: Map<string, QuestionRequestInternal> = new Map();
  /** id → timestamp for idempotency (prevents double-submit) */
  private resolvedIds: Map<string, number> = new Map();
  // NOTE(victor): 0 = wait indefinitely. All approvals are user-facing
  // interactions that must wait for a human response. External callers
  // (e.g. Codex tool_timeout_sec) provide the safety-net timeout.
  private defaultTimeout: number = 0;
  private autoApproveMode: boolean = false;
  /** Structured owner/tool keys for session-based approvals (in-memory only, cleared on restart) */
  private sessionApprovalKeys: Set<string> = new Set();

  setAutoApprove(enabled: boolean): void {
    this.autoApproveMode = enabled;
    if (enabled) {
      console.log('[ApprovalManager] Auto-approve mode ENABLED');
    }
  }

  isAutoApproveEnabled(): boolean {
    return this.autoApproveMode;
  }

  /**
   * Check if a tool is approved for the session for a given agent.
   * Session approvals are in-memory only and cleared on app restart.
   */
  isApprovedForSession(agentId: string | undefined, toolName: string, serverId?: string): boolean {
    const owner = this.buildOwnerSnapshot({
      agentId,
      ownerWindowSessionKey: getCurrentWindowSessionKey() ?? null,
      ownerWorkspacePath: getCurrentWorkspace() ?? null,
      timestamp: Date.now(),
    });
    return this.sessionApprovalKeys.has(this.buildSessionApprovalKey(owner, serverId, toolName));
  }

  /**
   * Grant session-wide approval for a tool for a given agent.
   * All future calls to this tool from this agent will be auto-approved until app restart.
   */
  grantSessionApproval(request: QuestionRequestInternal): void {
    if (!request.owner) return;
    this.sessionApprovalKeys.add(this.buildSessionApprovalKey(request.owner, request.serverId, request.toolName));
    console.log(`[ApprovalManager] Granted session approval for ${request.toolName} to owner ${request.owner.identity.agentId ?? request.owner.approvalOwnerKind}`);
  }

  /**
   * Clean up resolved IDs older than 1 hour
   */
  private cleanupResolvedIds(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [id, ts] of this.resolvedIds) {
      if (ts < oneHourAgo) this.resolvedIds.delete(id);
    }
  }

  /**
   * Strip internal fields for public consumption
   */
  private toPublicRequest(request: QuestionRequestInternal): QuestionRequest {
    const {
      resolve,
      reject,
      ownerWindowSessionKey,
      ownerWorkspacePath,
      ...publicFields
    } = request;
    return publicFields;
  }

  private getApprovalOwnerKind(agentId: string | undefined): ApprovalOwnerKind {
    if (!agentId) {
      return 'cli';
    }
    if (agentId.startsWith('overlay-agent-')) {
      return 'overlay-agent';
    }
    if (agentId.startsWith('codex-agent-') || agentId.startsWith('subagent-')) {
      return 'hidden-agent';
    }
    if (agentId.startsWith('extension-action-')) {
      return 'extension-action';
    }
    return 'normal-agent';
  }

  private getOwnerDisplayName(ownerKind: ApprovalOwnerKind, identity: ApprovalOwnerSnapshot['identity']): string {
    if (ownerKind === 'cli') {
      return 'Interpreter CLI';
    }
    if (ownerKind === 'overlay-agent') {
      return 'Interpreter Overlay';
    }
    if (ownerKind === 'hidden-agent') {
      return identity.toolProfileId ? `Hidden agent (${identity.toolProfileId})` : 'Hidden agent';
    }
    if (ownerKind === 'extension-action') {
      return identity.toolProfileId ? `Interpreter extension (${identity.toolProfileId})` : 'Interpreter extension';
    }
    if (identity.toolProfileId) {
      return `Interpreter agent (${identity.toolProfileId})`;
    }
    return 'Interpreter agent';
  }

  private getOwnerColor(ownerKind: ApprovalOwnerKind, identity: ApprovalOwnerSnapshot['identity']): string {
    const stableKey = [
      ownerKind,
      identity.agentId,
      identity.threadId,
      identity.windowSessionKey,
      identity.workspacePath,
      identity.toolProfileId,
    ].filter(Boolean).join('|');
    let hash = 0;
    for (let i = 0; i < stableKey.length; i += 1) {
      hash = ((hash << 5) - hash + stableKey.charCodeAt(i)) | 0;
    }
    return OWNER_COLOR_PALETTE[Math.abs(hash) % OWNER_COLOR_PALETTE.length]!;
  }

  private buildOwnerSnapshot(input: {
    agentId?: string;
    ownerWindowSessionKey: string | null;
    ownerWorkspacePath: string | null;
    timestamp: number;
  }): ApprovalOwnerSnapshot {
    const binding = input.agentId
      ? agentTabManager.getBindingForAgentId(input.agentId)
      : undefined;
    const allowedToolNames = binding?.allowedToolNames && binding.allowedToolNames.length > 0
      ? Array.from(new Set(binding.allowedToolNames))
      : undefined;
    const approvalOwnerKind = this.getApprovalOwnerKind(input.agentId);
    const identity: ApprovalOwnerSnapshot['identity'] = {
      agentId: binding?.agentId ?? input.agentId ?? null,
      ...(binding?.threadId ? { threadId: binding.threadId } : {}),
      windowSessionKey: binding?.windowSessionKey ?? input.ownerWindowSessionKey ?? null,
      workspacePath: binding?.workspacePath ?? input.ownerWorkspacePath ?? null,
      ...(allowedToolNames ? { allowedToolNames } : {}),
      ...(binding?.toolProfileId ? { toolProfileId: binding.toolProfileId } : {}),
      ...(binding?.parentOwner ? { parentOwner: { ...binding.parentOwner } } : {}),
    };
    return {
      approvalOwnerKind,
      capturedAt: input.timestamp,
      displayName: this.getOwnerDisplayName(approvalOwnerKind, identity),
      color: this.getOwnerColor(approvalOwnerKind, identity),
      identity,
    };
  }

  private buildSessionApprovalKey(
    owner: ApprovalOwnerSnapshot,
    serverId: string | undefined,
    toolName: string,
  ): string {
    const inheritedOwner = owner.approvalOwnerKind === 'hidden-agent'
      ? owner.identity.parentOwner
      : undefined;
    return JSON.stringify({
      ownerKind: inheritedOwner?.approvalOwnerKind ?? owner.approvalOwnerKind,
      agentId: inheritedOwner?.agentId ?? owner.identity.agentId,
      windowSessionKey: inheritedOwner?.windowSessionKey ?? owner.identity.windowSessionKey,
      workspacePath: inheritedOwner?.workspacePath ?? owner.identity.workspacePath,
      toolProfileId: inheritedOwner?.toolProfileId ?? owner.identity.toolProfileId ?? null,
      serverId: serverId ?? null,
      toolName,
    });
  }

  private getVisibilityContext(scope?: BroadcastScope): ApprovalVisibilityContext {
    if (scope?.windowSessionKey) {
      return {
        windowSessionKey: scope.windowSessionKey,
        workspacePath: getWindowSessionWorkspace({ sessionKey: scope.windowSessionKey }),
      };
    }

    if (Object.prototype.hasOwnProperty.call(scope ?? {}, 'workspacePath')) {
      return {
        windowSessionKey: null,
        workspacePath: scope?.workspacePath ?? null,
      };
    }

    return {
      windowSessionKey: getCurrentWindowSessionKey(),
      workspacePath: getCurrentWorkspace(),
    };
  }

  private isRequestVisibleToContext(
    request: QuestionRequestInternal,
    context: ApprovalVisibilityContext,
  ): boolean {
    if (request.ownerWindowSessionKey) {
      return request.ownerWindowSessionKey === context.windowSessionKey;
    }

    if (request.ownerWorkspacePath !== undefined) {
      return request.ownerWorkspacePath === context.workspacePath;
    }

    return true;
  }

  private getBroadcastScopeForRequest(request: QuestionRequestInternal): BroadcastScope | undefined {
    if (request.ownerWindowSessionKey) {
      return { windowSessionKey: request.ownerWindowSessionKey };
    }

    if (request.ownerWorkspacePath !== undefined) {
      return { workspacePath: request.ownerWorkspacePath ?? null };
    }

    return undefined;
  }

  private getRequestsForContext(
    context: ApprovalVisibilityContext,
    toolCallId?: string,
  ): QuestionRequest[] {
    return Array.from(this.requests.values())
      .filter((request) => !toolCallId || request.toolCallId === toolCallId)
      .filter((request) => this.isRequestVisibleToContext(request, context))
      .map((request) => this.toPublicRequest(request));
  }

  private isSessionApprovalRequest(request: QuestionRequestInternal): boolean {
    return request.context?.sessionAware === true;
  }

  private isApprovalResultApproved(result: QuestionResult): boolean {
    return result.answers['0'] === 'approve';
  }

  private isLowRiskMediaPermissionCard(context: unknown): boolean {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      return false;
    }

    const permissionCard = (context as { permissionCard?: unknown }).permissionCard;
    if (!permissionCard || typeof permissionCard !== 'object' || Array.isArray(permissionCard)) {
      return false;
    }

    const card = permissionCard as { intent?: unknown; risk?: unknown };
    return card.intent === 'image-generation' && card.risk === 'low';
  }

  private shouldAutoApproveLowRiskMediaCard(context: unknown): boolean {
    return getBooleanUISettingSync('autoApproveLowRiskMediaCards')
      && this.isLowRiskMediaPermissionCard(context);
  }

  private sessionApprovalMatches(
    request: QuestionRequestInternal,
    source: QuestionRequestInternal,
  ): boolean {
    return request.id !== source.id
      && request.toolName === source.toolName
      && request.serverId === source.serverId
      && Boolean(request.owner)
      && Boolean(source.owner)
      && this.buildSessionApprovalKey(request.owner!, request.serverId, request.toolName)
        === this.buildSessionApprovalKey(source.owner!, source.serverId, source.toolName)
      && this.isSessionApprovalRequest(request);
  }

  private buildReplacementScopeKey(request: QuestionRequestInternal): string | null {
    if (!request.replacementKey || !request.owner) {
      return null;
    }

    return JSON.stringify({
      ownerKind: request.owner.approvalOwnerKind,
      agentId: request.owner.identity.agentId,
      threadId: request.owner.identity.threadId ?? null,
      windowSessionKey: request.owner.identity.windowSessionKey,
      workspacePath: request.owner.identity.workspacePath,
      toolProfileId: request.owner.identity.toolProfileId ?? null,
      serverId: request.serverId,
      toolName: request.toolName,
      replacementKey: request.replacementKey,
    });
  }

  private findReplacementCandidate(request: QuestionRequestInternal): QuestionRequestInternal | null {
    const replacementScopeKey = this.buildReplacementScopeKey(request);
    if (!replacementScopeKey) {
      return null;
    }

    return Array.from(this.requests.values()).find((pending) => (
      pending.id !== request.id
      && this.buildReplacementScopeKey(pending) === replacementScopeKey
    )) ?? null;
  }

  private resolveRequest(request: QuestionRequestInternal, result: QuestionResult): void {
    this.resolvedIds.set(request.id, Date.now());
    this.cleanupResolvedIds();

    request.resolve(result);
    this.requests.delete(request.id);
    const scope = this.getBroadcastScopeForRequest(request);

    const isApprove = request.isSimpleApproval && this.isApprovalResultApproved(result);
    broadcastEvent('approvals:resolved', {
      id: request.id,
      approved: request.isSimpleApproval ? isApprove : undefined,
      answers: result.answers,
      skipped: result.skipped,
      timedOut: result.timedOut,
    }, scope);
    this.emitListChanged(scope);
  }

  private supersedeRequest(previous: QuestionRequestInternal, next: QuestionRequestInternal): void {
    this.resolvedIds.set(previous.id, Date.now());
    this.cleanupResolvedIds();
    this.requests.delete(previous.id);

    previous.resolve({
      answers: {},
      superseded: true,
      supersededBy: next.id,
    });

    const scope = this.getBroadcastScopeForRequest(next);
    broadcastEvent('approvals:replaced', {
      previousId: previous.id,
      approval: this.toPublicRequest(next),
    }, scope);
  }

  private emitListChanged(scope?: BroadcastScope): void {
    const approvals = this.getRequestsForContext(this.getVisibilityContext(scope));
    broadcastEvent('approvals:list-changed', {
      count: approvals.length,
      approvals,
    }, scope);
  }

  private attachToolThreadId(context: unknown, toolCallId?: string): unknown {
    if (
      context
      && typeof context === 'object'
      && !Array.isArray(context)
      && typeof (context as { threadId?: unknown }).threadId === 'string'
    ) {
      return context;
    }

    const threadId = getToolCallMetadata(toolCallId)?.threadId;
    if (!threadId) {
      return context;
    }

    if (context == null) {
      return { threadId };
    }

    if (typeof context === 'object' && !Array.isArray(context)) {
      return { ...(context as Record<string, unknown>), threadId };
    }

    return context;
  }

  /**
   * Core method - all interactions flow through this
   * Returns QuestionResult with answers + metadata (skipped, timedOut, etc.)
   *
   * NOTE(approval-flow): Creation stores the pending promise, captures the
   * current window/workspace owner, and broadcasts `approvals:created` plus
   * `approvals:list-changed`. Runtime-native callers in
   * `server/utils/codexServerRequestApprovals.ts` keep the app-server responder
   * waiting until `respond()` resolves.
   */
  async createQuestion(
    toolName: string,
    serverId: string,
    questions: Question[],
    context: any,
    timeout: number,
    toolCallId?: string,
    isSimpleApproval: boolean = false,
    agentId?: string,
    replacementKey?: string
  ): Promise<QuestionResult> {
    // Auto-approve: return first option for each question
    // Never auto-approve ask_user_question — its purpose is user interaction
    if (this.autoApproveMode && !isSimpleApproval && toolName !== 'ask_user_question') {
      console.log('[ApprovalManager] Auto-approving:', toolName, 'from', serverId);
      const autoResponse: QuestionResponse = {};
      (questions ?? []).forEach((q, idx) => {
        const opts = q.options ?? [];
        if (opts.length > 0) {
          autoResponse[String(idx)] = q.multiSelect ? [opts[0].value] : opts[0].value;
        }
      });
      return { answers: autoResponse };
    }

    const id = nanoid();
    const timestamp = Date.now();
    const enrichedContext = this.attachToolThreadId(context, toolCallId);
    if (isSimpleApproval && this.shouldAutoApproveLowRiskMediaCard(enrichedContext)) {
      return { answers: { '0': 'approve' } };
    }
    /**
     * NOTE(interpreter-cli-mcp): Approval broadcasts are scoped from this async owner
     * context. MCP callers that already know a tab owner must enter this method
     * through `runWithWindowSessionOverride()` and `runWithWorkspaceOverride()`;
     * passing only `agentId` is not enough in a multi-window or multi-workspace
     * session.
     *
     * Trail: [scoped MCP bridge](./utils/codexMcpBridge.ts) ->
     * [CLI tool path](./handlers/interpreterCli.ts) ->
     * [renderer owner resolver](../src/hooks/usePendingApprovalsByAgent.ts).
     */
    const ownerWindowSessionKey = getCurrentWindowSessionKey();
    const ownerWorkspacePath = getCurrentWorkspace();
    const owner = this.buildOwnerSnapshot({
      agentId,
      ownerWindowSessionKey: ownerWindowSessionKey ?? null,
      ownerWorkspacePath: ownerWorkspacePath ?? null,
      timestamp,
    });

    return new Promise((resolve, reject) => {
      const request: QuestionRequestInternal = {
        id,
        toolName,
        serverId,
        questions,
        context: enrichedContext,
        timestamp,
        toolCallId,
        replacementKey,
        isSimpleApproval,
        agentId,
        owner,
        ownerWindowSessionKey: ownerWindowSessionKey ?? undefined,
        ownerWorkspacePath: ownerWorkspacePath ?? undefined,
        resolve,
        reject,
      };

      const previousRequest = this.findReplacementCandidate(request);
      this.requests.set(id, request);
      const scope = this.getBroadcastScopeForRequest(request);

      if (previousRequest) {
        this.supersedeRequest(previousRequest, request);
      } else {
        broadcastEvent('approvals:created', { approval: this.toPublicRequest(request) }, scope);
      }
      this.emitListChanged(scope);

      // Timeout handling -- pass 0 to wait indefinitely (no timeout).
      const timeoutMs = timeout ?? this.defaultTimeout;
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.requests.has(id)) {
            // Track as resolved before deleting (for idempotency)
            this.resolvedIds.set(id, Date.now());
            this.cleanupResolvedIds();
            this.requests.delete(id);
            broadcastEvent('approvals:timeout', { id }, scope);
            this.emitListChanged(scope);
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * Convenience wrapper - creates a simple approve/deny question
   * This is what existing tools use
   */
  async createApproval(
    toolName: string,
    serverId: string,
    args: any,
    timeout: number,
    toolCallId?: string,
    agentId?: string
  ): Promise<boolean> {
    // In auto-approve mode, immediately approve without creating an approval request
    // Excludes test_approval which is specifically for testing the approval UI flow.
    // fs_guard:delete always requires explicit user confirmation.
    if (this.autoApproveMode && toolName !== 'test_approval' && toolName !== 'fs_guard:delete') {
      console.log('[ApprovalManager] Auto-approving:', toolName, 'from', serverId);
      return true;
    }

    const result = await this.createQuestion(
      toolName,
      serverId,
      [
        {
          question: 'Do you approve this action?',
          options: [
            { label: 'Approve', value: 'approve' },
            { label: 'Deny', value: 'deny' },
          ],
          allowOther: false,
        },
      ],
      args, // Pass tool args as context to display
      timeout,
      toolCallId,
      true, // isSimpleApproval flag
      agentId
    );

    // Type-safe extraction from QuestionResult
    const answer = result.answers['0'];
    return typeof answer === 'string' && answer === 'approve';
  }

  /**
   * Create a session-aware approval with custom warning message.
   * Returns { approved, mode } where mode indicates 'once' or 'session'.
   * Automatically grants session approval if mode is 'session' and approved.
   */
  async createSessionAwareApproval(
    toolName: string,
    serverId: string,
    args: any,
    warningMessage: string,
    timeout: number,
    toolCallId?: string,
    agentId?: string
  ): Promise<{ approved: boolean; mode?: 'once' | 'session' }> {
    // Check if already approved for session
    if (this.isApprovedForSession(agentId, toolName, serverId)) {
      console.log(`[ApprovalManager] Session approval exists for ${toolName}, auto-approving`);
      return { approved: true, mode: 'session' };
    }

    // In auto-approve mode, immediately approve
    if (this.autoApproveMode && toolName !== 'test_approval') {
      console.log('[ApprovalManager] Auto-approving:', toolName, 'from', serverId);
      return { approved: true, mode: 'once' };
    }

    const result = await this.createQuestion(
      toolName,
      serverId,
      [
        {
          question: 'Do you approve this action?',
          options: [
            { label: 'Approve', value: 'approve' },
            { label: 'Deny', value: 'deny' },
          ],
          allowOther: false,
        },
      ],
      { ...args, warning: warningMessage, sessionAware: true }, // Include warning + session metadata in context
      timeout,
      toolCallId,
      true, // isSimpleApproval flag - but we'll handle session mode in UI
      agentId
    );

    const answer = result.answers['0'];
    const approved = typeof answer === 'string' && answer === 'approve';
    const mode = result.approvalMode || 'once';

    return { approved, mode };
  }

  /**
   * Respond to any request with full result (answers + metadata)
   * Returns success status for idempotency (prevents double-submit from chat + approvals panel)
   *
   * NOTE(approval-flow): Resolution is the UI/API join point. It rejects double
   * submits, resolves the original promise, drops the pending request, broadcasts
   * `approvals:resolved`, and applies any session grant to matching pending
   * requests.
   */
  respond(id: string, result: QuestionResult): { success: boolean; error?: string } {
    // Idempotent: already resolved returns failure
    if (this.resolvedIds.has(id)) {
      return { success: false, error: 'Already resolved' };
    }

    const request = this.requests.get(id);
    if (!request) {
      return { success: false, error: 'Request not found' };
    }

    const shouldGrantSession = request.isSimpleApproval
      && this.isSessionApprovalRequest(request)
      && result.approvalMode === 'session'
      && this.isApprovalResultApproved(result);

    if (shouldGrantSession) {
      this.grantSessionApproval(request);
    }

    this.resolveRequest(request, result);

    if (shouldGrantSession) {
      const sessionResult: QuestionResult = {
        answers: { '0': 'approve' },
        approvalMode: 'session',
      };
      for (const pending of Array.from(this.requests.values())) {
        if (this.sessionApprovalMatches(pending, request)) {
          this.resolveRequest(pending, sessionResult);
        }
      }
    }

    return { success: true };
  }

  /**
   * Convenience shortcuts for simple approvals
   * These just call respond() with the appropriate answer
   */
  approve(id: string): void {
    this.respond(id, { answers: { '0': 'approve' } });
  }

  deny(id: string): void {
    this.respond(id, { answers: { '0': 'deny' } });
  }

  /**
   * Get all pending requests (without resolve/reject)
   */
  getRequests(toolCallId?: string): QuestionRequest[] {
    const context = this.getVisibilityContext();
    if (context.windowSessionKey === null && context.workspacePath === null) {
      return Array.from(this.requests.values())
        .filter((request) => !toolCallId || request.toolCallId === toolCallId)
        .map((request) => this.toPublicRequest(request));
    }

    return this.getRequestsForContext(context, toolCallId);
  }

  /**
   * Backwards compatibility - alias for getRequests
   */
  getApprovals(toolCallId?: string): QuestionRequest[] {
    return this.getRequests(toolCallId);
  }

  getApprovalsForOverlayAgents(options: {
    agentIds: Iterable<string>;
    threadId?: string | null;
  }): QuestionRequest[] {
    const threadId = options.threadId?.trim() || null;
    const allowedAgentIds = new Set(options.agentIds);
    if (allowedAgentIds.size === 0 && !threadId) {
      return [];
    }
    return Array.from(this.requests.values())
      .filter((request) => {
        if (request.agentId && allowedAgentIds.has(request.agentId)) {
          return true;
        }
        return Boolean(
          threadId
          && request.context
          && typeof request.context === 'object'
          && !Array.isArray(request.context)
          && (request.context as { threadId?: unknown }).threadId === threadId,
        );
      })
      .map((request) => this.toPublicRequest(request));
  }

  hasApproval(id: string): boolean {
    return this.requests.has(id);
  }

  clearAll(): void {
    for (const request of this.requests.values()) {
      request.reject(new Error('Request cleared during cleanup'));
    }
    this.requests.clear();
    broadcastEvent('approvals:list-changed', { count: 0, approvals: [] });
    console.log('[ApprovalManager] Cleared all approvals');
  }
}

// Export singleton instance
export const approvalManager = new ApprovalManager();

// Re-export types for convenience
export type {
  Question,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
} from '../shared/types/approval';
