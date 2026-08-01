import { randomUUID } from 'node:crypto';
import type { InterpreterOverlayAgentMode } from '../apps/interpreter-overlay/shared/agent-mode';
import type { Bounds } from '../apps/interpreter-overlay/shared/types';
import type { ScreenElement } from '../apps/interpreter-overlay/runtime/infra/accessibility-parser/index';
import type {
  AtomicToolCall,
  ComputerBatchParams,
  ToolExecutionResult,
} from '../apps/interpreter-overlay/shared/ports';
import type {
  OverlayTargetIdentity,
  CurrentSelectionContext,
} from '../apps/interpreter-overlay/shared/target-identity';
import {
  diffTouchedWindows,
  type TouchedWindowDiff,
  type TouchedWindowObservation,
} from '../apps/interpreter-overlay/shared/touched-window-diff';
import { OverlayInvalidBatchActionError } from '../apps/interpreter-overlay/shared/tool-results';
import type { OverlayRegionContextItem } from '../apps/interpreter-overlay/shared/ipc';

export interface OverlaySessionCapturedContext {
  agentMode: InterpreterOverlayAgentMode;
  formattedText: string;
  elementCount: number;
  elements: ScreenElement[];
  screenshotBase64?: string;
  screenshotPath?: string;
  displayScaleFactor?: number;
  displayBoundsDIP?: Bounds;
  captureBoundsDIP?: Bounds;
  targetIdentity?: OverlayTargetIdentity;
  currentSelectionContext?: CurrentSelectionContext;
}

export interface OverlaySessionRecord {
  id: string;
  agentId: string;
  callerToken: string;
  workspacePath: string | null;
  windowSessionKey: string | null;
  displayId: string;
  scopeBoundsDIP: Bounds | null;
  targetContext: OverlayRegionContextItem | null;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'detached' | 'completed';
  initialContext: OverlaySessionCapturedContext;
  latestContext: OverlaySessionCapturedContext;
}

export interface OverlaySessionDebugSnapshot {
  id: string;
  agentId: string;
  callerToken: string;
  workspacePath: string | null;
  windowSessionKey: string | null;
  displayId: string;
  scopeBoundsDIP: Bounds | null;
  targetContextId: string | null;
  createdAt: number;
  updatedAt: number;
  status: OverlaySessionRecord['status'];
  initialElementCount: number;
  latestElementCount: number;
  initialCaptureBoundsDIP: Bounds | null;
  latestCaptureBoundsDIP: Bounds | null;
  initialTargetIdentityId: string | null;
  latestTargetIdentityId: string | null;
  initialCurrentSelectionId: string | null;
  latestCurrentSelectionId: string | null;
  initialCurrentSelectionGeneration: number | null;
  latestCurrentSelectionGeneration: number | null;
  hasInitialScreenshot: boolean;
  hasLatestScreenshot: boolean;
  initialScreenshotPath: string | null;
  latestScreenshotPath: string | null;
}

/**
 * computer_batch result contract (2026-07-06): per-action executor outcomes
 * plus the before/after DIFF of the windows the batch touched, computed once
 * here so every caller (builtin CLI tool, realtime voice bridge, typed
 * controller loop) inherits it. Never a full refreshed context dump.
 */
export interface OverlayComputerBatchOutcome {
  result: ToolExecutionResult | undefined;
  touchedWindowDiff: TouchedWindowDiff;
}

export interface OverlaySessionCreateOptions {
  agentId: string;
  callerToken: string;
  workspacePath?: string | null;
  windowSessionKey?: string | null;
  displayId: string;
  scopeBoundsDIP: Bounds | null;
  initialContext: OverlaySessionCapturedContext;
  targetContext?: OverlayRegionContextItem | null;
}

interface OverlayElementRefMetadata {
  element_id?: string;
  element_description?: string;
}

export interface OverlayClickRequest extends OverlayElementRefMetadata {
  x?: number;
  y?: number;
}

export interface OverlayTypeRequest extends OverlayElementRefMetadata {
  text: string;
  clear_first?: boolean;
}

export interface OverlayHotkeyRequest {
  hotkey: string;
}

export interface OverlayScrollRequest extends OverlayElementRefMetadata {
  x?: number;
  y?: number;
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface OverlayDrawingAnnotation {
  id?: string;
  label?: string;
  bounds: Bounds;
}

export interface OverlayDrawingRequest {
  annotations: OverlayDrawingAnnotation[];
}

export interface OverlaySessionDriver {
  captureContext(session: OverlaySessionRecord): Promise<OverlaySessionCapturedContext>;
  computerBatch(session: OverlaySessionRecord, request: ComputerBatchParams): Promise<ToolExecutionResult | undefined>;
  click(session: OverlaySessionRecord, request: OverlayClickRequest): Promise<void>;
  type(session: OverlaySessionRecord, request: OverlayTypeRequest): Promise<void>;
  hotkey(session: OverlaySessionRecord, request: OverlayHotkeyRequest): Promise<void>;
  scroll(session: OverlaySessionRecord, request: OverlayScrollRequest): Promise<void>;
  showDrawings(session: OverlaySessionRecord, request: OverlayDrawingRequest): Promise<void>;
  clearDrawings(session: OverlaySessionRecord): Promise<void>;
  detach(session: OverlaySessionRecord): Promise<void>;
  complete(session: OverlaySessionRecord): Promise<void>;
}

/** Hard deadline for the post-batch context recapture; see recapturePostBatchContext. */
const COMPUTER_BATCH_RECAPTURE_TIMEOUT_MS = 8_000;
let computerBatchRecaptureTimeoutMs = COMPUTER_BATCH_RECAPTURE_TIMEOUT_MS;

export function setOverlayComputerBatchRecaptureTimeoutMsForTest(ms: number | null): void {
  computerBatchRecaptureTimeoutMs = ms ?? COMPUTER_BATCH_RECAPTURE_TIMEOUT_MS;
}

class OverlaySessionManager {
  private readonly sessionsById = new Map<string, OverlaySessionRecord>();
  private readonly sessionIdByAgentId = new Map<string, string>();
  private readonly executingComputerBatchSessionIds = new Set<string>();
  private driver: OverlaySessionDriver | null = null;

  setDriver(driver: OverlaySessionDriver | null): void {
    this.driver = driver;
    if (!driver) {
      this.clearAll();
    }
  }

  clearAll(): void {
    this.sessionsById.clear();
    this.sessionIdByAgentId.clear();
    this.executingComputerBatchSessionIds.clear();
  }

  createSession(options: OverlaySessionCreateOptions): OverlaySessionRecord {
    const existingSessionId = this.sessionIdByAgentId.get(options.agentId);
    if (existingSessionId && this.sessionsById.has(existingSessionId)) {
      throw new Error('This agent already has an active overlay session.');
    }

    const conflictingSession = Array.from(this.sessionsById.values()).find(
      (session) => session.status === 'active' && session.agentId !== options.agentId,
    );
    if (conflictingSession) {
      throw new Error('Interpreter Overlay is already attached to another agent. Detach it before starting a new live overlay session.');
    }

    const now = Date.now();
    const record: OverlaySessionRecord = {
      id: `overlay-session-${randomUUID()}`,
      agentId: options.agentId,
      callerToken: options.callerToken,
      workspacePath: options.workspacePath ?? null,
      windowSessionKey: options.windowSessionKey ?? null,
      displayId: options.displayId,
      scopeBoundsDIP: options.scopeBoundsDIP,
      targetContext: options.targetContext ?? null,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      initialContext: options.initialContext,
      latestContext: options.initialContext,
    };

    this.sessionsById.set(record.id, record);
    this.sessionIdByAgentId.set(record.agentId, record.id);
    return record;
  }

  getSessionForAgent(agentId: string | undefined): OverlaySessionRecord {
    if (!agentId) {
      throw new Error('Overlay tools are only available to agents launched from Interpreter Overlay.');
    }

    const sessionId = this.sessionIdByAgentId.get(agentId);
    if (!sessionId) {
      throw new Error('This agent does not have an active overlay session.');
    }

    const session = this.sessionsById.get(sessionId);
    if (!session || session.status !== 'active') {
      this.sessionIdByAgentId.delete(agentId);
      throw new Error('This overlay session is no longer active.');
    }

    return session;
  }

  attachAgentToExistingSession(sourceAgentId: string | undefined, delegatedAgentId: string): void {
    const session = this.getSessionForAgent(sourceAgentId);
    if (this.sessionIdByAgentId.has(delegatedAgentId)) {
      throw new Error('Delegated agent already has an overlay session binding.');
    }
    this.sessionIdByAgentId.set(delegatedAgentId, session.id);
  }

  releaseDelegatedAgentSession(delegatedAgentId: string): void {
    const sessionId = this.sessionIdByAgentId.get(delegatedAgentId);
    if (!sessionId) {
      return;
    }
    const session = this.sessionsById.get(sessionId);
    if (session?.agentId === delegatedAgentId) {
      return;
    }
    this.sessionIdByAgentId.delete(delegatedAgentId);
  }

  async readContext(agentId: string | undefined): Promise<OverlaySessionCapturedContext> {
    const session = this.getSessionForAgent(agentId);
    if (this.executingComputerBatchSessionIds.has(session.id)) {
      throw new Error('A Computer Use action batch is still in progress. Wait for the computer_batch result before reading the overlay context again.');
    }
    return await this.refreshContext(session);
  }

  async screenshot(agentId: string | undefined): Promise<OverlaySessionCapturedContext> {
    const session = this.getSessionForAgent(agentId);
    if (this.executingComputerBatchSessionIds.has(session.id)) {
      throw new Error('A Computer Use action batch is still in progress. Wait for the computer_batch result before capturing the overlay screenshot again.');
    }
    return await this.refreshContext(session);
  }

  async computerBatch(agentId: string | undefined, request: ComputerBatchParams): Promise<OverlayComputerBatchOutcome> {
    const session = this.getSessionForAgent(agentId);
    this.validateComputerBatchRefs(session, request);
    const driver = this.getDriverOrThrow();
    this.executingComputerBatchSessionIds.add(session.id);
    try {
      const beforeObservation = toTouchedWindowObservation(session.latestContext);
      const result = await driver.computerBatch(session, request);
      session.latestContext = await this.recapturePostBatchContext(driver, session);
      session.updatedAt = Date.now();
      return {
        result,
        touchedWindowDiff: diffTouchedWindows(
          beforeObservation,
          toTouchedWindowObservation(session.latestContext),
        ),
      };
    } finally {
      this.executingComputerBatchSessionIds.delete(session.id);
    }
  }

  /**
   * Post-batch recapture with a hard deadline. The recapture reads fresh
   * target state (CUA get_ui_elements plus capture) after the reviewed batch
   * executed; when that read wedges it must fail loudly within seconds, not
   * stall the whole batch result behind driver-level timeouts.
   */
  private async recapturePostBatchContext(
    driver: OverlaySessionDriver,
    session: OverlaySessionRecord,
  ): Promise<OverlaySessionCapturedContext> {
    const timeoutMs = computerBatchRecaptureTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capturePromise = driver.captureContext(session);
    try {
      return await Promise.race([
        capturePromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `computer_batch actions executed, but the post-batch context recapture did not complete within ${timeoutMs}ms. `
              + 'The current selected-target state is unknown; call overlay_read_context before staging more actions.',
            ));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      // The losing capture promise may still settle later; keep its rejection
      // from surfacing as an unhandled rejection while failing loudly here.
      capturePromise.catch(() => {});
      console.error('[OverlaySessionManager] post-batch context recapture failed', {
        sessionId: session.id,
        timeoutMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async click(agentId: string | undefined, request: OverlayClickRequest): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    this.validateCurrentElementRef(session, request, 'overlay_click request');
    const driver = this.getDriverOrThrow();
    await driver.click(session, request);
    session.latestContext = await driver.captureContext(session);
    session.updatedAt = Date.now();
  }

  async type(agentId: string | undefined, request: OverlayTypeRequest): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    this.validateCurrentElementRef(session, request, 'overlay_type request');
    const driver = this.getDriverOrThrow();
    await driver.type(session, request);
    session.latestContext = await driver.captureContext(session);
    session.updatedAt = Date.now();
  }

  async hotkey(agentId: string | undefined, request: OverlayHotkeyRequest): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    await this.getDriverOrThrow().hotkey(session, request);
  }

  async scroll(agentId: string | undefined, request: OverlayScrollRequest): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    this.validateCurrentElementRef(session, request, 'overlay_scroll request');
    const driver = this.getDriverOrThrow();
    await driver.scroll(session, request);
    session.latestContext = await driver.captureContext(session);
    session.updatedAt = Date.now();
  }

  async showDrawings(agentId: string | undefined, request: OverlayDrawingRequest): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    await this.getDriverOrThrow().showDrawings(session, request);
    session.updatedAt = Date.now();
  }

  async clearDrawings(agentId: string | undefined): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    await this.getDriverOrThrow().clearDrawings(session);
    session.updatedAt = Date.now();
  }

  async detach(agentId: string | undefined): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    await this.getDriverOrThrow().detach(session);
    this.finishSession(session, 'detached');
  }

  async complete(agentId: string | undefined): Promise<void> {
    const session = this.getSessionForAgent(agentId);
    await this.getDriverOrThrow().complete(session);
    this.finishSession(session, 'completed');
  }

  getDebugSnapshotForAgent(agentId: string | undefined): OverlaySessionDebugSnapshot | null {
    if (!agentId) {
      return null;
    }

    const sessionId = this.sessionIdByAgentId.get(agentId);
    if (!sessionId) {
      return null;
    }

    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return null;
    }

    return this.toDebugSnapshot(session);
  }

  getDebugSnapshots(): OverlaySessionDebugSnapshot[] {
    return Array.from(this.sessionsById.values())
      .map((session) => this.toDebugSnapshot(session));
  }

  private finishSession(
    session: OverlaySessionRecord,
    status: OverlaySessionRecord['status'],
  ): void {
    session.status = status;
    session.updatedAt = Date.now();
    this.executingComputerBatchSessionIds.delete(session.id);
    this.sessionsById.delete(session.id);
    for (const [agentId, sessionId] of this.sessionIdByAgentId.entries()) {
      if (sessionId === session.id) {
        this.sessionIdByAgentId.delete(agentId);
      }
    }
  }

  private getDriverOrThrow(): OverlaySessionDriver {
    if (!this.driver) {
      throw new Error('Interpreter Overlay runtime is unavailable.');
    }
    return this.driver;
  }

  private async refreshContext(
    session: OverlaySessionRecord,
  ): Promise<OverlaySessionCapturedContext> {
    const context = await this.getDriverOrThrow().captureContext(session);
    session.latestContext = context;
    session.updatedAt = Date.now();
    return context;
  }

  private validateComputerBatchRefs(
    session: OverlaySessionRecord,
    request: ComputerBatchParams,
  ): void {
    for (const action of request.actions) {
      const params = getElementTargetParams(action.tool);
      if (params) {
        try {
          this.validateCurrentElementRef(session, params, `computer_batch action seq=${action.seq}`);
        } catch (error) {
          // Ref misuse rejected before anything executed: raise the typed
          // rejection so bridge result mapping reports an explicit
          // invalid-action status instead of a generic execution error.
          throw new OverlayInvalidBatchActionError(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  private validateCurrentElementRef(
    session: OverlaySessionRecord,
    params: OverlayElementRefMetadata,
    label: string,
  ): void {
    if (!params.element_id) {
      return;
    }

    const snapshot = session.latestContext.currentSelectionContext;
    if (!snapshot) {
      throw new Error(`${label} targets element_id ${JSON.stringify(params.element_id)}, but the current selected context has no element refs. Call overlay_read_context and choose a current ref before acting.`);
    }

    if (!snapshot.selectableRefs.some((ref) => ref.id === params.element_id)) {
      throw new Error(`${label} uses element_id ${JSON.stringify(params.element_id)} that is not present in the current selected context. Call overlay_read_context and choose a current element id before acting.`);
    }
  }

  private toDebugSnapshot(session: OverlaySessionRecord): OverlaySessionDebugSnapshot {
    return {
      id: session.id,
      agentId: session.agentId,
      callerToken: session.callerToken,
      workspacePath: session.workspacePath,
      windowSessionKey: session.windowSessionKey,
      displayId: session.displayId,
      scopeBoundsDIP: session.scopeBoundsDIP,
      targetContextId: session.targetContext?.id ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
      initialElementCount: session.initialContext.elementCount,
      latestElementCount: session.latestContext.elementCount,
      initialCaptureBoundsDIP: session.initialContext.captureBoundsDIP ?? session.initialContext.displayBoundsDIP ?? null,
      latestCaptureBoundsDIP: session.latestContext.captureBoundsDIP ?? session.latestContext.displayBoundsDIP ?? null,
      initialTargetIdentityId: session.initialContext.targetIdentity?.id ?? null,
      latestTargetIdentityId: session.latestContext.targetIdentity?.id ?? null,
      initialCurrentSelectionId: session.initialContext.currentSelectionContext?.id ?? null,
      latestCurrentSelectionId: session.latestContext.currentSelectionContext?.id ?? null,
      initialCurrentSelectionGeneration: session.initialContext.currentSelectionContext?.generation ?? null,
      latestCurrentSelectionGeneration: session.latestContext.currentSelectionContext?.generation ?? null,
      hasInitialScreenshot: Boolean(session.initialContext.screenshotBase64),
      hasLatestScreenshot: Boolean(session.latestContext.screenshotBase64),
      initialScreenshotPath: session.initialContext.screenshotPath ?? null,
      latestScreenshotPath: session.latestContext.screenshotPath ?? null,
    };
  }
}

/**
 * Diffable line for one observed selected-target ref. Element indexes and
 * bounds renumber/jitter on every read, so they are excluded from the diffed
 * fields; the line keeps the observed role plus the raw label's title, value,
 * and action data. This selects which observed fields the diff covers - it
 * never infers or rewrites content.
 */
function toTouchedWindowRefLine(ref: { role: string; label: string }): string {
  const label = ref.label
    .replace(/^-\s*\[\d+\]\s*/, '')
    .replace(/\s*bounds=\{[^}]*\}/, '');
  return `ref role=${JSON.stringify(ref.role)} label=${JSON.stringify(label)}`;
}

function toTouchedWindowObservation(context: OverlaySessionCapturedContext): TouchedWindowObservation {
  return {
    formattedText: context.formattedText,
    selectableRefLines: context.currentSelectionContext?.selectableRefs.map(toTouchedWindowRefLine),
  };
}

export const overlaySessionManager = new OverlaySessionManager();

function getElementTargetParams(tool: AtomicToolCall): {
  element_id?: string;
} | null {
  if (tool.name === 'hotkey') {
    return null;
  }
  return tool.params;
}
