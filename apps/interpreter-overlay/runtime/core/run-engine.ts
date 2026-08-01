import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  VisionPort,
  CapturePort,
  AgentPort,
  AutomationPort,
  UIPort,
  InputPort,
  Clock,
  Ids,
  AgentRun,
  AgentRunResult,
  AgentToolBatchPreview,
  ToolCall,
  AtomicToolCall,
  ComputerBatchParams,
  NativeCuaAppWindowTarget,
  NativeCuaElementTarget,
  NativeCuaPointTarget,
  StructuredScreenSnapshot,
  ToolExecutionResult,
} from '../../shared/ports.js';
import type {
  Run,
  Action,
  Bounds,
  Point,
  DisplayInfo,
  RelativeBBox,
  UIState,
  ToolName,
  ClickParams,
  TypeParams,
  HotkeyParams,
  ScrollParams,
  ScreenshotParams,
} from '../../shared/types.js';
import type { OverlayScreenQueryRegion, OverlayUserAttachment } from '../../shared/ipc.js';
import type { OverlayTargetIdentity } from '../../shared/target-identity.js';
import { invalidActionToolResult, textToolResult } from '../../shared/tool-results.js';
import {
  INTERPRETER_OVERLAY_AX_MODE as OVERLAY_AX_MODE,
  INTERPRETER_OVERLAY_AGENT_MODE,
  INTERPRETER_OVERLAY_VISION_MODE as OVERLAY_VISION_MODE,
} from '../../shared/agent-mode.js';
import type { InterpreterOverlayAgentMode } from '../../shared/agent-mode.js';
import {
  boundsContainsPoint,
  boundsToRelativeBBoxInViewport,
  getDisplayViewport,
  intersectBounds,
  relativeBBoxToBoundsInViewport,
  toLocalBounds,
} from '../../shared/scope.js';
import { sampleCenterPixel } from '../../shared/pixel-sampler.js';
import { isLikelyFieldLabel, resolveTypingTarget as resolveTypingTargetElement } from '../../../../shared/interpreter-overlay-typing.js';
import type { CuaAccessPolicyMode } from '../../../../shared/cuaAccessPolicy.js';
import {
  findVerifiedPointForElement,
  type VerifiedPointResult,
} from '../infra/verified-point-helper.js';
import {
  ensureUniqueElementIds,
  normalizeStructuredContext,
} from './structured-context.js';

const DROPDOWN_OPEN_SETTLE_DELAY_MS = 60;
const DROPDOWN_VALUE_VERIFY_TIMEOUT_MS = 4000;
const DROPDOWN_VALUE_VERIFY_INTERVAL_MS = 90;
const TYPE_TARGET_FOCUS_VERIFY_DELAY_MS = 40;
const TYPE_TARGET_MAX_FOCUS_ATTEMPTS = 4;
const TYPE_TARGET_LABEL_MATCH_MIN_IOU = 0.35;
const TYPE_TARGET_GEOMETRY_MATCH_MIN_IOU = 0.72;
const TYPE_TARGET_CONTAINMENT_MATCH_MIN_RATIO = 0.82;
const TYPE_TARGET_CENTER_FRACTION = 0.5;
const TYPE_TARGET_LEFT_PROBE_FRACTION = 0.33;
const TYPE_TARGET_RIGHT_PROBE_FRACTION = 0.85;
const TYPE_TARGET_UPPER_PROBE_FRACTION = 0.28;
const CONTROL_INDICATOR_MAX_SIZE = 28;
const DEFAULT_SCROLL_AMOUNT = 5;
const PAGE_SCROLL_AMOUNT = DEFAULT_SCROLL_AMOUNT * 2;
const SCROLL_POINT_TARGET_SIZE_DIP = 28;
const VISION_BATCH_SCREENSHOT_SETTLE_DELAY_MS = 60;
const AX_BATCH_REFRESH_SETTLE_DELAY_MS = 250;
const AX_BATCH_REFRESH_TIMEOUT_MS = 4000;
const SCREENSHOT_BOUNDARY_TIMEOUT_MS = OVERLAY_AX_MODE && process.platform === 'win32' ? 60000 : 15000;
const VISION_SCREENSHOT_FILE_DIR = path.join(os.tmpdir(), 'interpreter-overlay-vision-cache');
// AX mode stays accessibility-tree-only. Non-mac platforms run the
// screenshot-driven runtime until they have native AX support.
const OVERLAY_VISION_ENABLED = OVERLAY_VISION_MODE;
const OVERLAY_VISION_DISABLED = !OVERLAY_VISION_ENABLED;
export function isCoordinateScrollEnabledForMode(
  overlayMode: InterpreterOverlayAgentMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return overlayMode === 'vision'
  || env.INTERPRETER_OVERLAY_ENABLE_COORDINATE_SCROLL === '1'
  || env.INTERPRETER_OVERLAY_DISABLE_COORDINATE_SCROLL === '0';
}

const OVERLAY_COORDINATE_SCROLL_ENABLED = isCoordinateScrollEnabledForMode(INTERPRETER_OVERLAY_AGENT_MODE);
const OVERLAY_COORDINATE_SCROLL_DISABLED = !OVERLAY_COORDINATE_SCROLL_ENABLED;
// Keep verified-point off unless explicitly enabled. The raw click/type path is
// the default runtime contract, and verified-point is only for targeted debug.
const OVERLAY_VERIFIED_POINT_ENABLED =
  process.env.INTERPRETER_OVERLAY_ENABLE_VERIFIED_POINT === '1'
  || process.env.INTERPRETER_OVERLAY_DISABLE_VERIFIED_POINT === '0';
const OVERLAY_VERIFIED_POINT_DISABLED = !OVERLAY_VERIFIED_POINT_ENABLED;

export function shouldUseStructuredScreenshotBoundary(
  requestedTextOnly: boolean | undefined,
  overlayMode: InterpreterOverlayAgentMode,
): boolean {
  return overlayMode === 'ax' && (requestedTextOnly ?? true);
}

export function getScopedScrollForHotkey(
  hotkey: string,
): { direction: 'up' | 'down'; amount: number } | null {
  const normalizedHotkey = hotkey.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalizedHotkey === 'pagedown') {
    return { direction: 'down', amount: PAGE_SCROLL_AMOUNT };
  }
  if (normalizedHotkey === 'pageup') {
    return { direction: 'up', amount: PAGE_SCROLL_AMOUNT };
  }
  return null;
}

export function isScopedFocusedControlHotkeyAllowed(hotkey: string): boolean {
  const tokens = hotkey
    .trim()
    .toLowerCase()
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
  const primary = tokens.find((token) => !['ctrl', 'control', 'cmd', 'command', 'meta', 'alt', 'option', 'shift'].includes(token));
  if (!primary) {
    return false;
  }

  const hasPrimaryModifier = tokens.some((token) => ['ctrl', 'control', 'cmd', 'command', 'meta'].includes(token));
  if (!hasPrimaryModifier) {
    return [
      'enter',
      'return',
      'tab',
      'esc',
      'escape',
      'up',
      'down',
      'left',
      'right',
      'arrowup',
      'arrowdown',
      'arrowleft',
      'arrowright',
    ].includes(primary);
  }
  return hasPrimaryModifier && ['a', 'c', 'x', 'v'].includes(primary);
}

// ============================================================
// SCREEN PARSING ENGINE SELECTION (one-line switch)
// ============================================================
// Option 1: OCR-based parsing (original method, respects OCR_ALGORITHM env var)
// import { performSegmentedOCR, type ScreenElement } from '../infra/ocr-segmentation/index.js';

// Option 2: Accessibility API-based parsing (faster, more accurate)
import { getFocusedSelectionContext, performSegmentedOCR, type ScreenElement } from '../infra/accessibility-parser/index.js';
import { parseWindowsUiaElementId } from '../infra/windows-uia.js';
// ============================================================

function isWindowsUiaElementId(elementId: string | undefined): boolean {
  return Boolean(elementId && parseWindowsUiaElementId(elementId));
}

interface RunEngineConfig {
  MAX_TOOL_CALLS_PER_RUN: number;
  conversationAppendMs: number;
  autoAccept?: boolean; // Debug mode: auto-accept actions without waiting for Ctrl
  // Settings bridge: resolves the Computer Use control policy mode for the
  // active target app so a staged computer_batch can auto-accept when the
  // user already granted "don't ask" (mode 'all') in Settings > Permissions.
  resolveControlPolicyMode?: (appName: string) => Promise<CuaAccessPolicyMode>;
}

interface RunEngineDeps {
  vision: VisionPort;
  capture: CapturePort;
  agent: AgentPort;
  auto: AutomationPort;
  ui: UIPort;
  input: InputPort;
  clock: Clock;
  ids: Ids;
  config: RunEngineConfig;
}

interface AbsoluteBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StartRunOptions {
  display?: DisplayInfo;
  scopeBounds?: Bounds | null;
  targetPid?: number | null;
  targetWindowId?: number | string | null;
  systemAddendum?: string;
  userAttachments?: OverlayUserAttachment[];
  screenRegions?: OverlayScreenQueryRegion[];
  initialStructuredContext?: {
    formattedText: string;
    elements: ScreenElement[];
  };
  onStructuredElements?: (elements: ScreenElement[]) => void;
}

interface ImageSize {
  width: number;
  height: number;
}

interface AttachedToolSessionContextOptions {
  display: DisplayInfo;
  scopeBounds?: Bounds | null;
  targetPid?: number | null;
  targetWindowId?: number | string | null;
  targetIdentity?: OverlayTargetIdentity | null;
  formattedText: string;
  elements: ScreenElement[];
  screenshotBase64?: string | null;
}

interface PendingComputerBatchActionTiming {
  seq: number;
  tool: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
}

interface PendingComputerBatch {
  toolSeq: number;
  previewBatchId: string;
  actionSeqs: number[];
  actionIds: string[];
  startedAt: number;
  resolve: (result: ToolExecutionResult) => void;
  actionTimings: PendingComputerBatchActionTiming[];
}

interface AttachedToolDispatchOptions {
  display?: DisplayInfo;
  scopeBounds?: Bounds | null;
}

export interface AttachedToolCallResult {
  success: boolean;
  error?: string;
  result?: ToolExecutionResult;
}

export interface RunEngineDebugContext {
  initialUserText: string | null;
  latestStructuredText: string | null;
  latestStructuredSnapshot: StructuredScreenSnapshot | null;
}

export class RunEngine {
  private vision: VisionPort;
  private capture: CapturePort;
  private agent: AgentPort;
  private auto: AutomationPort;
  private ui: UIPort;
  private input: InputPort;
  private clock: Clock;
  private ids: Ids;
  private config: RunEngineConfig;

  private currentRun: Run | null = null;
  private currentAgentRun: AgentRun | null = null;
  private abortController: AbortController | null = null;
  private conversationId: string | null = null;
  private conversationExpiresAt: number = 0;
  private toolResolvers: Map<number, (result: ToolExecutionResult) => void> = new Map();
  private isProcessingApproval: boolean = false;
  private errorDismissTimer: NodeJS.Timeout | null = null;
  private readonly agentDoneCallbacks = new Set<(result: AgentRunResult) => void>();
  private ctrlPressed: boolean = false;
  private shiftPressed: boolean = false;

  // Batch enrichment for parallel vision detection
  private enrichmentQueue: Action[] = [];
  private enrichmentTimer: NodeJS.Timeout | null = null;

  // Client-side screenshot cache for OCR reuse
  private screenshotCache: Map<string, string> = new Map();
  private screenshotFileCache: Map<string, string> = new Map();

  // Initial screen OCR text (captured when Ctrl pressed, used when agent starts)
  private initialScreenOcrText: string | null = null;
  private latestStructuredText: string | null = null;
  private latestStructuredSnapshot: StructuredScreenSnapshot | null = null;
  private screenQueryRegions = new Map<string, OverlayScreenQueryRegion>();
  private debugInitialUserText: string | null = null;
  private debugLatestStructuredText: string | null = null;
  private debugLatestStructuredSnapshot: StructuredScreenSnapshot | null = null;

  // Form field store (keyed by unique ID, refreshed on new screenshot)
  private formFieldStore: Map<string, ScreenElement> = new Map();
  private focusedMenuElementId: string | null = null;
  private autoAcceptLoopRunning: boolean = false;
  private sessionAutoAccept: boolean = false;
  private acceptAllThroughSeq: number | null = null;
  private queuedApprovalAfterProcessing: boolean = false;
  private pendingTerminalResult: { agentRun: AgentRun; result: AgentRunResult } | null = null;
  private finalizingTerminalResult: boolean = false;
  private computerBatchExecuting: boolean = false;
  private pendingComputerBatch: PendingComputerBatch | null = null;

  // Current capture target for normalizing bboxes and constraining automation
  private activeDisplay: DisplayInfo | null = null;
  private activeViewport: Bounds | null = null;
  private activeTargetPid: number | null = null;
  private activeTargetWindowId: number | string | null = null;
  private activeTargetIdentity: OverlayTargetIdentity | null = null;
  private attachedToolSessionActive: boolean = false;

  // Current screenshot payload (for sampling field colors)
  private screenshotBase64: string | null = null;
  private screenshotImageSize: ImageSize | null = null;
  private currentScreenshotWarmup: Promise<void> | null = null;
  private workingAnchorAction: Action | null = null;
  private lastVisionInteractionPoint: { x: number; y: number } | null = null;

  constructor(deps: RunEngineDeps) {
    this.vision = deps.vision;
    this.capture = deps.capture;
    this.agent = deps.agent;
    this.auto = deps.auto;
    this.ui = deps.ui;
    this.input = deps.input;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.config = deps.config;

    // Register UI listeners
    this.ui.onAccept(() => this.handleAcceptAllRequest());
    this.ui.onAcceptAll(() => this.handleAcceptAllRequest());
    this.ui.onAcceptAllSession(() => this.handleAcceptAllForSessionRequest());
    this.ui.onReject(() => this.cancelUser());

    // Register input listeners
    this.input.onCtrlDown(() => {});  // Handled by main.ts
    this.input.onCtrlUp(() => {});    // Handled by main.ts
    this.input.onEsc(() => this.cancelUser());

    this.ui.set({
      pill: { kind: 'hidden' },
      active: null,
      ghosts: [],
      ctrlPressed: false,
      shiftPressed: false,
      executing: false,
    });
  }

  async beginRecording(options?: StartRunOptions): Promise<void> {
    const beginStart = Date.now();
    console.log(`[RunEngine] [TIMING] ===== beginRecording START at ${beginStart} =====`);
    try {
      const display = options?.display ?? this.capture.getActiveDisplay();
      const viewport = options?.scopeBounds
        ? intersectBounds(options.scopeBounds, display.boundsDIP)
        : { ...display.boundsDIP };
      if (!viewport) {
        throw new Error('Selected scope is outside the active display');
      }

      // Create new run
      const runId = this.ids.uuid();
      this.currentRun = {
        id: runId,
        startedAt: this.clock.now(),
        monitorId: display.id,
        actions: [],
        conversationId: this.getOrCreateConversationId(),
        currentScreenshotId: `run-${runId}/batch-0`,
        toolCallCount: 0,
      };
      this.workingAnchorAction = null;

      console.log(`[RunEngine] Starting recording with run ID: ${runId}, screenshot ID: ${this.currentRun.currentScreenshotId}`);

      // Update UI to recording mode FIRST (before async operations that might fail)
      this.updateUI();

      this.activeDisplay = display;
      this.activeViewport = viewport;
      this.activeTargetPid = options?.targetPid ?? null;
      this.activeTargetWindowId = options?.targetWindowId ?? null;
      this.activeTargetIdentity = null;
      this.screenQueryRegions = new Map(
        (options?.screenRegions ?? []).map((region) => [region.id, region]),
      );

      this.formFieldStore.clear();
      this.focusedMenuElementId = null;
      this.lastVisionInteractionPoint = null;
      this.screenshotBase64 = null;
      this.screenshotImageSize = null;
      this.initialScreenOcrText = null;
      this.latestStructuredText = null;
      this.latestStructuredSnapshot = null;
      this.debugLatestStructuredText = null;
      this.debugLatestStructuredSnapshot = null;
      this.debugInitialUserText = null;
      this.currentScreenshotWarmup = this.warmInitialScreenshot(this.currentRun.currentScreenshotId).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (OVERLAY_AX_MODE) {
          console.warn(`[RunEngine] Initial screenshot warmup failed in AX mode: ${errorMsg}`);
          return;
        }
        throw error;
      });

      if (OVERLAY_AX_MODE) {
        // Run OCR immediately only in AX mode to provide initial context to the agent.
        const ocrStart = Date.now();
        let normalizedContext = options?.initialStructuredContext ?? null;
        if (normalizedContext) {
          console.log('[RunEngine] [TIMING] Reusing pre-captured accessibility parse for initial screen...');
        } else {
          console.log('[RunEngine] [TIMING] Running accessibility parse on initial screen...');
          const segmentedResult = await performSegmentedOCR(Buffer.alloc(0), display.scaleFactor, {
            scopeBounds: viewport,
            targetPid: options?.targetPid ?? null,
            targetWindowId: options?.targetWindowId ?? null,
          });
          normalizedContext = normalizeStructuredContext(
            segmentedResult.formattedText,
            segmentedResult.elements,
          );
        }
        this.initialScreenOcrText = normalizedContext.formattedText;
        this.latestStructuredText = normalizedContext.formattedText;
        this.debugLatestStructuredText = normalizedContext.formattedText;
        console.log(`[RunEngine] [TIMING] Accessibility parse completed in ${Date.now() - ocrStart}ms, extracted ${this.initialScreenOcrText.length} characters`);
        this.replaceFormFieldStore(normalizedContext.elements);
        this.latestStructuredSnapshot = this.createStructuredSnapshot(
          normalizedContext.formattedText,
          normalizedContext.elements,
        );
        this.debugLatestStructuredSnapshot = this.latestStructuredSnapshot;
        options?.onStructuredElements?.(normalizedContext.elements);
      }

      // Debug file writes removed - logs are saved to grader/runs/ directories

      console.log(`[RunEngine] [TIMING] ===== beginRecording END, total time: ${Date.now() - beginStart}ms =====`);
    } catch (error) {
      console.error('[RunEngine] beginRecording failed:', error);

      // Clean up the failed run
      this.resetRunState();

      // Show error to user
      const errorMsg = error instanceof Error ? error.message : 'Failed to start recording';
      this.showError(errorMsg);

      throw error; // Re-throw so main.ts knows it failed
    }
  }

  private async warmInitialScreenshot(screenshotId: string): Promise<void> {
    const screenshotStart = Date.now();
    console.log(`[RunEngine] [TIMING] Warming screenshot cache for ${screenshotId}...`);

    if (!this.activeDisplay) {
      throw new Error('No active display available for screenshot warmup');
    }

    const { base64 } = await this.capture.captureDisplay(this.activeDisplay, this.getCaptureBoundsForMode());

    if (this.currentRun?.currentScreenshotId !== screenshotId) {
      return;
    }

    this.screenshotBase64 = base64;
    this.screenshotImageSize = this.readPngImageSize(base64);
    this.screenshotCache.set(screenshotId, base64);

    if (OVERLAY_VISION_MODE) {
      this.screenshotCache.set(`${screenshotId}:cached`, 'false');
      console.log(
        `[RunEngine] [TIMING] Screenshot warmup completed in ${Date.now() - screenshotStart}ms (vision mode local only)`,
      );
      return;
    }

    try {
      this.materializeScreenshotFile(screenshotId, base64);
      await this.vision.cache(screenshotId, base64);
      if (this.currentRun?.currentScreenshotId !== screenshotId) {
        return;
      }
      this.screenshotCache.set(`${screenshotId}:cached`, 'true');
      console.log(`[RunEngine] [TIMING] Screenshot warmup completed in ${Date.now() - screenshotStart}ms (cached remotely)`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      if (this.currentRun?.currentScreenshotId !== screenshotId) {
        return;
      }
      this.screenshotCache.set(`${screenshotId}:cached`, 'false');
      console.warn(`[RunEngine] Screenshot warmup cache failed: ${errorMsg}`);
      console.log(`[RunEngine] [TIMING] Screenshot warmup completed in ${Date.now() - screenshotStart}ms (local only)`);
    }
  }

  private async awaitCurrentScreenshotBase64(): Promise<string> {
    if (!this.currentRun) {
      throw new Error('No active run');
    }

    const screenshotId = this.currentRun.currentScreenshotId;
    const screenshotBase64 = this.screenshotCache.get(screenshotId);
    if (screenshotBase64) {
      return screenshotBase64;
    }

    if (this.screenshotBase64) {
      this.screenshotCache.set(screenshotId, this.screenshotBase64);
      return this.screenshotBase64;
    }

    if (screenshotId.endsWith('/batch-0') && this.currentScreenshotWarmup) {
      await this.currentScreenshotWarmup;
    }

    const warmedScreenshotBase64 = this.screenshotCache.get(screenshotId);
    if (warmedScreenshotBase64) {
      return warmedScreenshotBase64;
    }

    if (this.screenshotBase64) {
      this.screenshotCache.set(screenshotId, this.screenshotBase64);
      return this.screenshotBase64;
    }

    if (!this.activeDisplay) {
      throw new Error('No active display available for screenshot capture');
    }

    const { base64 } = await this.capture.captureDisplay(this.activeDisplay, this.getCaptureBoundsForMode());
    if (!this.currentRun || this.currentRun.currentScreenshotId !== screenshotId) {
      throw new Error(`Screenshot ${screenshotId} is unavailable`);
    }

    this.screenshotBase64 = base64;
    this.screenshotImageSize = this.readPngImageSize(base64);
    this.screenshotCache.set(screenshotId, base64);
    this.screenshotCache.set(`${screenshotId}:cached`, 'false');
    return base64;
  }

  private sanitizeScreenshotIdForFilename(screenshotId: string): string {
    return screenshotId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }

  private materializeScreenshotFile(screenshotId: string, base64: string): string {
    const cached = this.screenshotFileCache.get(screenshotId);
    if (cached && fs.existsSync(cached)) {
      return cached;
    }

    fs.mkdirSync(VISION_SCREENSHOT_FILE_DIR, { recursive: true });
    const filePath = path.join(
      VISION_SCREENSHOT_FILE_DIR,
      `${this.sanitizeScreenshotIdForFilename(screenshotId)}.png`,
    );

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    }

    this.screenshotFileCache.set(screenshotId, filePath);
    return filePath;
  }

  private async awaitCurrentScreenshotPath(screenshotId?: string): Promise<string> {
    const effectiveScreenshotId = screenshotId ?? this.currentRun?.currentScreenshotId;
    if (!effectiveScreenshotId) {
      throw new Error('No active screenshot ID');
    }

    const base64 = await this.awaitCurrentScreenshotBase64();
    return this.materializeScreenshotFile(effectiveScreenshotId, base64);
  }

  private async detectWithLocalFallback(
    screenshotId: string,
    query: string,
    preferredInlineScreenshotBase64?: string,
  ): Promise<{ bbox: RelativeBBox } | { text: string }> {
    const localScreenshotBase64 = preferredInlineScreenshotBase64 || this.screenshotCache.get(screenshotId);
    const localScreenshotPath = localScreenshotBase64
      ? this.materializeScreenshotFile(screenshotId, localScreenshotBase64)
      : this.screenshotFileCache.get(screenshotId);

    try {
      return await this.vision.detect(
        screenshotId,
        query,
        preferredInlineScreenshotBase64,
        preferredInlineScreenshotBase64 ? undefined : localScreenshotPath,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const looksLikeRemoteCacheFailure = /screenshot not cached/i.test(message)
        || /vision detect failed:\s*5\d\d\b/i.test(message);
      if (!preferredInlineScreenshotBase64 && localScreenshotBase64 && looksLikeRemoteCacheFailure) {
        console.warn(
          `[RunEngine] Vision remote detect failed for ${screenshotId}; retrying with inline screenshot bytes (${message})`,
        );
        this.screenshotCache.set(`${screenshotId}:cached`, 'false');
        return this.vision.detect(screenshotId, query, localScreenshotBase64, localScreenshotPath);
      }
      throw error;
    }
  }

  setLoading(): void {
    if (!this.currentRun) {
      throw new Error('No active recording to set loading');
    }

    // Enter loading state immediately when Ctrl is released, before transcript is ready.
    this.ui.set({
      pill: { kind: 'loading' },
      active: null,
      ghosts: [],
      ctrlPressed: this.ctrlPressed,
      shiftPressed: this.shiftPressed,
      executing: false,
    });
  }

  async endRecording(
    userText: string,
    options?: {
      systemAddendum?: string;
      userAttachments?: OverlayUserAttachment[];
      screenRegions?: OverlayScreenQueryRegion[];
    },
  ): Promise<void> {
    const endStart = Date.now();
    console.log(`[RunEngine] [TIMING] ===== endRecording START at ${endStart} =====`);

    if (!this.currentRun) {
      throw new Error('No active recording to end');
    }

    // Create abort controller for this run
    this.abortController = new AbortController();

    // Prepend initial screen OCR text to provide context only for AX mode.
    let fullUserText = `<user_request>
${userText}
</user_request>`;
    if (OVERLAY_AX_MODE && this.initialScreenOcrText) {
      fullUserText = `${this.initialScreenOcrText}

${fullUserText}`;
      console.log(`[RunEngine] Prepended ${this.initialScreenOcrText.length} characters of OCR context to user message`);
      this.initialScreenOcrText = null; // Clear after use
    }
    this.debugInitialUserText = fullUserText;

    const initialImageCapture = OVERLAY_VISION_MODE && this.currentRun
      ? {
          screenshotId: this.currentRun.currentScreenshotId,
          screenshotBase64: await this.awaitCurrentScreenshotBase64(),
        }
      : undefined;

    // Start agent run with full context
    const agentStart = Date.now();
    console.log('[RunEngine] [TIMING] Starting agent...');
    this.currentAgentRun = await this.agent.start(
      this.currentRun.conversationId,
      fullUserText,
      this.abortController.signal,
      {
        initialSnapshot: OVERLAY_AX_MODE
          ? (this.latestStructuredSnapshot || undefined)
          : undefined,
        initialImageCapture,
        computerEnvironment: process.platform === 'win32'
          ? 'windows'
          : process.platform === 'darwin'
            ? 'mac'
            : 'linux',
        systemAddendum: options?.systemAddendum,
        userAttachments: options?.userAttachments,
        screenRegions: options?.screenRegions,
      },
    );
    console.log(`[RunEngine] [TIMING] Agent started in ${Date.now() - agentStart}ms`);

    // Register callbacks
    console.log(`[RunEngine] [TIMING] Registering agent callbacks...`);
    const agentRun = this.currentAgentRun;

    agentRun.onBatchPreview((preview) => {
      if (this.currentAgentRun !== agentRun) {
        console.warn(
          `[RunEngine] Ignoring stale act.preview for inactive agent run batch=${preview.batchId}`,
        );
        return;
      }
      console.log(
        `[RunEngine] [TIMING] *** onBatchPreview callback fired: batch=${preview.batchId} actions=${preview.actions.length} at ${Date.now()} ***`,
      );
      void this.handleBatchPreview(preview);
    });

    agentRun.onToolCall((tool, seq, resolve) => {
      if (this.currentAgentRun !== agentRun) {
        console.warn(
          `[RunEngine] Ignoring stale tool.call for inactive agent run seq=${seq} tool=${tool.name}`,
        );
        resolve(textToolResult('Agent run is no longer active.'));
        return;
      }
      console.log(`[RunEngine] [TIMING] *** onToolCall callback fired: ${tool.name} seq=${seq} at ${Date.now()} ***`);
      void this.dispatchToolCall(tool, seq, resolve);
    });

    agentRun.onDone((result) => {
      if (this.currentAgentRun !== agentRun) {
        console.warn('[RunEngine] Ignoring stale onDone for inactive agent run');
        return;
      }
      console.log(`[RunEngine] [TIMING] *** onDone callback fired at ${Date.now()} ***`);
      this.handleAgentDone(agentRun, result);
    });

    console.log(`[RunEngine] [TIMING] ===== endRecording END, total time: ${Date.now() - endStart}ms =====`);

    // Set pill to loading (after currentAgentRun is set)
    this.updateUI();
  }

  private getActiveViewportOrThrow(): Bounds {
    if (!this.activeViewport) {
      throw new Error('No active viewport available');
    }

    return this.activeViewport;
  }

  private getActionBySeq(seq: number): Action | null {
    if (!this.currentRun) {
      return null;
    }

    return this.currentRun.actions.find((action) => action.seq === seq) ?? null;
  }

  private sortCurrentActions(): void {
    this.currentRun?.actions.sort((left, right) => left.seq - right.seq);
  }

  private nextActionSeq(): number {
    if (!this.currentRun || this.currentRun.actions.length === 0) {
      return 1;
    }

    return Math.max(...this.currentRun.actions.map((action) => action.seq)) + 1;
  }

  private async handleBatchPreview(preview: AgentToolBatchPreview): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    const createdActions: Action[] = [];

    for (const item of preview.actions) {
      if (item.tool.name === 'computer_batch') {
        continue;
      }
      if (this.getActionBySeq(item.seq)) {
        continue;
      }

      const previewTool = item.tool;
      const action: Action = {
        id: this.ids.uuid(),
        seq: item.seq,
        tool: previewTool.name,
        params: previewTool.params,
        previewBatchId: preview.batchId,
        dispatched: false,
      };
      this.currentRun.actions.push(action);
      createdActions.push(action);
    }

    if (createdActions.length === 0) {
      this.updateUI(false, null, 'batch-preview-empty');
      return;
    }

    this.sortCurrentActions();
    this.applyVisionTypingAnchors(createdActions);
    await this.enrichPreviewActions(createdActions);
    this.updateUI(false, null, 'batch-preview');
  }

  private applyVisionTypingAnchors(actions: Action[]): void {
    if (!OVERLAY_VISION_MODE || !this.currentRun || actions.length === 0) {
      return;
    }

    const sortedActions = [...this.currentRun.actions].sort((left, right) => left.seq - right.seq);
    for (const action of actions) {
      if (action.tool !== 'type' || !this.typeActionUsesFocusedControl(action) || action.bbox) {
        continue;
      }

      const anchorAction = [...sortedActions]
        .reverse()
        .find((candidate) => candidate.seq < action.seq && !!candidate.bbox);
      if (!anchorAction?.bbox) {
        continue;
      }

      action.bbox = { ...anchorAction.bbox };
      action.centerColor = anchorAction.centerColor;
      action.resolvedLabel = action.resolvedLabel ?? anchorAction.resolvedLabel;
    }
  }

  private async enrichPreviewActions(actions: Action[]): Promise<void> {
    if (!this.currentRun || actions.length === 0) {
      return;
    }

    const samplingScreenshotBase64 = await this.captureSamplingScreenshotBase64();
    await Promise.all(actions.map(async (action) => {
      await this.tryPreviewEnrichAction(action, samplingScreenshotBase64);
    }));
  }

  private async tryPreviewEnrichAction(
    action: Action,
    samplingScreenshotBase64: string | null,
  ): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    if (OVERLAY_VISION_MODE) {
      const directVisionPoint = this.getVisionCoordinatePoint(action);
      if (directVisionPoint && !action.bbox) {
        const params = action.params as ClickParams | ScrollParams;
        action.bbox = this.buildPointTargetBBox(params.x!, params.y!);
        action.centerColor = samplingScreenshotBase64
          ? sampleCenterPixel(samplingScreenshotBase64, action.bbox) ?? undefined
          : undefined;
        return;
      }
    }

    const elementTarget = this.getActionElementTarget(action);
    if (!elementTarget) {
      return;
    }

    let { elementId, query } = elementTarget;

    if (action.tool === 'type' && !elementId && !query && this.focusedMenuElementId) {
      elementId = this.focusedMenuElementId;
      action.params = {
        ...(action.params as TypeParams),
        element_id: elementId,
      };
    }

    if (elementId && this.formFieldStore.has(elementId) && this.activeViewport) {
      const field = this.formFieldStore.get(elementId)!;
      if (action.tool === 'scroll') {
        const scopedMatchedFieldBounds = this.getScopedElementBBox(field);
        if (scopedMatchedFieldBounds) {
          const relativeBbox = this.toScopedRelativeBBox(scopedMatchedFieldBounds);
          action.bbox = relativeBbox;
          action.resolvedLabel = field.label;
          action.currentValue = field.value;
          action.centerColor = samplingScreenshotBase64
            ? sampleCenterPixel(samplingScreenshotBase64, relativeBbox) ?? undefined
            : undefined;
        }
        return;
      }

      const descriptionMismatch = this.getElementDescriptionMismatch(action, field, query, elementId);
      if (descriptionMismatch) {
        action.decision = 'system_cancelled';
        action.error = descriptionMismatch;
        return;
      }

      const applied = this.tryApplyInstantMatch({
        action,
        field,
        query,
        samplingScreenshotBase64,
        detectStart: Date.now(),
        elementId,
      });
      if (applied) {
        return;
      }
    }

    if (action.dispatched && elementId && !query) {
      action.decision = 'system_cancelled';
      action.error = `Element with id "${elementId}" not found in the latest screen context. Re-read the screen and use a current element id.`;
      return;
    }

    const descriptionMatch = this.findUniqueElementByDescription(query, action.tool);
    if (descriptionMatch && this.activeViewport) {
      const matchedField = action.tool === 'type'
        ? this.resolveTypingTarget(descriptionMatch)
        : descriptionMatch;
      const scopedMatchedFieldBounds = this.getScopedElementBBox(matchedField);
      if (!scopedMatchedFieldBounds) {
        return;
      }

      const relativeBbox = this.toScopedRelativeBBox(scopedMatchedFieldBounds);
      action.bbox = relativeBbox;
      action.resolvedLabel = matchedField.label || descriptionMatch.label;
      action.currentValue = matchedField.value ?? descriptionMatch.value;
      action.centerColor = samplingScreenshotBase64
        ? sampleCenterPixel(samplingScreenshotBase64, relativeBbox) ?? undefined
        : undefined;
      return;
    }

    if (!query || OVERLAY_VISION_DISABLED) {
      if (action.dispatched && query && OVERLAY_VISION_DISABLED) {
        action.decision = 'system_cancelled';
        action.error = this.buildVisionDisabledMessage(query, elementId);
      }
      return;
    }

    try {
      const remotelyCached = this.screenshotCache.get(`${this.currentRun.currentScreenshotId}:cached`) === 'true';
      const screenshotBase64 = remotelyCached ? undefined : this.screenshotCache.get(this.currentRun.currentScreenshotId);
      const result = await this.detectWithLocalFallback(
        this.currentRun.currentScreenshotId,
        query,
        screenshotBase64,
      );
      if ('bbox' in result) {
        action.bbox = result.bbox;
        action.centerColor = samplingScreenshotBase64
          ? sampleCenterPixel(samplingScreenshotBase64, result.bbox) ?? undefined
          : undefined;
      }
    } catch (error) {
      console.warn(
        `[RunEngine] Preview enrichment failed for action ${action.seq}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private hasScopedViewport(): boolean {
    if (!this.activeDisplay || !this.activeViewport) {
      return false;
    }

    return (
      this.activeViewport.x !== this.activeDisplay.boundsDIP.x
      || this.activeViewport.y !== this.activeDisplay.boundsDIP.y
      || this.activeViewport.width !== this.activeDisplay.boundsDIP.width
      || this.activeViewport.height !== this.activeDisplay.boundsDIP.height
    );
  }

  private toScopedRelativeBBox(bounds: AbsoluteBBox): import('../../shared/types.js').RelativeBBox {
    return boundsToRelativeBBoxInViewport(bounds, this.getActiveViewportOrThrow());
  }

  private buildPointTargetBBox(x: number, y: number): import('../../shared/types.js').RelativeBBox {
    const viewport = this.getActiveViewportOrThrow();
    const useNormalized = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    const imageSize = this.screenshotImageSize;
    const centerX = useNormalized
      ? viewport.x + (viewport.width * x)
      : imageSize
        ? viewport.x + ((x / imageSize.width) * viewport.width)
        : viewport.x + (x / (this.activeDisplay?.scaleFactor ?? 1));
    const centerY = useNormalized
      ? viewport.y + (viewport.height * y)
      : imageSize
        ? viewport.y + ((y / imageSize.height) * viewport.height)
        : viewport.y + (y / (this.activeDisplay?.scaleFactor ?? 1));
    const bounds = {
      x: centerX - (SCROLL_POINT_TARGET_SIZE_DIP / 2),
      y: centerY - (SCROLL_POINT_TARGET_SIZE_DIP / 2),
      width: SCROLL_POINT_TARGET_SIZE_DIP,
      height: SCROLL_POINT_TARGET_SIZE_DIP,
    };

    return this.toScopedRelativeBBox(intersectBounds(bounds, viewport) ?? bounds);
  }

  private buildDirectPointTargetBBox(x: number, y: number): import('../../shared/types.js').RelativeBBox {
    const viewport = this.getActiveViewportOrThrow();
    const centerX = x;
    const centerY = y;
    const bounds = {
      x: centerX - (SCROLL_POINT_TARGET_SIZE_DIP / 2),
      y: centerY - (SCROLL_POINT_TARGET_SIZE_DIP / 2),
      width: SCROLL_POINT_TARGET_SIZE_DIP,
      height: SCROLL_POINT_TARGET_SIZE_DIP,
    };

    return this.toScopedRelativeBBox(intersectBounds(bounds, viewport) ?? bounds);
  }

  private attachVisionAnchorBBoxFromPoint(
    action: Action,
    point: { x: number; y: number } | null,
  ): void {
    if (!OVERLAY_VISION_MODE || action.bbox || !point) {
      return;
    }

    action.bbox = this.buildDirectPointTargetBBox(point.x, point.y);
  }

  private getVisionCoordinatePoint(
    action: Action,
  ): { x: number; y: number } | null {
    if (!OVERLAY_VISION_MODE) {
      return null;
    }

    if (action.tool !== 'click' && action.tool !== 'scroll') {
      return null;
    }

    const params = action.params as ClickParams | ScrollParams;
    if (typeof params.x !== 'number' || typeof params.y !== 'number') {
      return null;
    }

    const display = this.activeDisplay ?? this.capture.getActiveDisplay();
    const viewport = this.getActiveImageViewport();
    const useNormalized = params.x >= 0 && params.x <= 1 && params.y >= 0 && params.y <= 1;
    const imageSize = this.screenshotImageSize;
    if (useNormalized) {
      const normalizedX = Math.min(1, Math.max(0, params.x));
      const normalizedY = Math.min(1, Math.max(0, params.y));
      return this.toScreenPointFromImagePoint(
        normalizedX * viewport.width,
        normalizedY * viewport.height,
      );
    }

    if (imageSize && imageSize.width > 0 && imageSize.height > 0) {
      const clampedImageX = Math.min(
        imageSize.width - 1,
        Math.max(0, params.x),
      );
      const clampedImageY = Math.min(
        imageSize.height - 1,
        Math.max(0, params.y),
      );
      return this.toScreenPointFromImagePoint(clampedImageX, clampedImageY);
    }

    const scaleFactor = display.scaleFactor ?? 1;
    const screenViewport = this.getActiveViewportOrThrow();
    return {
      x: Math.min(
        screenViewport.x + screenViewport.width - 1,
        Math.max(screenViewport.x, screenViewport.x + (params.x / scaleFactor)),
      ),
      y: Math.min(
        screenViewport.y + screenViewport.height - 1,
        Math.max(screenViewport.y, screenViewport.y + (params.y / scaleFactor)),
      ),
    };
  }

  private getCaptureBoundsForMode(): Bounds | undefined {
    return this.activeViewport ?? undefined;
  }

  private getScreenshotCaptureBoundsForRegion(region: OverlayScreenQueryRegion): Bounds {
    if (!this.activeDisplay) {
      throw new Error('No active display available for screen region capture');
    }
    const viewport = intersectBounds(region.bounds, this.activeDisplay.boundsDIP);
    if (!viewport) {
      throw new Error(`Screen region "${region.id}" is outside the active display`);
    }
    return viewport;
  }

  private getActiveImageViewport(): Bounds {
    const viewport = this.getActiveViewportOrThrow();
    const imageSize = this.screenshotImageSize;
    if (!imageSize || imageSize.width <= 0 || imageSize.height <= 0) {
      return { x: 0, y: 0, width: viewport.width, height: viewport.height };
    }

    return { x: 0, y: 0, width: imageSize.width, height: imageSize.height };
  }

  private toScreenPointFromImagePoint(imageX: number, imageY: number): Point {
    const viewport = this.getActiveViewportOrThrow();
    const imageViewport = this.getActiveImageViewport();
    const clampedX = Math.min(imageViewport.width - 1, Math.max(0, imageX));
    const clampedY = Math.min(imageViewport.height - 1, Math.max(0, imageY));

    return {
      x: viewport.x + ((clampedX / imageViewport.width) * viewport.width),
      y: viewport.y + ((clampedY / imageViewport.height) * viewport.height),
    };
  }

  private toAutomationPoint(point: Point, display: DisplayInfo): Point {
    void display;
    return point;
  }

  private toAutomationPointOrNull(point: Point | null, display: DisplayInfo): Point | null {
    return point ? this.toAutomationPoint(point, display) : null;
  }

  private readPngImageSize(base64: string): ImageSize | null {
    try {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length < 24) {
        return null;
      }
      const isPng = buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4e
        && buffer[3] === 0x47;
      if (!isPng) {
        return null;
      }
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    } catch {
      return null;
    }
  }

  private getActionElementTarget(action: Action): { elementId?: string; query?: string } | null {
    if (action.tool === 'click') {
      const params = action.params as ClickParams;
      return { elementId: params.element_id, query: params.element_description };
    }

    if (action.tool === 'type') {
      const params = action.params as TypeParams;
      return { elementId: params.element_id, query: params.element_description };
    }

    if (action.tool === 'scroll') {
      const params = action.params as ScrollParams;
      return { elementId: params.element_id, query: params.element_description };
    }

    return null;
  }

  private scrollActionNeedsEnrichment(action: Action): boolean {
    if (action.tool !== 'scroll') {
      return false;
    }

    const params = action.params as ScrollParams;
    return Boolean(params.element_id || params.element_description);
  }

  private clickActionHasDirectPoint(action: Action): boolean {
    if (action.tool !== 'click') {
      return false;
    }
    const params = action.params as ClickParams;
    return typeof params.x === 'number' && typeof params.y === 'number';
  }

  private typeActionUsesFocusedControl(action: Action): boolean {
    if (action.tool !== 'type') {
      return false;
    }
    const params = action.params as TypeParams;
    return !params.element_id && !params.element_description;
  }

  private actionIsReviewableWithoutBBox(action: Action): boolean {
    if (action.tool === 'type') {
      return this.typeActionUsesFocusedControl(action);
    }

    return false;
  }

  private actionNeedsEnrichmentBeforeReview(action: Action): boolean {
    if (action.tool !== 'click' && action.tool !== 'type' && action.tool !== 'scroll') {
      return false;
    }

    if (this.actionIsReviewableWithoutBBox(action)) {
      return false;
    }

    return !action.bbox;
  }

  private validateAndPrepareClickAction(action: Action): string | null {
    const params = action.params as ClickParams;
    const hasCoords = typeof params.x === 'number' || typeof params.y === 'number';
    const hasCompleteCoords = typeof params.x === 'number' && typeof params.y === 'number';
    const hasElementTarget = Boolean(params.element_id || params.element_description);

    if (hasCoords && !hasCompleteCoords) {
      return 'click action requires both x and y when targeting a coordinate';
    }

    if (!hasElementTarget && !hasCompleteCoords) {
      return 'click action requires element_id/element_description or x/y target coordinates';
    }

    if (hasCompleteCoords) {
      if (!Number.isFinite(params.x!) || !Number.isFinite(params.y!)) {
        return 'click x and y must be finite numbers';
      }

      if (OVERLAY_VISION_MODE) {
        if (params.x! < 0 || params.y! < 0) {
          return 'click x and y must be non-negative screenshot coordinates';
        }
      } else if (params.x! < 0 || params.x! > 1 || params.y! < 0 || params.y! > 1) {
        return 'click x and y must be normalized viewport coordinates between 0 and 1';
      }

      if (!hasElementTarget) {
        action.bbox = this.buildPointTargetBBox(params.x!, params.y!);
      }
    }

    return null;
  }

  private buildVisionDisabledMessage(query: string, elementId?: string): string {
    if (elementId) {
      return `Element "${elementId}" did not resolve safely for "${query}". Vision fallback is disabled in this run. Re-read the latest accessibility tree and choose a visible webpage element instead of browser chrome or guessed coordinates.`;
    }
    return `No safe visible element match was found for "${query}". Vision fallback is disabled in this run. Re-read the latest accessibility tree and choose a visible webpage element instead of browser chrome or guessed coordinates.`;
  }

  private validateAndPrepareScrollAction(action: Action): string | null {
    const params = action.params as ScrollParams;
    const hasCoords = typeof params.x === 'number' || typeof params.y === 'number';
    const hasCompleteCoords = typeof params.x === 'number' && typeof params.y === 'number';
    const hasElementTarget = Boolean(params.element_id || params.element_description);
    const hasDirection = params.direction === 'up'
      || params.direction === 'down'
      || params.direction === 'left'
      || params.direction === 'right';

    if (!hasDirection) {
      return 'scroll action requires direction: up, down, left, or right';
    }

    if (params.amount !== undefined && (!Number.isFinite(params.amount) || params.amount === 0)) {
      return 'scroll amount must be a non-zero number when provided';
    }

    if (hasCoords && !hasCompleteCoords) {
      return 'scroll action requires both x and y when targeting a coordinate';
    }

    if (OVERLAY_COORDINATE_SCROLL_DISABLED && hasCoords) {
      return 'scroll coordinate targets are disabled in this run; use element_id or element_description';
    }

    if (OVERLAY_VISION_MODE && !hasCompleteCoords) {
      return 'scroll action requires x and y target coordinates in vision mode';
    }

    if (!hasElementTarget && !hasCompleteCoords) {
      return 'scroll action requires element_id/element_description or x/y target coordinates';
    }

    if (hasCompleteCoords) {
      if (!Number.isFinite(params.x!) || !Number.isFinite(params.y!)) {
        return 'scroll x and y must be finite numbers';
      }

      if (OVERLAY_VISION_MODE) {
        if (params.x! < 0 || params.y! < 0) {
          return 'scroll x and y must be non-negative screenshot coordinates';
        }
      } else if (params.x! < 0 || params.x! > 1 || params.y! < 0 || params.y! > 1) {
        return 'scroll x and y must be normalized viewport coordinates between 0 and 1';
      }

      if (!hasElementTarget) {
        action.bbox = this.buildPointTargetBBox(params.x!, params.y!);
      }
    }

    return null;
  }

  private validateAndPrepareHotkeyAction(action: Action): string | null {
    const params = action.params as Partial<HotkeyParams>;
    const hotkey = typeof params.hotkey === 'string' ? params.hotkey.trim() : '';

    if (!hotkey) {
      return 'hotkey action requires a non-empty hotkey string';
    }

    action.params = {
      ...params,
      hotkey,
    } as HotkeyParams;
    return null;
  }

  private toScopedSnapshotElement(element: ScreenElement): ScreenElement | null {
    const clipped = intersectBounds(element.bbox, this.getActiveViewportOrThrow());
    if (!clipped) {
      return null;
    }

    return {
      ...element,
      bbox: toLocalBounds(clipped, this.getActiveViewportOrThrow()),
    };
  }

  private getScopedElementBBox(element: ScreenElement): AbsoluteBBox | null {
    return intersectBounds(element.bbox, this.getActiveViewportOrThrow());
  }

  private createStructuredSnapshot(
    formattedText: string,
    elements: ScreenElement[],
  ): StructuredScreenSnapshot {
    return {
      formattedText,
      elements: elements
        .map((element) => this.toScopedSnapshotElement(element))
        .filter((element): element is ScreenElement => element !== null),
      focusedMenuElementId: this.focusedMenuElementId,
    };
  }

  private boundsEqual(left: Bounds | null, right: Bounds | null): boolean {
    if (!left || !right) {
      return left === right;
    }

    return left.x === right.x
      && left.y === right.y
      && left.width === right.width
      && left.height === right.height;
  }

  private applyStructuredContextToState(
    formattedText: string,
    elements: ScreenElement[],
  ): StructuredScreenSnapshot {
    const isMenuOverlayOnly = this.isMenuOverlayOnlyContext(elements);
    const refreshedElements = ensureUniqueElementIds(isMenuOverlayOnly
      ? this.mergeOverlayElements(elements)
      : elements);
    const refreshedText = isMenuOverlayOnly
      ? this.mergeOverlayText(formattedText)
      : formattedText;
    this.replaceFormFieldStore(refreshedElements);
    this.latestStructuredText = refreshedText;
    this.debugLatestStructuredText = refreshedText;
    const snapshot = this.createStructuredSnapshot(refreshedText, refreshedElements);
    this.latestStructuredSnapshot = snapshot;
    this.debugLatestStructuredSnapshot = snapshot;
    return snapshot;
  }

  private resetRunState(): void {
    this.currentRun = null;
    this.currentAgentRun = null;
    this.abortController = null;
    this.currentScreenshotWarmup = null;
    this.screenshotBase64 = null;
    this.screenshotImageSize = null;
    this.initialScreenOcrText = null;
    this.latestStructuredText = null;
    this.latestStructuredSnapshot = null;
    this.activeDisplay = null;
    this.activeViewport = null;
    this.activeTargetPid = null;
    this.activeTargetWindowId = null;
    this.activeTargetIdentity = null;
    this.debugLatestStructuredText = null;
    this.debugLatestStructuredSnapshot = null;
    this.formFieldStore.clear();
    this.focusedMenuElementId = null;
    this.lastVisionInteractionPoint = null;
    this.workingAnchorAction = null;
    this.pendingTerminalResult = null;
    this.finalizingTerminalResult = false;
    this.sessionAutoAccept = false;
    this.acceptAllThroughSeq = null;
    this.queuedApprovalAfterProcessing = false;
    this.computerBatchExecuting = false;
    this.pendingComputerBatch = null;
    this.toolResolvers.clear();
    this.attachedToolSessionActive = false;
  }

  private resolveToolResult(seq: number, result: ToolExecutionResult): void {
    const resolver = this.toolResolvers.get(seq);
    if (!resolver) {
      return;
    }

    resolver(result);
    this.toolResolvers.delete(seq);
  }

  private resolveToolText(seq: number, text: string): void {
    this.resolveToolResult(seq, textToolResult(text));
  }

  cancelUser(): void {
    if (!this.currentRun) {
      return;
    }

    this.acceptAllThroughSeq = null;
    this.sessionAutoAccept = false;
    this.queuedApprovalAfterProcessing = false;

    if (this.pendingComputerBatch) {
      const pending = this.pendingComputerBatch;
      this.pendingComputerBatch = null;
      pending.resolve(textToolResult('User cancelled'));
    }

    // Mark all pending actions as rejected
    for (const action of this.currentRun.actions) {
      if (!action.decision) {
        action.decision = 'rejected';
        action.error = 'User cancelled';

        // Resolve the tool
        this.resolveToolText(action.seq, 'User cancelled');
      }
    }

    // Abort agent
    this.abortController?.abort();
    this.currentAgentRun?.abort();

    // Clean up BEFORE updating UI so the UI reflects the final state
    this.resetRunState();

    // Update UI (will show hidden pill since currentRun is now null)
    this.updateUI();
  }

  replacePendingComputerBatchForNewProposal(): boolean {
    if (!this.currentRun || !this.pendingComputerBatch || this.computerBatchExecuting) {
      return false;
    }

    const pending = this.pendingComputerBatch;
    this.pendingComputerBatch = null;
    this.acceptAllThroughSeq = null;
    this.queuedApprovalAfterProcessing = false;
    pending.resolve(textToolResult('Replaced by a newer computer_batch proposal.'));

    const pendingIds = new Set(pending.actionIds ?? []);
    const pendingSeqs = new Set(pending.actionSeqs);
    this.currentRun.actions = this.currentRun.actions.filter((action) => {
      const belongsToPending = action.previewBatchId === pending.previewBatchId
        || pendingIds.has(action.id)
        || pendingSeqs.has(action.seq);
      if (!belongsToPending) {
        return true;
      }
      action.decision = 'system_cancelled';
      action.error = 'Replaced by a newer computer_batch proposal.';
      this.resolveToolText(action.seq, 'Replaced by a newer computer_batch proposal.');
      return false;
    });

    this.updateUI(false, null, 'computer-batch-replaced');
    return true;
  }

  /**
   * Handle Ctrl key press based on current state.
   * NEW BEHAVIOR: Just shows visual feedback, doesn't accept yet.
   * Returns true if the Ctrl press was handled (in review mode).
   * Returns false if the caller should proceed with starting a new recording.
   */
  handleCtrlDown(): boolean {
    this.ctrlPressed = true;
    this.updateUI();

    // If we have an active action awaiting review, just show visual feedback
    // Don't accept yet - that happens on Ctrl UP
    if (this.currentRun && this.getActiveAction()) {
      return true; // Handled (showing visual feedback)
    }

    // No active action - caller should start recording
    return false; // Not handled
  }

  /**
   * Handle Ctrl key release
   * NEW BEHAVIOR: Accept action on Ctrl UP (not down)
   */
  handleCtrlUp(acceptAll: boolean = false): void {
    const wasPressed = this.ctrlPressed;
    this.ctrlPressed = false;
    this.updateUI();

    // Ctrl approves the whole currently rendered action set. The UI presents a
    // trace, not a per-step confirmation queue, so plain Ctrl should execute the
    // visible group through the next screenshot boundary.
    if (wasPressed && this.currentRun && this.getActiveAction()) {
      this.prepareAcceptAllVisibleGroup();
      if (this.isProcessingApproval) {
        this.queuedApprovalAfterProcessing = true;
        console.log('[RunEngine] Queued approval while previous action was still executing');
        return;
      }
      void this.autoAcceptLoop();
    }
  }

  handleShiftDown(): void {
    if (this.shiftPressed) {
      return;
    }

    this.shiftPressed = true;
    this.updateUI();
  }

  handleShiftUp(): void {
    if (!this.shiftPressed) {
      return;
    }

    this.shiftPressed = false;
    this.updateUI();
  }

  /**
   * Handle Escape key press
   * Abort the current run immediately when Escape is pressed
   */
  handleEscape(): void {
    if (!this.currentRun) {
      return;
    }

    console.log('[RunEngine] Escape pressed - cancelling run');
    this.cancelUser();
  }

  dispose(): void {
    // Clear any active error dismiss timer
    if (this.errorDismissTimer) {
      clearTimeout(this.errorDismissTimer);
      this.errorDismissTimer = null;
    }
    this.agentDoneCallbacks.clear();
    // Cleanup is handled automatically by the input port
    // No explicit cleanup needed since we used arrow functions
  }

  /**
   * Start a programmatic run with a text prompt (no voice recording).
   * This captures the screen, runs OCR, and starts the agent with the given prompt.
   * Used for non-voice interactions like menu items or keyboard shortcuts.
   *
   * @param prompt - The text prompt to send to the agent
   * @returns Promise that resolves when the agent completes
   */
  async startProgrammaticRun(prompt: string, options?: StartRunOptions): Promise<void> {
    if (
      this.currentRun
      || this.currentAgentRun
      || this.attachedToolSessionActive
      || this.finalizingTerminalResult
      || this.pendingTerminalResult
    ) {
      throw new Error('Interpreter Overlay run already active');
    }

    console.log('[RunEngine] Starting programmatic run with prompt:', prompt);

    // 1. Capture screenshot and run OCR (same as voice recording flow)
    await this.beginRecording(options);

    // 2. Start agent with the provided prompt
    await this.endRecording(prompt, {
      systemAddendum: options?.systemAddendum,
      userAttachments: options?.userAttachments,
      screenRegions: options?.screenRegions,
    });

    // 3. Wait for agent to complete
    return new Promise<void>((resolve) => {
      const unsubscribe = this.onAgentDone(() => {
        unsubscribe();
        resolve();
      });
    });
  }

  /**
   * Register callback for when agent run completes (for testing/debug)
   */
  onAgentDone(callback: (result: AgentRunResult) => void): () => void {
    this.agentDoneCallbacks.add(callback);
    return () => {
      this.agentDoneCallbacks.delete(callback);
    };
  }

  getDebugContext(): RunEngineDebugContext {
    return {
      initialUserText: this.debugInitialUserText,
      latestStructuredText: this.latestStructuredText ?? this.debugLatestStructuredText,
      latestStructuredSnapshot: this.latestStructuredSnapshot ?? this.debugLatestStructuredSnapshot,
    };
  }

  startAttachedToolSession(options: AttachedToolSessionContextOptions): void {
    const viewport = getDisplayViewport(options.display, options.scopeBounds ?? null);
    if (!viewport) {
      throw new Error('Selected scope is outside the active display');
    }

    if (this.currentRun && !this.attachedToolSessionActive) {
      throw new Error('Interpreter Overlay run already active');
    }

    const shouldReuseCurrentRun = this.currentRun
      && this.attachedToolSessionActive
      && this.activeDisplay?.id === options.display.id
      && this.boundsEqual(this.activeViewport, viewport);

    if (!shouldReuseCurrentRun) {
      this.resetRunState();
      const runId = this.ids.uuid();
      this.currentRun = {
        id: runId,
        startedAt: this.clock.now(),
        monitorId: options.display.id,
        actions: [],
        conversationId: this.getOrCreateConversationId(),
        currentScreenshotId: `run-${runId}/batch-0`,
        toolCallCount: 0,
      };
      this.attachedToolSessionActive = true;
      this.focusedMenuElementId = null;
    }

    this.activeDisplay = options.display;
    this.activeViewport = viewport;
    this.activeTargetPid = options.targetPid ?? null;
    this.activeTargetWindowId = options.targetWindowId ?? null;
    this.activeTargetIdentity = options.targetIdentity ?? null;
    this.initialScreenOcrText = options.formattedText;
    this.applyStructuredContextToState(options.formattedText, options.elements);

    if (this.currentRun && typeof options.screenshotBase64 === 'string' && options.screenshotBase64.length > 0) {
      this.screenshotBase64 = options.screenshotBase64;
      this.screenshotImageSize = this.readPngImageSize(options.screenshotBase64);
      this.screenshotCache.set(this.currentRun.currentScreenshotId, options.screenshotBase64);
      this.screenshotCache.set(`${this.currentRun.currentScreenshotId}:cached`, 'false');
    }
  }

  endAttachedToolSession(): void {
    if (!this.attachedToolSessionActive) {
      return;
    }

    this.resetRunState();
    this.updateUI(false, null, 'end-attached-tool-session');
  }

  /**
   * Show an error message in the pill UI and auto-dismiss after 4 seconds
   */
  private showError(message: string): void {
    console.log(`[RunEngine] Showing error: ${message}`);

    // Clear any existing error timer
    if (this.errorDismissTimer) {
      clearTimeout(this.errorDismissTimer);
    }

    // Show error UI
    this.ui.set({
      pill: { kind: 'error', message },
      active: null,
      ghosts: [],
      ctrlPressed: this.ctrlPressed,
      shiftPressed: this.shiftPressed,
      executing: false,
    });

    // Auto-dismiss after 4 seconds
    this.errorDismissTimer = setTimeout(() => {
      console.log('[RunEngine] Auto-dismissing error');
      this.errorDismissTimer = null;

      // Reset to hidden state
      this.ui.set({
        pill: { kind: 'hidden' },
        active: null,
        ghosts: [],
        ctrlPressed: this.ctrlPressed,
        shiftPressed: this.shiftPressed,
        executing: false,
      });
    }, 4000);
  }

  private getOrCreateConversationId(): string {
    const now = this.clock.now();

    // Check if existing conversation is still valid
    if (this.conversationId && now < this.conversationExpiresAt) {
      return this.conversationId;
    }

    // Create new conversation
    this.conversationId = this.ids.uuid();
    return this.conversationId;
  }

  private async dispatchToolCall(
    tool: ToolCall,
    seq: number,
    resolve: (result: ToolExecutionResult) => void
  ): Promise<void> {
    const toolCallStart = Date.now();
    console.log(`[RunEngine] [TIMING] handleToolCall started for ${tool.name} seq=${seq}`);

    if (!this.currentRun) {
      return;
    }

    // Check tool call limit
    if (this.currentRun.toolCallCount >= this.config.MAX_TOOL_CALLS_PER_RUN) {
      resolve(textToolResult('Tool call limit reached'));
      return;
    }

    this.currentRun.toolCallCount++;

    if (tool.name === 'computer_batch') {
      await this.handleComputerBatchTool(seq, tool.params, resolve);
      return;
    }

    let action = this.getActionBySeq(seq);
    if (action) {
      action.tool = tool.name;
      action.params = tool.params;
    } else {
      action = {
        id: this.ids.uuid(),
        seq,
        tool: tool.name,
        params: tool.params,
      };
      this.currentRun.actions.push(action);
      this.sortCurrentActions();
    }
    action.dispatched = true;

    if (tool.name === 'type' && OVERLAY_VISION_MODE && this.lastVisionInteractionPoint) {
      action.visionAnchorPx = { ...this.lastVisionInteractionPoint };
      this.attachVisionAnchorBBoxFromPoint(action, action.visionAnchorPx);
    }

    // Store resolver
    this.toolResolvers.set(seq, resolve);

    // Handle screenshot tool immediately (it's a boundary, not reviewable)
    if (tool.name === 'screenshot') {
      // Screenshot tools process immediately once all prior actions are done
      await this.processScreenshotWhenReady(action);
      return;
    }

    if (tool.name === 'scroll') {
      const validationError = this.validateAndPrepareScrollAction(action);
      if (validationError) {
        action.decision = 'system_cancelled';
        action.error = validationError;
        this.resolveToolText(action.seq, validationError);
        this.cancelRemainingPlan(action.seq);
        this.updateUI();
        return;
      }
    }

    if (tool.name === 'click') {
      const validationError = this.validateAndPrepareClickAction(action);
      if (validationError) {
        action.decision = 'system_cancelled';
        action.error = validationError;
        this.resolveToolText(action.seq, validationError);
        this.cancelRemainingPlan(action.seq);
        this.updateUI();
        return;
      }
    }

    if (tool.name === 'hotkey') {
      const validationError = this.validateAndPrepareHotkeyAction(action);
      if (validationError) {
        action.decision = 'system_cancelled';
        action.error = validationError;
        this.resolveToolText(action.seq, validationError);
        this.cancelRemainingPlan(action.seq);
        this.updateUI();
        return;
      }
    }

    // Enrich if needed (click/type need bbox)
    const requiresEnrichment = (
      (tool.name === 'click' && !this.clickActionHasDirectPoint(action))
      || (tool.name === 'type' && !this.typeActionUsesFocusedControl(action))
      || this.scrollActionNeedsEnrichment(action)
    );
    if (requiresEnrichment && !action.bbox) {
      // Add to enrichment queue for batch processing
      this.enrichmentQueue.push(action);

      // Schedule batch enrichment (debounced - only runs once for all actions that arrive together)
      if (this.enrichmentTimer) {
        clearTimeout(this.enrichmentTimer);
      }
      this.enrichmentTimer = setTimeout(() => this.processBatchEnrichment(), 1);

      console.log(`[RunEngine] [TIMING] dispatchToolCall END for ${tool.name} seq=${seq}, queued for enrichment, took ${Date.now() - toolCallStart}ms`);
    } else {
      // Hotkeys and preview-enriched actions can render immediately.
      this.updateUI();

      // Auto-accept when debug mode, grouped approval, or session approval is active.
      if (this.shouldAutoAcceptActions()) {
        void this.autoAcceptLoop();
      }

      console.log(`[RunEngine] [TIMING] dispatchToolCall END for ${tool.name} seq=${seq}, took ${Date.now() - toolCallStart}ms`);
    }
  }

  private async handleComputerBatchTool(
    seq: number,
    params: ComputerBatchParams,
    resolve: (result: ToolExecutionResult) => void,
  ): Promise<void> {
    if (!this.currentRun) {
      resolve(textToolResult('No active run'));
      return;
    }

    if (this.pendingComputerBatch) {
      resolve(textToolResult('Another computer_batch call is already awaiting approval or execution.'));
      return;
    }

    // The staged batch is the authoritative version of the plan. Any undecided
    // preview-only actions (created from act.preview for this same proposal)
    // would otherwise sit undispatched ahead of the staged actions and block
    // getActiveAction() from ever surfacing the review UI.
    for (const action of this.currentRun.actions) {
      if (!action.decision && !action.dispatched) {
        action.decision = 'system_cancelled';
        action.error = 'Superseded by the staged computer_batch.';
      }
    }

    const batchActions: Action[] = [];
    const previewBatchId = `computer-batch-${seq}`;
    let nextSeq = this.nextActionSeq();

    for (const item of params.actions) {
      const batchTool = item.tool as AtomicToolCall;
      const action: Action = {
        id: this.ids.uuid(),
        seq: nextSeq,
        tool: batchTool.name,
        params: batchTool.params,
        previewBatchId,
        dispatched: true,
      };
      nextSeq += 1;
      this.currentRun.actions.push(action);

      if (action.tool === 'type' && OVERLAY_VISION_MODE && this.lastVisionInteractionPoint && !action.visionAnchorPx) {
        action.visionAnchorPx = { ...this.lastVisionInteractionPoint };
        this.attachVisionAnchorBBoxFromPoint(action, action.visionAnchorPx);
      }

      if (action.tool === 'scroll') {
        const validationError = this.validateAndPrepareScrollAction(action);
        if (validationError) {
          this.cancelComputerBatchValidationFailure(batchActions, action, validationError);
          this.updateUI(false, null, 'computer-batch-scroll-invalid');
          resolve(invalidActionToolResult(validationError));
          return;
        }
      }

      if (action.tool === 'click') {
        const validationError = this.validateAndPrepareClickAction(action);
        if (validationError) {
          this.cancelComputerBatchValidationFailure(batchActions, action, validationError);
          this.updateUI(false, null, 'computer-batch-click-invalid');
          resolve(invalidActionToolResult(validationError));
          return;
        }
      }

      if (action.tool === 'hotkey') {
        const validationError = this.validateAndPrepareHotkeyAction(action);
        if (validationError) {
          this.cancelComputerBatchValidationFailure(batchActions, action, validationError);
          this.updateUI(false, null, 'computer-batch-hotkey-invalid');
          resolve(invalidActionToolResult(validationError));
          return;
        }
      }

      batchActions.push(action);
    }

    this.sortCurrentActions();
    this.applyVisionTypingAnchors(batchActions);
    await this.enrichPreviewActions(batchActions);

    this.pendingComputerBatch = {
      toolSeq: seq,
      previewBatchId,
      actionSeqs: batchActions.map((action) => action.seq),
      actionIds: batchActions.map((action) => action.id),
      startedAt: Date.now(),
      resolve,
      actionTimings: [],
    };

    this.updateUI(false, null, 'computer-batch-staged');
    await this.maybeFinalizePendingComputerBatch('computer-batch-stage');

    if (this.shouldAutoAcceptActions() || await this.batchControlPolicyAllowsAutoAccept()) {
      this.prepareAcceptAllVisibleGroup();
      void this.autoAcceptLoop();
    }
  }

  /**
   * Settings bridge: when the Computer Use control policy for the active
   * target app is 'all' ("don't ask"), the staged batch auto-accepts so the
   * trace executes without a Ctrl press. The review UI still stages and
   * renders each action as it executes; only the acceptance gate changes.
   */
  private async batchControlPolicyAllowsAutoAccept(): Promise<boolean> {
    const resolveMode = this.config.resolveControlPolicyMode;
    const appName = this.activeTargetIdentity?.app?.name?.trim();
    if (!resolveMode || !appName) {
      return false;
    }

    const mode = await resolveMode(appName);
    if (mode !== 'all') {
      return false;
    }

    console.log(`[RunEngine] Auto-accepting staged computer_batch: control policy mode=all app=${appName}`);
    return true;
  }

  private cancelComputerBatchValidationFailure(
    batchActions: Action[],
    invalidAction: Action,
    validationError: string,
  ): void {
    const stagedActions = batchActions.includes(invalidAction)
      ? batchActions
      : [...batchActions, invalidAction];
    const skippedMessage = `Skipped because another action in the same computer batch failed validation: ${validationError}`;

    for (const action of stagedActions) {
      if (action.decision) {
        continue;
      }

      action.decision = 'system_cancelled';
      action.error = action === invalidAction ? validationError : skippedMessage;
    }
  }

  private recordPendingComputerBatchTiming(
    action: Action,
    timing: PendingComputerBatchActionTiming,
  ): void {
    if (!this.pendingComputerBatch || action.previewBatchId !== this.pendingComputerBatch.previewBatchId) {
      return;
    }
    this.pendingComputerBatch.actionTimings.push(timing);
  }

  private async maybeFinalizePendingComputerBatch(trigger: string): Promise<void> {
    const pending = this.pendingComputerBatch;
    if (!pending || !this.currentRun) {
      return;
    }

    const batchActions = pending.actionIds
      ? pending.actionIds
        .map((id) => this.currentRun!.actions.find((action) => action.id === id) ?? null)
        .filter((action): action is Action => action !== null)
      : pending.actionSeqs
        .map((seq) => this.getActionBySeq(seq))
        .filter((action): action is Action => action !== null);
    if (batchActions.length === 0) {
      return;
    }

    if (batchActions.some((action) => !action.decision)) {
      console.log('[RunEngine] Pending computer_batch is not finalized yet', {
        trigger,
        toolSeq: pending.toolSeq,
        pending: batchActions
          .filter((action) => !action.decision)
          .map((action) => ({
            id: action.id,
            seq: action.seq,
            tool: action.tool,
            previewBatchId: action.previewBatchId,
            dispatched: action.dispatched,
          })),
      });
      return;
    }

    const firstProblem = batchActions.find((action) => action.decision !== 'approved' || action.error);
    for (const action of batchActions) {
      const alreadyRecorded = pending.actionTimings.some((timing) => timing.seq === action.seq);
      if (alreadyRecorded) {
        continue;
      }

      pending.actionTimings.push({
        seq: action.seq,
        tool: action.tool,
        durationMs: 0,
        status: action.decision === 'approved' && !action.error ? 'completed' : 'skipped',
        error: action.error,
      });
    }

    this.pendingComputerBatch = null;
    this.computerBatchExecuting = false;
    this.workingAnchorAction = null;

    const debug = {
      durationMs: Date.now() - pending.startedAt,
      actionTimings: pending.actionTimings,
    };

    if (firstProblem) {
      console.log('[RunEngine] Resolving computer_batch with error', {
        trigger,
        toolSeq: pending.toolSeq,
        durationMs: debug.durationMs,
        error: firstProblem.error ?? firstProblem.decision ?? 'failed',
      });
      pending.resolve({
        kind: 'text',
        text: `Error: ${firstProblem.error ?? `computer_batch ${firstProblem.decision ?? 'failed'}`}`,
        debug,
      });
      return;
    }

    if (OVERLAY_VISION_MODE) {
      await new Promise((resolve) => setTimeout(resolve, VISION_BATCH_SCREENSHOT_SETTLE_DELAY_MS));
      const imageResult = await this.captureFreshVisionBatchImageResult();
      console.log('[RunEngine] Resolving computer_batch with fresh image', {
        trigger,
        toolSeq: pending.toolSeq,
        durationMs: debug.durationMs,
      });
      pending.resolve({
        ...imageResult,
        debug,
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, AX_BATCH_REFRESH_SETTLE_DELAY_MS));
    try {
      let snapshot = await this.captureStructuredRefreshSnapshotWithTimeout(AX_BATCH_REFRESH_TIMEOUT_MS);
      // An empty refresh right after successful actions is almost always the
      // capture racing the app's UI update, and feeding the model an empty
      // state makes it redo finished work. Retry once after a short settle;
      // if the second read is also empty, return it honestly.
      if (snapshot.elements.length === 0) {
        console.warn('[RunEngine] Structured refresh returned 0 elements after batch; retrying once after settle', {
          trigger,
          toolSeq: pending.toolSeq,
        });
        await new Promise((resolve) => setTimeout(resolve, 450));
        snapshot = await this.captureStructuredRefreshSnapshotWithTimeout(AX_BATCH_REFRESH_TIMEOUT_MS);
      }
      console.log('[RunEngine] Resolving computer_batch with structured refresh', {
        trigger,
        toolSeq: pending.toolSeq,
        durationMs: debug.durationMs,
        elementCount: snapshot.elements.length,
      });
      pending.resolve({
        kind: 'structured-screen',
        snapshot,
        debug,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('[RunEngine] Resolving computer_batch after successful execution without structured refresh', {
        trigger,
        toolSeq: pending.toolSeq,
        durationMs: debug.durationMs,
        error: errorMessage,
      });
      pending.resolve({
        kind: 'text',
        text: 'Action completed successfully',
        debug,
      });
    }
  }

  /**
   * Process all queued actions in parallel (batch vision detection)
   */
  private async processBatchEnrichment(): Promise<void> {
    if (!this.currentRun || this.enrichmentQueue.length === 0) {
      return;
    }

    // Take all queued actions
    const actionsToEnrich = [...this.enrichmentQueue];
    this.enrichmentQueue = [];
    this.enrichmentTimer = null;

    const enrichStart = Date.now();
    console.log(`[RunEngine] [TIMING] Batch enriching ${actionsToEnrich.length} actions in parallel...`);
    const samplingScreenshotBase64 = await this.captureSamplingScreenshotBase64();

    // Fire all vision.detect() calls in PARALLEL
    const enrichmentPromises = actionsToEnrich.map(async (action) => {
      if (!this.currentRun) return;

      const elementTarget = this.getActionElementTarget(action);
      if (!elementTarget) {
        return;
      }
      let { elementId, query } = elementTarget;

      if (action.tool === 'type' && !elementId && !query && this.focusedMenuElementId) {
        elementId = this.focusedMenuElementId;
        action.params = {
          ...(action.params as TypeParams),
          element_id: elementId,
        };
      }

      // Require either element_id or element_description
      if (!elementId && !query) {
        action.decision = 'system_cancelled';
        action.error = `${action.tool} action requires element_id or element_description parameter`;

        // Resolve the tool with error message
        this.resolveToolText(action.seq, action.error);
        this.cancelRemainingPlan(action.seq);
        return;
      }

      const detectStart = Date.now();

      // PRIORITY 1: Check for element_id (instant lookup by ID)
      if (elementId) {
        console.log(`[RunEngine] Batch: Looking for element_id="${elementId}" (type: ${typeof elementId}) in formFieldStore with ${this.formFieldStore.size} elements`);
        console.log(`[RunEngine] Batch: First 10 keys in store: ${Array.from(this.formFieldStore.keys()).slice(0, 10).join(', ')}`);
        console.log(`[RunEngine] Batch: Has key? ${this.formFieldStore.has(elementId)}`);
      }

      if (elementId && this.formFieldStore.has(elementId) && this.activeViewport) {
        const field = this.formFieldStore.get(elementId)!;
        if (action.tool === 'scroll') {
          const scopedMatchedFieldBounds = this.getScopedElementBBox(field);
          if (!scopedMatchedFieldBounds) {
            action.decision = 'system_cancelled';
            action.error = `Element "${field.label || field.id}" is no longer within the selected scope.`;
            this.resolveToolText(action.seq, action.error);
            this.cancelRemainingPlan(action.seq);
            return;
          }
          const relativeBbox = this.toScopedRelativeBBox(scopedMatchedFieldBounds);
          action.bbox = relativeBbox;
          action.resolvedLabel = field.label;
          action.currentValue = field.value;
          action.centerColor = samplingScreenshotBase64
            ? sampleCenterPixel(samplingScreenshotBase64, relativeBbox) ?? undefined
            : undefined;
          console.log(`[RunEngine] [TIMING] Instant scroll match completed for action ${action.seq} in ${Date.now() - detectStart}ms`);
          return;
        }
        const applied = this.tryApplyInstantMatch({
          action,
          field,
          query,
          samplingScreenshotBase64,
          detectStart,
          elementId,
        });
        if (applied) {
          return;
        }

        const descriptionMismatch = this.getElementDescriptionMismatch(action, field, query, elementId);
        if (descriptionMismatch) {
          action.decision = 'system_cancelled';
          action.error = descriptionMismatch;
          this.resolveToolText(action.seq, descriptionMismatch);
          this.cancelRemainingPlan(action.seq);
          return;
        }

        if (!query) {
          action.decision = 'system_cancelled';
          action.error = `Unsafe element_id "${elementId}" for ${action.tool}. Include element_description or refresh the screen context.`;
          this.resolveToolText(action.seq, action.error);
          this.cancelRemainingPlan(action.seq);
          return;
        }
      }

      const descriptionMatch = this.findUniqueElementByDescription(query, action.tool);
      if (descriptionMatch && this.activeViewport) {
        const matchedField = action.tool === 'type'
          ? this.resolveTypingTarget(descriptionMatch)
          : descriptionMatch;
        console.log(
          `[RunEngine] [TIMING] Exact label match for action ${action.seq}: element_description="${query}" -> role=${descriptionMatch.role}`,
        );

        const scopedMatchedFieldBounds = this.getScopedElementBBox(matchedField);
        if (!scopedMatchedFieldBounds) {
          action.decision = 'system_cancelled';
          action.error = `Element "${matchedField.label || matchedField.id}" is no longer within the selected scope.`;
          this.resolveToolText(action.seq, action.error);
          this.cancelRemainingPlan(action.seq);
          return;
        }
        const relativeBbox = this.toScopedRelativeBBox(scopedMatchedFieldBounds);

        action.bbox = relativeBbox;
        action.resolvedLabel = matchedField.label || descriptionMatch.label;
        action.currentValue = matchedField.value ?? descriptionMatch.value;
        action.centerColor = samplingScreenshotBase64
          ? sampleCenterPixel(samplingScreenshotBase64, relativeBbox) ?? undefined
          : undefined;
        console.log(`[RunEngine] [TIMING] Exact label match completed for action ${action.seq} in ${Date.now() - detectStart}ms`);
        return;
      }

      // PRIORITY 2: Fall back to element_description (requires vision API)
      if (!query) {
        // element_id was provided but not found in store
        action.decision = 'system_cancelled';
        action.error = `Element with id "${elementId}" not found`;
        this.resolveToolText(action.seq, action.error);
        this.cancelRemainingPlan(action.seq);
        return;
      }

      if (OVERLAY_VISION_DISABLED) {
        action.decision = 'system_cancelled';
        action.error = this.buildVisionDisabledMessage(query, elementId);
        this.resolveToolText(action.seq, action.error);
        this.cancelRemainingPlan(action.seq);
        return;
      }

      console.log(`[RunEngine] [TIMING] No element_id or not found, using element_description="${query}" - calling vision API for action ${action.seq}`);

      try {
        // Only send base64 inline if remote cache failed
        const remotelyCached = this.screenshotCache.get(`${this.currentRun.currentScreenshotId}:cached`) === 'true';
        const screenshotBase64 = remotelyCached ? undefined : this.screenshotCache.get(this.currentRun.currentScreenshotId);

        if (!remotelyCached) {
          console.log(`[RunEngine] Remote cache unavailable for ${this.currentRun.currentScreenshotId}, sending base64 inline (${screenshotBase64?.length} bytes)`);
        }

        const result = await this.detectWithLocalFallback(
          this.currentRun.currentScreenshotId,
          query,
          screenshotBase64,
        );
        console.log(`[RunEngine] [TIMING] Vision detect completed for action ${action.seq} in ${Date.now() - detectStart}ms`);

        // Check if action was cancelled while we were waiting
        if (action.decision) {
          return; // Already decided, skip
        }

        if ('bbox' in result) {
          // Success: attach bbox and centerColor
          action.bbox = result.bbox;
          action.centerColor = samplingScreenshotBase64
            ? sampleCenterPixel(samplingScreenshotBase64, result.bbox) ?? undefined
            : undefined;
        } else {
          // System cancel: detect returned text
          action.decision = 'system_cancelled';
          action.error = result.text;

          // Resolve this tool
          this.resolveToolText(action.seq, result.text);

          // Cancel remaining actions in current plan
          this.cancelRemainingPlan(action.seq);
        }
      } catch (error) {
        console.error(`[RunEngine] Error enriching action ${action.seq}:`, error);
        action.decision = 'system_cancelled';
        action.error = `Vision error: ${error instanceof Error ? error.message : String(error)}`;

        this.resolveToolText(action.seq, action.error);
        this.cancelRemainingPlan(action.seq);
      }
    });

    // Wait for ALL enrichments to complete in parallel
    await Promise.all(enrichmentPromises);

    console.log(`[RunEngine] [TIMING] Batch enrichment completed in ${Date.now() - enrichStart}ms for ${actionsToEnrich.length} actions`);

    // Update UI to show the first reviewable action
    this.updateUI();

    // Vision-mode preview actions belong to the dedicated computer_batch flow.
    // Render them for review/ghosting, but do not auto-accept them through the
    // legacy per-action loop or they will overlap the batch executor.
    if (this.shouldAutoAcceptActions() && !OVERLAY_VISION_MODE) {
      void this.autoAcceptLoop();
    }
  }

  /**
   * Continuously auto-accept actions for debug mode, grouped approval, or the current session setting.
   */
  private async autoAcceptLoop(): Promise<void> {
    if (
      (!this.shouldAutoAcceptActions())
      || !this.currentRun
      || this.autoAcceptLoopRunning
      || (OVERLAY_VISION_MODE && this.computerBatchExecuting)
    ) {
      return;
    }

    this.autoAcceptLoopRunning = true;
    try {
      while (this.shouldAutoAcceptActions() && this.currentRun) {
        const active = this.getActiveAction();
        if (!active) {
          if (this.acceptAllThroughSeq !== null && this.hasPendingAcceptedPreviewAction()) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            continue;
          }
          if (this.acceptAllThroughSeq !== null) {
            this.acceptAllThroughSeq = null;
          }
          break;
        }

        if (this.acceptAllThroughSeq !== null && active.seq > this.acceptAllThroughSeq) {
          this.acceptAllThroughSeq = null;
          break;
        }

        if (OVERLAY_VISION_MODE && this.computerBatchExecuting) {
          break;
        }

        if (this.isProcessingApproval) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }

        const loopStart = Date.now();
        console.log(`[RunEngine] [TIMING] Auto-accept loop processing action seq=${active.seq}`);
        if (!this.currentRun || this.isProcessingApproval || this.getActiveAction()?.seq !== active.seq) {
          continue;
        }

        await this.handleAccept();
        console.log(`[RunEngine] [TIMING] Auto-accept loop completed action seq=${active.seq} in ${Date.now() - loopStart}ms`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      this.autoAcceptLoopRunning = false;
    }
  }

  private async enrichAction(action: Action): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    const samplingScreenshotBase64 = await this.captureSamplingScreenshotBase64();

    const elementTarget = this.getActionElementTarget(action);
    if (!elementTarget) {
      return;
    }
    let { elementId, query } = elementTarget;

    console.log(`[RunEngine] Enriching action ${action.seq} (${action.tool}), element_id: "${elementId}", element_description: "${query}"`);

    // PRIORITY 1: Check for element_id (instant lookup by ID)
    if (elementId && this.formFieldStore.has(elementId) && this.activeViewport) {
      const field = this.formFieldStore.get(elementId)!;
      const applied = this.tryApplyInstantMatch({
        action,
        field,
        query,
        samplingScreenshotBase64,
        detectStart: Date.now(),
        elementId,
      });
      if (applied) {
        this.updateUI();

        if (this.shouldAutoAcceptActions()) {
          void this.autoAcceptLoop();
        }
        return;
      }

      if (!query) {
        console.error(`[RunEngine] ERROR: Unsafe id-only instant match for action ${action.seq}`);
        action.decision = 'system_cancelled';
        action.error = `Unsafe element_id "${elementId}" for ${action.tool}. Include element_description or refresh the screen context.`;
        this.resolveToolText(action.seq, action.error);
        this.cancelRemainingPlan(action.seq);
        this.updateUI();
        return;
      }
    }

    const descriptionMatch = this.findUniqueElementByDescription(query, action.tool);
    if (descriptionMatch && this.activeViewport) {
      const matchedField = action.tool === 'type'
        ? this.resolveTypingTarget(descriptionMatch)
        : descriptionMatch;
      console.log(
        `[RunEngine] Exact label match for action ${action.seq}: element_description="${query}" -> role=${descriptionMatch.role}`,
      );

      const scopedMatchedFieldBounds = this.getScopedElementBBox(matchedField);
      if (!scopedMatchedFieldBounds) {
        console.error(`[RunEngine] ERROR: Matched element ${matchedField.id} fell outside the active viewport`);
        action.decision = 'system_cancelled';
        action.error = `Element "${matchedField.label || matchedField.id}" is no longer within the selected scope.`;
        this.resolveToolText(action.seq, action.error);
        this.cancelRemainingPlan(action.seq);
        this.updateUI();
        return;
      }

      const relativeBbox = this.toScopedRelativeBBox(scopedMatchedFieldBounds);

      action.bbox = relativeBbox;
      action.resolvedLabel = matchedField.label || descriptionMatch.label;
      action.centerColor = samplingScreenshotBase64
        ? sampleCenterPixel(samplingScreenshotBase64, relativeBbox) ?? undefined
        : undefined;

      this.updateUI();

      if (this.shouldAutoAcceptActions()) {
        void this.autoAcceptLoop();
      }
      return;
    }

    // PRIORITY 2: Fall back to element_description (requires vision API)
    if (!query) {
      console.error(`[RunEngine] ERROR: No element_id or element_description provided for action ${action.seq}`);
      action.decision = 'system_cancelled';
      this.updateUI();
      return;
    }

    if (OVERLAY_VISION_DISABLED) {
      action.decision = 'system_cancelled';
      action.error = this.buildVisionDisabledMessage(query, elementId);
      this.resolveToolText(action.seq, action.error);
      this.cancelRemainingPlan(action.seq);
      this.updateUI();
      if (this.shouldAutoAcceptActions()) {
        void this.autoAcceptLoop();
      }
      return;
    }

    console.log(`[RunEngine] No element_id provided, using element_description="${query}" - calling vision API`);
    console.log(`[RunEngine] Using screenshot ID: ${this.currentRun.currentScreenshotId}`);

    // Only send base64 inline if remote cache failed
    const remotelyCached = this.screenshotCache.get(`${this.currentRun.currentScreenshotId}:cached`) === 'true';
    const screenshotBase64 = remotelyCached ? undefined : this.screenshotCache.get(this.currentRun.currentScreenshotId);

    if (!remotelyCached) {
      console.log(`[RunEngine] Remote cache unavailable for ${this.currentRun.currentScreenshotId}, sending base64 inline (${screenshotBase64?.length} bytes)`);
    }

    const result = await this.detectWithLocalFallback(
      this.currentRun.currentScreenshotId,
      query,
      screenshotBase64,
    );

    // Check if action was cancelled while we were waiting for detect
    if (action.decision) {
      return; // Already decided, skip
    }

    if ('bbox' in result) {
      // Success: attach bbox and centerColor
      action.bbox = result.bbox;
      action.centerColor = samplingScreenshotBase64
        ? sampleCenterPixel(samplingScreenshotBase64, result.bbox) ?? undefined
        : undefined;
    } else {
      // System cancel: detect returned text
      action.decision = 'system_cancelled';
      action.error = result.text;

      // Resolve this tool
      this.resolveToolText(action.seq, result.text);

      // Cancel remaining actions in current plan
      this.cancelRemainingPlan(action.seq);
    }

    // Update UI after enrichment
    this.updateUI();

    // Auto-accept when debug mode, grouped approval, or session approval is active.
    if (this.shouldAutoAcceptActions()) {
      void this.autoAcceptLoop();
    }
  }

  private cancelRemainingPlan(fromSeq: number): void {
    if (!this.currentRun) {
      return;
    }

    // Find the next screenshot boundary after this action
    const nextScreenshotIndex = this.currentRun.actions.findIndex(
      (a, idx) =>
        idx > fromSeq && a.tool === 'screenshot'
    );

    // Cancel all actions between fromSeq and next screenshot (or end)
    for (const action of this.currentRun.actions) {
      if (action.seq > fromSeq && !action.decision) {
        // If there's a screenshot boundary, only cancel up to it
        if (nextScreenshotIndex !== -1) {
          const screenshotSeq = this.currentRun.actions[nextScreenshotIndex]?.seq;
          if (screenshotSeq !== undefined && action.seq >= screenshotSeq) {
            continue;
          }
        }

        action.decision = 'system_cancelled';
        action.error = 'Skipped and NOT executed because a prior UI-changing action already returned a newer tree. Re-read the latest tree and decide the next action from that tree.';

        this.resolveToolText(
          action.seq,
          'Skipped and NOT executed because a prior UI-changing action already returned a newer tree. Re-read the latest tree and decide the next action from that tree.',
        );
      }
    }
  }

  private async refreshRemainingPreviewBatch(active: Action): Promise<void> {
    if (!this.currentRun || !active.previewBatchId) {
      return;
    }

    const remainingActions = this.currentRun.actions.filter((action) => (
      action.previewBatchId === active.previewBatchId
      && action.seq > active.seq
      && !action.decision
      && action.tool !== 'screenshot'
    ));

    if (remainingActions.length === 0) {
      return;
    }

    await this.enrichPreviewActions(remainingActions);
  }

  private async handleAccept(): Promise<void> {
    if (!this.currentRun || this.isProcessingApproval) {
      return;
    }

    this.isProcessingApproval = true;
    this.queuedApprovalAfterProcessing = false;
    console.log('[RunEngine] handleAccept start');

    try {
      const active = this.getActiveAction();
      if (!active) {
        return;
      }

      const acceptStart = Date.now();
      console.log(`[RunEngine] [ACTION_TIMING] ts=${acceptStart} iso=${new Date(acceptStart).toISOString()} phase=accept-start seq=${active.seq} tool=${active.tool}`);

      this.workingAnchorAction = active;
      if (active.previewBatchId && this.pendingComputerBatch?.previewBatchId === active.previewBatchId) {
        this.computerBatchExecuting = true;
      }

      // Mark as approved
      active.decision = 'approved';
      active.executedAt = this.clock.now();
        const postActionRefreshNeeded = this.shouldRefreshAfterAction(active)
        && !this.shouldDeferRefreshForAcceptedPreviewBatch(active);

      // Force click-through before automation.
      this.updateUI(true, active, 'approval-start');

      // Execute based on tool type
      try {
        const execStart = Date.now();
        console.log(`[RunEngine] [ACTION_TIMING] ts=${execStart} iso=${new Date(execStart).toISOString()} phase=execute-start seq=${active.seq} tool=${active.tool}`);
        await this.executeAction(active);
        const execEnd = Date.now();
        this.recordPendingComputerBatchTiming(active, {
          seq: active.seq,
          tool: active.tool,
          durationMs: execEnd - execStart,
          status: 'completed',
        });
        console.log(`[RunEngine] [ACTION_TIMING] ts=${execEnd} iso=${new Date(execEnd).toISOString()} phase=execute-end seq=${active.seq} tool=${active.tool} durationMs=${execEnd - execStart}`);
        console.log(`[RunEngine] [TIMING] Executed ${active.tool} action in ${execEnd - execStart}ms`);

        if (active.previewBatchId && active.tool !== 'screenshot' && this.acceptAllThroughSeq === null) {
          await this.refreshRemainingPreviewBatch(active);
        }

        // Resolve tool with success (screenshot handles its own resolution)
        if (active.tool !== 'screenshot') {
          const resolver = this.toolResolvers.get(active.seq);
          if (resolver) {
            if (postActionRefreshNeeded) {
              const refreshSnapshot = await this.captureStructuredRefreshSnapshot();
              resolver({
                kind: 'structured-screen',
                snapshot: refreshSnapshot,
              });
              if (active.previewBatchId) {
                await this.refreshRemainingPreviewBatch(active);
              } else {
                this.cancelRemainingPlan(active.seq);
              }
            } else {
              resolver(textToolResult('Action completed successfully'));
            }
            this.toolResolvers.delete(active.seq);
          }
        }
      } catch (error) {
        // Handle execution error
        active.error = error instanceof Error ? error.message : String(error);
        const failedAt = Date.now();
        this.recordPendingComputerBatchTiming(active, {
          seq: active.seq,
          tool: active.tool,
          durationMs: failedAt - (active.executedAt ?? failedAt),
          status: 'failed',
          error: active.error,
        });

        this.resolveToolText(active.seq, `Error: ${active.error}`);
        this.cancelRemainingPlan(active.seq);
      }

      await this.maybeFinalizePendingComputerBatch('handleAccept');

      if (!this.shouldContinueAcceptAllGroup()) {
        this.updateUI(false, null, 'approval-end');
      }
    } finally {
      this.isProcessingApproval = false;
      if (this.queuedApprovalAfterProcessing && this.currentRun && this.getActiveAction()) {
        this.queuedApprovalAfterProcessing = false;
        console.log('[RunEngine] Replaying queued approval after execution finished');
        void this.handleAccept();
        return;
      }

      if (this.acceptAllThroughSeq !== null && this.currentRun) {
        const nextActive = this.getActiveAction();
        if (nextActive && nextActive.seq <= this.acceptAllThroughSeq) {
          console.log('[RunEngine] Continuing Accept All for current review group');
          void this.autoAcceptLoop();
          return;
        }
        if (!nextActive && this.hasPendingAcceptedPreviewAction()) {
          console.log('[RunEngine] Waiting for remaining accepted preview actions to dispatch');
          void this.autoAcceptLoop();
          return;
        }
        this.acceptAllThroughSeq = null;
      }

      this.updateUI(false, null, 'approval-finished');
    }
  }

  private handleAcceptAllRequest(): void {
    if (!this.currentRun) {
      return;
    }

    this.prepareAcceptAllVisibleGroup();
    if (this.acceptAllThroughSeq === null) {
      return;
    }

    if (this.isProcessingApproval) {
      this.queuedApprovalAfterProcessing = true;
      return;
    }

    void this.autoAcceptLoop();
  }

  private handleAcceptAllForSessionRequest(): void {
    if (!this.currentRun) {
      return;
    }

    this.sessionAutoAccept = true;
    this.prepareAcceptAllVisibleGroup();

    if (this.isProcessingApproval) {
      this.queuedApprovalAfterProcessing = true;
      return;
    }

    void this.autoAcceptLoop();
  }

  private shouldAutoAcceptActions(): boolean {
    return Boolean(this.config.autoAccept || this.sessionAutoAccept || this.acceptAllThroughSeq !== null);
  }

  private shouldContinueAcceptAllGroup(): boolean {
    if (this.acceptAllThroughSeq === null || !this.currentRun) {
      return false;
    }
    const nextActive = this.getActiveAction();
    return Boolean(nextActive && nextActive.seq <= this.acceptAllThroughSeq)
      || this.hasPendingAcceptedPreviewAction();
  }

  private prepareAcceptAllVisibleGroup(): void {
    const active = this.getActiveAction();
    if (!active) {
      this.acceptAllThroughSeq = null;
      return;
    }

    if (
      active.previewBatchId
      && this.pendingComputerBatch?.previewBatchId === active.previewBatchId
      && this.currentRun
    ) {
      const batchActions = this.pendingComputerBatch.actionIds
        ? this.pendingComputerBatch.actionIds
          .map((id) => this.currentRun!.actions.find((action) => action.id === id) ?? null)
          .filter((action): action is Action => action !== null)
        : this.pendingComputerBatch.actionSeqs
          .map((seq) => this.getActionBySeq(seq))
          .filter((action): action is Action => action !== null);
      if (batchActions.length > 0) {
        this.acceptAllThroughSeq = Math.max(...batchActions.map((action) => action.seq));
        return;
      }
    }

    const group = [active, ...this.getGhosts()];
    this.acceptAllThroughSeq = Math.max(...group.map((action) => action.seq));
  }

  private hasPendingAcceptedPreviewAction(): boolean {
    if (this.acceptAllThroughSeq === null || !this.currentRun || !this.currentAgentRun) {
      return false;
    }

    const acceptThroughSeq = this.acceptAllThroughSeq;
    return this.currentRun.actions.some((action) => (
      action.seq <= acceptThroughSeq
      && action.tool !== 'screenshot'
      && !action.decision
    ));
  }

  private buildNativeCuaAppWindowTarget(): NativeCuaAppWindowTarget | null {
    const targetIdentity = this.activeTargetIdentity;
    if (!targetIdentity?.app?.name || typeof targetIdentity.app.pid !== 'number') {
      return null;
    }
    if (!Number.isInteger(targetIdentity.app.pid)) {
      return null;
    }

    const nativeWindowId = targetIdentity.window.nativeWindowId;
    if (
      typeof nativeWindowId !== 'number'
      && typeof nativeWindowId !== 'string'
    ) {
      return null;
    }
    if (typeof nativeWindowId === 'string' && !nativeWindowId.trim()) {
      return null;
    }

    return {
      app: targetIdentity.app.name,
      targetIdentity: {
        kind: 'app-window',
        app: {
          name: targetIdentity.app.name,
          pid: targetIdentity.app.pid,
        },
        window: {
          native_window_id: nativeWindowId,
        },
        bounds: { ...targetIdentity.bounds },
      },
    };
  }

  private buildNativeCuaPointTarget(point: Point): NativeCuaPointTarget | null {
    const appWindowTarget = this.buildNativeCuaAppWindowTarget();
    if (!appWindowTarget) {
      return null;
    }
    return {
      ...appWindowTarget,
      x: point.x,
      y: point.y,
    };
  }

  private buildNativeCuaElementTargetFromWindowsUiaId(elementId: string): NativeCuaElementTarget | null {
    const parsed = parseWindowsUiaElementId(elementId);
    const appWindowTarget = this.buildNativeCuaAppWindowTarget();
    if (!parsed || !appWindowTarget) {
      return null;
    }
    const nativeWindowId = appWindowTarget.targetIdentity.window;
    if (
      !nativeWindowId
      || typeof nativeWindowId !== 'object'
      || Array.isArray(nativeWindowId)
      || String((nativeWindowId as Record<string, unknown>).native_window_id) !== parsed.windowId
    ) {
      return null;
    }
    return {
      app: appWindowTarget.app,
      elementIndex: parsed.elementIndex,
      targetIdentity: appWindowTarget.targetIdentity,
    };
  }

  private assertWindowsUiaElementHasNoAttachedNativeCuaTarget(elementId: string): void {
    if (this.buildNativeCuaAppWindowTarget()) {
      throw new Error(`Windows UIA element ${elementId} does not match the attached native CUA target identity.`);
    }
  }

  private async executeAction(action: Action): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    const display = this.activeDisplay ?? this.capture.getActiveDisplay();

    switch (action.tool) {
      case 'click': {
        const directVisionPoint = OVERLAY_VISION_MODE
          ? this.getVisionCoordinatePoint(action)
          : null;
        if (!action.bbox && !directVisionPoint) {
          throw new Error('Click action missing bbox');
        }
        // Check if this is a menuitem (needs special handling)
        const params = action.params as ClickParams;
        const resolvedTarget = this.resolveFreshExecutionTarget(action);
        const elementId = resolvedTarget.elementId;
        const targetElement = resolvedTarget.targetElement;
        this.syncActionBBoxWithTarget(action, display, targetElement);
        let interactionKind: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option' = 'default';
        let interactionText: string | undefined;
        if (targetElement) {
          const element = targetElement;
          if (element.role === 'AXMenuItem') {
            const focusedDropdown = this.focusedMenuElementId
              ? this.formFieldStore.get(this.focusedMenuElementId)
              : null;
            if (focusedDropdown && this.isDropdownControlRole(focusedDropdown.role)) {
              interactionKind = 'dropdown-option';
              interactionText = this.getDropdownOptionTypeaheadText(focusedDropdown.label, element.label);
            } else {
              interactionKind = 'menuitem';
              interactionText = this.getMenuItemTypeaheadText(element.label);
            }
            this.focusedMenuElementId = null;
          } else if (element.role === 'AXRadioButton') {
            interactionKind = 'radio';
            this.focusedMenuElementId = null;
          } else if (element.role === 'AXCheckBox') {
            interactionKind = 'checkbox';
            this.focusedMenuElementId = null;
          } else if (element.role === 'AXButton') {
            interactionKind = 'button';
            this.focusedMenuElementId = null;
          } else if (this.isDropdownOptionElement(element)) {
            if (!this.focusedMenuElementId) {
              throw new Error('Dropdown option IDs went stale. Reopen the dropdown, refresh the tree, and click the revealed option immediately.');
            }
            const dropdown = this.formFieldStore.get(this.focusedMenuElementId);
            const parsed = this.parseDropdownOptionLabel(element.label);
            if (!dropdown || !parsed || !this.isDropdownControlRole(dropdown.role) || this.normalizeDropdownFieldLabel(dropdown.label) !== this.normalizeDropdownFieldLabel(parsed.fieldLabel)) {
              throw new Error('Dropdown option no longer matches the currently opened dropdown. Reopen the dropdown and refresh the tree.');
            }
            interactionKind = 'dropdown-option';
            interactionText = this.getDropdownOptionTypeaheadText(parsed.fieldLabel, parsed.optionText);
          } else if (element.role === 'AXPopUpButton' || element.role === 'AXMenuButton') {
            this.focusedMenuElementId = elementId || null;
          } else {
            this.focusedMenuElementId = null;
          }
        } else {
          this.focusedMenuElementId = null;
        }

        const center = directVisionPoint ?? this.resolveInteractionPoint(action, display, targetElement);
        if (!OVERLAY_VISION_MODE && !boundsContainsPoint(this.getActiveViewportOrThrow(), center)) {
          throw new Error('Resolved click target falls outside the selected scope.');
        }
        if (OVERLAY_VISION_MODE) {
          this.lastVisionInteractionPoint = center;
        }
        this.ui.blur();
        if (targetElement?.browserPage) {
          if (!this.auto.clickBrowserPageElement) {
            throw new Error('Browser page click execution is unavailable.');
          }
          await this.auto.clickBrowserPageElement(targetElement.browserPage);
          break;
        }
        if (targetElement?.nativeCua) {
          if (!this.auto.clickNativeCuaElement) {
            throw new Error('Native CUA click execution is unavailable.');
          }
          await this.auto.clickNativeCuaElement(targetElement.nativeCua);
          break;
        }
        const windowsNativeCuaTarget = !OVERLAY_VISION_MODE
          && process.platform === 'win32'
          && typeof elementId === 'string'
          && (
            interactionKind === 'default'
            || interactionKind === 'button'
            || interactionKind === 'radio'
            || interactionKind === 'checkbox'
          )
          ? this.buildNativeCuaElementTargetFromWindowsUiaId(elementId)
          : null;
        if (windowsNativeCuaTarget) {
          if (!this.auto.clickNativeCuaElement) {
            throw new Error('Native CUA click execution is unavailable.');
          }
          await this.auto.clickNativeCuaElement(windowsNativeCuaTarget);
          break;
        }
        if (!OVERLAY_VISION_MODE && process.platform === 'win32' && typeof elementId === 'string' && isWindowsUiaElementId(elementId)) {
          this.assertWindowsUiaElementHasNoAttachedNativeCuaTarget(elementId);
          throw new Error(`Windows UIA element ${elementId} requires an attached native CUA target identity.`);
        }
        const nativeCuaPointClickEligible = (!OVERLAY_VISION_MODE || this.activeTargetIdentity?.kind === 'active-app')
          && (
            interactionKind === 'default'
            || interactionKind === 'button'
            || interactionKind === 'menuitem'
            || interactionKind === 'radio'
            || interactionKind === 'checkbox'
            || interactionKind === 'dropdown-option'
          );
        const nativeCuaPointTarget = nativeCuaPointClickEligible
          ? this.buildNativeCuaPointTarget(center)
          : null;
        if (nativeCuaPointTarget) {
          if (!this.auto.clickNativeCuaPoint) {
            throw new Error('Native CUA point-click execution is unavailable.');
          }
          await this.auto.clickNativeCuaPoint(nativeCuaPointTarget);
          break;
        }
        if (nativeCuaPointClickEligible && this.activeTargetIdentity?.kind === 'active-app') {
          throw new Error('Active app click requires a native CUA target identity.');
        }
        if (targetElement) {
          throw new Error(`Overlay click target ${targetElement.id} requires a native CUA or browser ref.`);
        }
        // This is the explicit raw screen-coordinate primitive for unscoped
        // clicks. Observed targets and app-window targets have already routed
        // through unified native/browser CUA above or failed loudly.
        await this.auto.click(this.toAutomationPoint(center, display), interactionKind, interactionText, null);
        break;
      }

      case 'type': {
        const params = action.params as TypeParams;
        const text = params.text;
        if (typeof text !== 'string') {
          throw new Error('Type action requires text');
        }
        const resolvedTarget = this.resolveFreshExecutionTarget(action, this.focusedMenuElementId || undefined);
        const elementId = resolvedTarget.elementId;
        const targetElement = resolvedTarget.targetElement;
        this.syncActionBBoxWithTarget(action, display, targetElement);
        const isDropdownTarget = targetElement
          ? this.isDropdownControlRole(targetElement.role)
          : false;
        const explicitClearFirst = params.clear_first ?? false;
        const clearFirst = this.shouldClearTextBeforeTyping(targetElement, text, explicitClearFirst);
        this.ui.blur();
        if (isDropdownTarget) {
          const directVisionPoint = OVERLAY_VISION_MODE
            ? this.getVisionCoordinatePoint(action)
            : null;
          const center = directVisionPoint ?? this.resolveInteractionPoint(action, display, targetElement);
          if (!OVERLAY_VISION_MODE && !boundsContainsPoint(this.getActiveViewportOrThrow(), center)) {
            throw new Error('Resolved dropdown target falls outside the selected scope.');
          }
          if (OVERLAY_VISION_MODE) {
            this.lastVisionInteractionPoint = center;
          }
          if (targetElement?.nativeCua) {
            if (!this.auto.selectNativeCuaElementOption) {
              throw new Error('Native CUA dropdown execution is unavailable.');
            }
            await this.auto.selectNativeCuaElementOption(targetElement.nativeCua, text);
            this.focusedMenuElementId = null;
            await new Promise(resolve => setTimeout(resolve, DROPDOWN_OPEN_SETTLE_DELAY_MS));
            if (!this.nativeCuaSelectOptionOwnsVerification(targetElement.nativeCua)) {
              await this.assertDropdownTypeApplied(elementId, targetElement, text);
            }
            break;
          }
          if (targetElement?.browserPage) {
            if (!this.auto.selectBrowserPageElementOption) {
              throw new Error('Browser page select execution is unavailable.');
            }
            await this.auto.selectBrowserPageElementOption(targetElement.browserPage, text);
            this.focusedMenuElementId = null;
            await new Promise(resolve => setTimeout(resolve, DROPDOWN_OPEN_SETTLE_DELAY_MS));
            break;
          }
          if (!OVERLAY_VISION_MODE && process.platform === 'win32' && typeof elementId === 'string' && isWindowsUiaElementId(elementId)) {
            const nativeCuaTarget = this.buildNativeCuaElementTargetFromWindowsUiaId(elementId);
            if (nativeCuaTarget) {
              if (!this.auto.selectNativeCuaElementOption) {
                throw new Error('Native CUA dropdown execution is unavailable.');
              }
              await this.auto.selectNativeCuaElementOption(nativeCuaTarget, text);
              this.focusedMenuElementId = null;
              await new Promise(resolve => setTimeout(resolve, DROPDOWN_OPEN_SETTLE_DELAY_MS));
              await this.assertDropdownTypeApplied(elementId, targetElement, text);
              break;
            }
            this.assertWindowsUiaElementHasNoAttachedNativeCuaTarget(elementId);
            throw new Error(`Windows UIA dropdown ${elementId} requires an attached native CUA target identity.`);
          }
          if (!OVERLAY_VISION_MODE && process.platform === 'darwin' && targetElement && this.buildNativeCuaAppWindowTarget()) {
            throw new Error(`macOS AX dropdown target ${targetElement.id} requires a native CUA selected ref.`);
          }
          if (targetElement) {
            throw new Error(`Overlay dropdown target ${targetElement.id} requires a native CUA or browser ref.`);
          }
        } else {
          this.focusedMenuElementId = null;
          if (targetElement?.nativeCua && clearFirst) {
            if (!this.auto.setNativeCuaElementValue) {
              throw new Error('Native CUA value execution is unavailable.');
            }
            await this.auto.setNativeCuaElementValue(targetElement.nativeCua, text);
            break;
          }
          if (targetElement?.browserPage) {
            if (!this.auto.typeBrowserPageElement) {
              throw new Error('Browser page type execution is unavailable.');
            }
            await this.auto.typeBrowserPageElement(targetElement.browserPage, text);
            break;
          }
          if (targetElement?.nativeCua) {
            if (!this.auto.typeNativeCuaElementText) {
              throw new Error('Native CUA text execution is unavailable.');
            }
            await this.auto.typeNativeCuaElementText(targetElement.nativeCua, text);
            break;
          }
          if (targetElement) {
            if (!OVERLAY_VISION_MODE && process.platform === 'darwin' && this.buildNativeCuaAppWindowTarget()) {
              throw new Error(`macOS AX typing target ${targetElement.id} requires a native CUA selected ref.`);
            }
            if (!(process.platform === 'win32' && isWindowsUiaElementId(targetElement.id))) {
              throw new Error(`Overlay typing target ${targetElement.id} requires a native CUA or browser ref.`);
            }
            await this.focusAndTypeIntoVerifiedTarget(action, targetElement, text, clearFirst);
          } else if (OVERLAY_VISION_MODE) {
            const anchorPoint = action.visionAnchorPx ?? this.lastVisionInteractionPoint;
            const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();
            if (nativeCuaTarget) {
              if (clearFirst) {
                throw new Error('Native CUA focused replacement typing requires an explicit element target.');
              }
              if (!this.auto.typeNativeCuaAppWindowText) {
                throw new Error('Native CUA app-window text execution is unavailable.');
              }
              await this.auto.typeNativeCuaAppWindowText(nativeCuaTarget, text);
            } else if (this.activeTargetIdentity?.kind === 'active-app') {
              throw new Error('Active app typing requires a native CUA target identity.');
            } else {
              // Explicit raw focused-control primitive for unscoped vision use.
              await this.auto.typeFocused(text, clearFirst, this.toAutomationPointOrNull(anchorPoint, display), null);
            }
          } else if (!action.bbox) {
            const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();
            if (nativeCuaTarget) {
              if (clearFirst) {
                throw new Error('Native CUA focused replacement typing requires an explicit element target.');
              }
              if (!this.auto.typeNativeCuaAppWindowText) {
                throw new Error('Native CUA app-window text execution is unavailable.');
              }
              await this.auto.typeNativeCuaAppWindowText(nativeCuaTarget, text);
            } else if (this.activeTargetIdentity?.kind === 'active-app') {
              throw new Error('Active app typing requires a native CUA target identity.');
            } else {
              // Explicit raw focused-control primitive for targetless typing.
              await this.auto.typeFocused(text, clearFirst, this.lastVisionInteractionPoint, null);
            }
          } else {
            const directVisionPoint = OVERLAY_VISION_MODE
              ? this.getVisionCoordinatePoint(action)
              : null;
            const center = directVisionPoint ?? this.resolveInteractionPoint(action, display, targetElement);
            if (!OVERLAY_VISION_MODE && !boundsContainsPoint(this.getActiveViewportOrThrow(), center)) {
              throw new Error('Resolved typing target falls outside the selected scope.');
            }
            if (OVERLAY_VISION_MODE && !action.visionAnchorPx) {
              this.lastVisionInteractionPoint = center;
            }
            if (!OVERLAY_VISION_MODE && this.activeTargetIdentity?.kind === 'active-app') {
              throw new Error('Active app typing requires a native CUA target identity.');
            }
            // Explicit raw screen-coordinate primitive for unscoped typing.
            await this.auto.typeAt(this.toAutomationPoint(center, display), text, clearFirst, null);
          }
        }
        break;
      }

      case 'hotkey': {
        const hotkey = (action.params as HotkeyParams).hotkey;
        if (!hotkey) {
          throw new Error('Hotkey action is missing a hotkey string.');
        }
        if (this.hasScopedViewport()) {
          const scopedScroll = OVERLAY_VISION_MODE ? getScopedScrollForHotkey(hotkey) : null;
          if (scopedScroll) {
            const viewport = this.getActiveViewportOrThrow();
            const center = {
              x: viewport.x + (viewport.width / 2),
              y: viewport.y + (viewport.height / 2),
            };
            this.focusedMenuElementId = null;
            this.lastVisionInteractionPoint = center;
            this.ui.blur();
            const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();
            if (nativeCuaTarget) {
              if (!this.auto.scrollNativeCuaAppWindow) {
                throw new Error('Native CUA app-window scroll execution is unavailable.');
              }
              await this.auto.scrollNativeCuaAppWindow(nativeCuaTarget, scopedScroll.direction, scopedScroll.amount);
            } else if (this.activeTargetIdentity?.kind === 'active-app') {
              throw new Error('Active app scroll requires a native CUA target identity.');
            } else {
              await this.auto.scroll(this.toAutomationPoint(center, display), scopedScroll.direction, scopedScroll.amount);
            }
            break;
          }
          if (isScopedFocusedControlHotkeyAllowed(hotkey)) {
            const viewport = this.getActiveViewportOrThrow();
            const center = {
              x: viewport.x + (viewport.width / 2),
              y: viewport.y + (viewport.height / 2),
            };
            this.focusedMenuElementId = null;
            this.ui.blur();
            const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();
            if (nativeCuaTarget) {
              if (!this.auto.pressNativeCuaKey) {
                throw new Error('Native CUA key execution is unavailable.');
              }
              await this.auto.pressNativeCuaKey(nativeCuaTarget, hotkey);
            } else if (this.activeTargetIdentity?.kind === 'active-app') {
              throw new Error('Active app hotkey requires a native CUA target identity.');
            } else {
              await this.auto.pressHotkey(hotkey, this.toAutomationPoint(center, display));
            }
            break;
          }
          if (OVERLAY_VISION_MODE) {
            console.warn('[RunEngine] Ignoring unsafe scoped vision hotkey', { hotkey });
            this.focusedMenuElementId = null;
            break;
          }
          throw new Error('Hotkey actions are disabled while a scope is active. Click or type inside the selected region instead.');
        }
        this.ui.blur();
        const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();
        if (nativeCuaTarget) {
          if (!this.auto.pressNativeCuaKey) {
            throw new Error('Native CUA key execution is unavailable.');
          }
          await this.auto.pressNativeCuaKey(nativeCuaTarget, hotkey);
        } else if (this.activeTargetIdentity?.kind === 'active-app') {
          throw new Error('Active app hotkey requires a native CUA target identity.');
        } else {
          await this.auto.pressHotkey(hotkey, this.toAutomationPointOrNull(this.getHotkeyActivationPoint(), display));
        }
        const normalizedHotkey = hotkey.trim().toLowerCase();
        if (normalizedHotkey === 'enter' || normalizedHotkey === 'return' || normalizedHotkey === 'esc' || normalizedHotkey === 'escape' || normalizedHotkey === 'tab') {
          this.focusedMenuElementId = null;
        }
        break;
      }

      case 'scroll': {
        const directVisionPoint = OVERLAY_VISION_MODE
          ? this.getVisionCoordinatePoint(action)
          : null;
        if (!action.bbox && !directVisionPoint) {
          throw new Error('Scroll action missing target bbox');
        }
        const params = action.params as ScrollParams;
        const amount = Math.max(1, Math.round(Math.abs(params.amount ?? DEFAULT_SCROLL_AMOUNT)));
        const resolvedTarget = this.resolveFreshExecutionTarget(action);
        const targetElement = resolvedTarget.targetElement;
        this.syncActionBBoxWithTarget(action, display, targetElement);
        const center = directVisionPoint ?? this.resolveInteractionPoint(action, display, targetElement);
        if (!OVERLAY_VISION_MODE && !boundsContainsPoint(this.getActiveViewportOrThrow(), center)) {
          throw new Error('Resolved scroll target falls outside the selected scope.');
        }
        if (OVERLAY_VISION_MODE) {
          this.lastVisionInteractionPoint = center;
        }
        this.ui.blur();
        if (targetElement?.browserPage) {
          if (!this.auto.scrollBrowserPageElement) {
            throw new Error('Browser page scroll execution is unavailable.');
          }
          await this.auto.scrollBrowserPageElement(targetElement.browserPage, params.direction, amount);
          this.focusedMenuElementId = null;
          break;
        }
        if (targetElement?.nativeCua) {
          if (!this.auto.scrollNativeCuaElement) {
            throw new Error('Native CUA scroll execution is unavailable.');
          }
          await this.auto.scrollNativeCuaElement(targetElement.nativeCua, params.direction, amount);
          this.focusedMenuElementId = null;
          break;
        }
        if (!OVERLAY_VISION_MODE && process.platform === 'win32' && targetElement && isWindowsUiaElementId(targetElement.id)) {
          const nativeCuaTarget = this.buildNativeCuaElementTargetFromWindowsUiaId(targetElement.id);
          if (nativeCuaTarget) {
            if (!this.auto.scrollNativeCuaElement) {
              throw new Error('Native CUA scroll execution is unavailable.');
            }
            await this.auto.scrollNativeCuaElement(nativeCuaTarget, params.direction, amount);
            this.focusedMenuElementId = null;
            break;
          }
          this.assertWindowsUiaElementHasNoAttachedNativeCuaTarget(targetElement.id);
          throw new Error(`Windows UIA element ${targetElement.id} requires an attached native CUA target identity.`);
        }
        const nativeCuaTarget = this.buildNativeCuaAppWindowTarget();
        if (nativeCuaTarget) {
          if (!this.auto.scrollNativeCuaAppWindow) {
            throw new Error('Native CUA app-window scroll execution is unavailable.');
          }
          await this.auto.scrollNativeCuaAppWindow(nativeCuaTarget, params.direction, amount);
        } else if (this.activeTargetIdentity?.kind === 'active-app') {
          throw new Error('Active app scroll requires a native CUA target identity.');
        } else if (targetElement) {
          throw new Error(`Overlay scroll target ${targetElement.id} requires a native CUA or browser ref.`);
        } else {
          // Explicit raw screen-coordinate primitive for unscoped scrolling.
          await this.auto.scroll(this.toAutomationPoint(center, display), params.direction, amount);
        }
        this.focusedMenuElementId = null;
        break;
      }

      case 'screenshot': {
        // Screenshot execution is handled as boundary
        await this.executeScreenshotBoundary(action);
        break;
      }
    }
  }

  private shouldRefreshAfterAction(action: Action): boolean {
    if (OVERLAY_VISION_MODE) {
      return false;
    }
    return action.tool === 'click' || action.tool === 'scroll' || action.tool === 'type' || action.tool === 'hotkey';
  }

  private nativeCuaSelectOptionOwnsVerification(target: NativeCuaElementTarget): boolean {
    return target.targetIdentity?.platform === 'darwin';
  }

  private async assertDropdownTypeApplied(
    elementId: string | undefined,
    targetElement: ScreenElement | undefined,
    expectedText: string,
  ): Promise<void> {
    let lastRefreshError: string | null = null;
    let snapshot: StructuredScreenSnapshot;
    try {
      snapshot = await this.captureStructuredRefreshSnapshotWithTimeout(DROPDOWN_VALUE_VERIFY_TIMEOUT_MS, {
        updateState: false,
      });
    } catch (error) {
      lastRefreshError = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Dropdown "${targetElement?.label || elementId || 'unknown'}" could not be verified after selecting "${expectedText}". Structured refresh error: ${lastRefreshError}`,
      );
    }
    const startedAt = Date.now();
    while (!this.dropdownSnapshotShowsExpected(snapshot, elementId, targetElement, expectedText)) {
      if (Date.now() - startedAt >= DROPDOWN_VALUE_VERIFY_TIMEOUT_MS) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, DROPDOWN_VALUE_VERIFY_INTERVAL_MS));
      const remainingMs = Math.max(1, DROPDOWN_VALUE_VERIFY_TIMEOUT_MS - (Date.now() - startedAt));
      try {
        snapshot = await this.captureStructuredRefreshSnapshotWithTimeout(remainingMs, {
          updateState: false,
        });
      } catch (error) {
        lastRefreshError = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    if (this.dropdownSnapshotShowsExpected(snapshot, elementId, targetElement, expectedText)) {
      return;
    }

    throw new Error(
      `Dropdown "${targetElement?.label || elementId || 'unknown'}" did not visibly change to "${expectedText}". Re-read the latest tree and interact with that dropdown again before continuing.${lastRefreshError ? ` Structured refresh error: ${lastRefreshError}` : ''}`,
    );
  }

  private dropdownSnapshotShowsExpected(
    snapshot: StructuredScreenSnapshot,
    elementId: string | undefined,
    targetElement: ScreenElement | undefined,
    expectedText: string,
  ): boolean {
    const normalizedExpected = this.normalizeTypedTextValue(expectedText);
    const compactExpected = this.normalizeDropdownComparableText(expectedText);
    const normalizedTargetLabel = this.normalizeElementLabel(targetElement?.label ?? '');
    const containmentRatio = (left: ScreenElement['bbox'], right: ScreenElement['bbox']): number => {
      const leftX2 = left.x + left.width;
      const leftY2 = left.y + left.height;
      const rightX2 = right.x + right.width;
      const rightY2 = right.y + right.height;
      const intersectionX1 = Math.max(left.x, right.x);
      const intersectionY1 = Math.max(left.y, right.y);
      const intersectionX2 = Math.min(leftX2, rightX2);
      const intersectionY2 = Math.min(leftY2, rightY2);
      const intersectionWidth = Math.max(0, intersectionX2 - intersectionX1);
      const intersectionHeight = Math.max(0, intersectionY2 - intersectionY1);
      const intersectionArea = intersectionWidth * intersectionHeight;
      if (intersectionArea === 0) {
        return 0;
      }
      return intersectionArea / Math.max(1, Math.min(left.width * left.height, right.width * right.height));
    };
    const centerDistance = (left: ScreenElement['bbox'], right: ScreenElement['bbox']): number => (
      Math.hypot(
        (left.x + left.width / 2) - (right.x + right.width / 2),
        (left.y + left.height / 2) - (right.y + right.height / 2),
      )
    );
    const geometryMatch = targetElement
      ? snapshot.elements
        .filter((element) => this.isDropdownControlRole(element.role))
        .map((element) => ({
          element,
          overlap: containmentRatio(element.bbox, targetElement.bbox),
          distance: centerDistance(element.bbox, targetElement.bbox),
        }))
        .filter((entry) => entry.overlap >= 0.5 || entry.distance <= 24)
        .sort((left, right) => (right.overlap - left.overlap) || (left.distance - right.distance))[0]?.element
      : undefined;
    const idMatch = elementId
      ? snapshot.elements.find((element) => element.id === elementId && this.isDropdownControlRole(element.role))
      : undefined;
    const labelMatch = snapshot.elements.find((element) => (
      this.isDropdownControlRole(element.role)
      && normalizedTargetLabel.length > 0
      && this.normalizeElementLabel(element.label) === normalizedTargetLabel
    ));
    const candidates = [idMatch, labelMatch, geometryMatch].filter((element): element is ScreenElement => Boolean(element));

    if (candidates.some((element) => {
      const observedText = [
        'value' in element ? element.value : undefined,
        element.option,
      ].filter(Boolean).join(' ');
      const observedValue = this.normalizeTypedTextValue(observedText);
      const compactObservedValue = this.normalizeDropdownComparableText(observedText);
      return observedValue.includes(normalizedExpected)
        || (compactExpected.length > 0 && compactObservedValue.includes(compactExpected));
    })) {
      return true;
    }

    if (this.structuredDropdownTextShowsExpected(snapshot.formattedText, elementId, targetElement, expectedText)) {
      return true;
    }
    return false;
  }

  private structuredDropdownTextShowsExpected(
    formattedText: string,
    elementId: string | undefined,
    targetElement: ScreenElement | undefined,
    expectedText: string,
  ): boolean {
    const normalizedExpected = this.normalizeTypedTextValue(expectedText);
    const compactExpected = this.normalizeDropdownComparableText(expectedText);
    const normalizedTargetLabel = this.normalizeElementLabel(targetElement?.label ?? '');
    return formattedText
      .split('\n')
      .some((line) => {
        if (!line.includes('<dropdown')) {
          return false;
        }
        if (elementId && !line.includes(`id="${elementId}"`)) {
          return false;
        }
        if (!elementId && normalizedTargetLabel.length > 0 && !this.normalizeElementLabel(line).includes(normalizedTargetLabel)) {
          return false;
        }
        return this.normalizeTypedTextValue(line).includes(normalizedExpected)
          || (compactExpected.length > 0 && this.normalizeDropdownComparableText(line).includes(compactExpected));
      });
  }

  private normalizeDropdownComparableText(value: string): string {
    return this.normalizeTypedTextValue(value).replace(/\s+/g, '');
  }

  private shouldDeferRefreshForAcceptedPreviewBatch(action: Action): boolean {
    return !!action.previewBatchId;
  }

  private shouldClearTextBeforeTyping(
    targetElement: ScreenElement | undefined,
    text: string,
    explicitClearFirst: boolean,
  ): boolean {
    if (!targetElement) {
      return explicitClearFirst;
    }
    if (!this.isTextEntryRole(targetElement.role)) {
      return false;
    }
    if (explicitClearFirst && process.platform === 'win32' && !OVERLAY_VISION_MODE) {
      return true;
    }
    if (explicitClearFirst && targetElement.nativeCua && !OVERLAY_VISION_MODE) {
      return true;
    }
    const normalizedCurrent = this.normalizeTypedTextValue(targetElement.value ?? '');
    const normalizedExpected = this.normalizeTypedTextValue(text);
    if (explicitClearFirst && normalizedCurrent.length === 0) {
      console.log('[RunEngine] Skipping clear-first for empty text target', {
        targetId: targetElement.id,
        targetLabel: targetElement.label,
      });
      return false;
    }
    if (explicitClearFirst) {
      return true;
    }
    return normalizedCurrent.length > 0 && normalizedCurrent !== normalizedExpected;
  }

  private async captureStructuredRefreshSnapshot(options?: { updateState?: boolean }): Promise<StructuredScreenSnapshot> {
    const display = this.activeDisplay ?? this.capture.getActiveDisplay();
    const viewport = this.activeViewport ?? { ...display.boundsDIP };
    const segmentedResult = await performSegmentedOCR(Buffer.alloc(0), display.scaleFactor, {
      scopeBounds: viewport,
      targetPid: this.activeTargetPid,
      targetWindowId: this.activeTargetWindowId,
    });
    const normalizedContext = normalizeStructuredContext(segmentedResult.formattedText, segmentedResult.elements);
    if (options?.updateState === false) {
      return this.createStructuredSnapshot(
        normalizedContext.formattedText,
        normalizedContext.elements,
      );
    }

    return this.applyStructuredContextToState(
      normalizedContext.formattedText,
      normalizedContext.elements,
    );
  }

  private async captureStructuredRefreshSnapshotWithTimeout(
    timeoutMs: number,
    options?: { updateState?: boolean },
  ): Promise<StructuredScreenSnapshot> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.captureStructuredRefreshSnapshot(options),
        new Promise<StructuredScreenSnapshot>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Structured refresh timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private resolveFreshExecutionTarget(
    action: Action,
    fallbackElementId?: string,
  ): { elementId?: string; targetElement?: ScreenElement } {
    if (OVERLAY_VISION_MODE) {
      const elementTarget = this.getActionElementTarget(action);
      const elementId = elementTarget?.elementId || fallbackElementId;
      return {
        elementId,
        targetElement: elementId ? this.formFieldStore.get(elementId) : undefined,
      };
    }

    const elementTarget = this.getActionElementTarget(action);
    let elementId = elementTarget?.elementId || fallbackElementId;
    const query = elementTarget?.query;

    if (elementId) {
      const currentElement = this.formFieldStore.get(elementId);
      if (currentElement && (!this.activeViewport || this.getScopedElementBBox(currentElement))) {
        const matchedTarget = action.tool === 'type'
          ? this.resolveTypingTarget(currentElement)
          : currentElement;
        elementId = matchedTarget.id;
        if (action.tool === 'click' || action.tool === 'type' || action.tool === 'scroll') {
          action.params = {
            ...(action.params as ClickParams | TypeParams | ScrollParams),
            element_id: elementId,
          };
        }
        return { elementId, targetElement: matchedTarget };
      }
    }

    const descriptionMatch = this.findUniqueElementByDescription(query, action.tool);
    if (descriptionMatch) {
      const matchedTarget = action.tool === 'type'
        ? this.resolveTypingTarget(descriptionMatch)
        : descriptionMatch;
      elementId = matchedTarget.id;
      if (action.tool === 'click' || action.tool === 'type' || action.tool === 'scroll') {
        action.params = {
          ...(action.params as ClickParams | TypeParams | ScrollParams),
          element_id: elementId,
        };
      }
      return { elementId, targetElement: matchedTarget };
    }

    if (query) {
      throw new Error(`Could not rebind ${action.tool} target "${query}" in the current accessibility tree. Re-read the latest tree before continuing.`);
    }

    if (process.platform === 'win32' && action.previewBatchId && elementId) {
      throw new Error(`Windows approved batch ${action.tool} target "${elementId}" is missing element_description, so it cannot be safely rebound after an accessibility refresh.`);
    }

    return {
      elementId,
      targetElement: elementId ? this.formFieldStore.get(elementId) : undefined,
    };
  }

  private async focusAndTypeIntoVerifiedTarget(
    action: Action,
    targetElement: ScreenElement,
    text: string,
    clearFirst: boolean,
  ): Promise<void> {
    const targetingStart = Date.now();
    const expectedBBox = this.getExpectedTypingTargetBBox(action, this.capture.getActiveDisplay(), targetElement);
    const scopedTargetElement = { ...targetElement, bbox: expectedBBox };
    const verifiedPoint = OVERLAY_VERIFIED_POINT_DISABLED
      ? null
      : findVerifiedPointForElement(scopedTargetElement);
    if (!OVERLAY_VERIFIED_POINT_DISABLED) {
      const blockingOverlay = this.findBlockingInteractiveOverlay(scopedTargetElement);
      if (blockingOverlay) {
        console.warn('[RunEngine] Typing target currently intercepted before click', {
          targetId: targetElement.id,
          targetLabel: targetElement.label,
          blockerId: blockingOverlay.blocker.id,
          blockerRole: blockingOverlay.blocker.role,
          blockerLabel: blockingOverlay.blocker.label,
          ownerId: blockingOverlay.owner?.id ?? null,
          ownerRole: blockingOverlay.owner?.role ?? null,
          ownerLabel: blockingOverlay.owner?.label ?? null,
        });
        throw new Error(this.buildTypingTargetUnavailableError(targetElement));
      }
    }
    if (!OVERLAY_VERIFIED_POINT_DISABLED && (
      !verifiedPoint
      || verifiedPoint.kind !== 'match'
      || !boundsContainsPoint(this.getActiveViewportOrThrow(), verifiedPoint.point)
    )) {
      throw new Error(this.buildVerifiedPointError(targetElement, verifiedPoint, 'typing point'));
    }
    const displayForPoint = this.activeDisplay ?? this.capture.getActiveDisplay();
    const probeStart = Date.now();
    const candidatePoints = this.getTypingFocusCandidatePoints(
      scopedTargetElement.bbox,
      scopedTargetElement,
      verifiedPoint?.kind === 'match' ? verifiedPoint.point : undefined,
    );
    console.log(
      `[RunEngine] [TARGETING_TIMING] type-start seq=${action.seq} target=${targetElement.id} probes=${candidatePoints.length}`,
    );

    if (!OVERLAY_VISION_MODE && process.platform === 'win32' && isWindowsUiaElementId(targetElement.id)) {
      console.log('[RunEngine] Typing into Windows AX target by element reference', {
        expectedId: targetElement.id,
        expectedLabel: targetElement.label,
      });
      const nativeCuaTarget = this.buildNativeCuaElementTargetFromWindowsUiaId(targetElement.id);
      if (nativeCuaTarget) {
        if (clearFirst) {
          if (!this.auto.setNativeCuaElementValue) {
            throw new Error('Native CUA value execution is unavailable.');
          }
          await this.auto.setNativeCuaElementValue(nativeCuaTarget, text);
        } else {
          if (!this.auto.typeNativeCuaElementText) {
            throw new Error('Native CUA text execution is unavailable.');
          }
          await this.auto.typeNativeCuaElementText(nativeCuaTarget, text);
        }
        console.log(
          `[RunEngine] [TARGETING_TIMING] type-complete-windows-cua seq=${action.seq} target=${targetElement.id} probeIndex=0 probeDurationMs=${Date.now() - probeStart} totalDurationMs=${Date.now() - targetingStart}`,
        );
        return;
      }
      this.assertWindowsUiaElementHasNoAttachedNativeCuaTarget(targetElement.id);
      throw new Error(`Windows UIA element ${targetElement.id} requires an attached native CUA target identity.`);
    }

    let lastProbePoint: { x: number; y: number } | null = null;
    for (let probeIndex = 0; probeIndex < candidatePoints.length; probeIndex += 1) {
      const point = candidatePoints[probeIndex];
      lastProbePoint = point;
      const automationPoint = this.toAutomationPoint(point, displayForPoint);
      await this.auto.click(automationPoint, 'default', undefined, expectedBBox);
      await new Promise((resolve) => setTimeout(resolve, TYPE_TARGET_FOCUS_VERIFY_DELAY_MS));

      const focusedTarget = await this.getFocusedTypingTarget(expectedBBox, targetElement);
      if (focusedTarget) {
        const durationMs = Date.now() - targetingStart;
        const probeDurationMs = Date.now() - probeStart;
        console.log('[RunEngine] Verified typing focus target', {
          expectedId: targetElement.id,
          focusedId: focusedTarget.id,
          focusedLabel: focusedTarget.label,
          point,
        });
        console.log(
          `[RunEngine] [TARGETING_TIMING] type-focus-verified seq=${action.seq} target=${targetElement.id} probeIndex=${probeIndex} probeDurationMs=${probeDurationMs} totalDurationMs=${durationMs}`,
        );
        await this.auto.typeFocused(text, clearFirst, point, expectedBBox);
        console.log(
          `[RunEngine] [TARGETING_TIMING] type-complete seq=${action.seq} target=${targetElement.id} totalDurationMs=${Date.now() - targetingStart}`,
        );
        return;
      }
    }

    const finalFocusedElement = this.getFocusedInteractiveElement();
    console.warn('[RunEngine] Typing focus verification miss', {
      expectedId: targetElement.id,
      expectedLabel: targetElement.label,
      point: lastProbePoint,
      actualFocusedId: finalFocusedElement?.id ?? null,
      actualFocusedLabel: finalFocusedElement?.label ?? null,
    });
    console.warn(
      `[RunEngine] [TARGETING_TIMING] type-focus-miss seq=${action.seq} target=${targetElement.id} probeIndex=0 probeDurationMs=${Date.now() - probeStart} totalDurationMs=${Date.now() - targetingStart}`,
    );
    console.error(
      `[RunEngine] [TARGETING_TIMING] type-failed seq=${action.seq} target=${targetElement.id} totalDurationMs=${Date.now() - targetingStart}`,
    );
    throw new Error(this.buildTypingFocusVerificationError(targetElement, finalFocusedElement));
  }

  private normalizeDescription(value: string | undefined): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/[‐‑‒–—―−]/g, '-')
      .replace(/^\*\s*/, '')
      .replace(/\s+/g, ' ');
  }

  private resolveTypingTarget(element: ScreenElement): ScreenElement {
    const companion = resolveTypingTargetElement(this.formFieldStore.values(), element);
    if (companion.id !== element.id) {
      console.log(
        `[RunEngine] Redirecting type target from label "${element.label}" (${element.id}) to editable field (${companion.id})`,
      );
      return companion;
    }

    if (!isLikelyFieldLabel(element) && !this.isDropdownControlRole(element.role)) {
      return element;
    }

    const expectedBBox = element.bbox;
    const targetLabel = this.normalizeElementLabel(element.label);
    const bestEditableCompanion = Array.from(this.formFieldStore.values()).find((candidate) => {
      if (!this.isTextEntryRole(candidate.role) || candidate.id === element.id) {
        return false;
      }
      if (!this.isBBoxNear(candidate.bbox, expectedBBox) && this.computeBBoxContainmentRatio(candidate.bbox, expectedBBox) < 0.5) {
        return false;
      }
      const candidateLabel = this.normalizeElementLabel(candidate.label);
      return !targetLabel || !candidateLabel || candidateLabel === targetLabel;
    });

    if (bestEditableCompanion) {
      console.log(
        `[RunEngine] Redirecting shell target "${element.label}" (${element.id}) to nearby editable field (${bestEditableCompanion.id})`,
      );
      return bestEditableCompanion;
    }

    return element;
  }

  private getExpectedTypingTargetBBox(
    action: Action,
    _display: ReturnType<CapturePort['getActiveDisplay']>,
    targetElement?: ScreenElement,
  ): AbsoluteBBox {
    if (targetElement) {
      const scopedTargetBBox = this.getScopedElementBBox(targetElement);
      if (scopedTargetBBox) {
        return scopedTargetBBox;
      }
    }

    if (!action.bbox) {
      throw new Error('Typing action missing bbox');
    }

    return relativeBBoxToBoundsInViewport(action.bbox, this.getActiveViewportOrThrow());
  }

  private resolveInteractionPoint(
    action: Action,
    _display: ReturnType<CapturePort['getActiveDisplay']>,
    targetElement: ScreenElement | undefined,
  ): { x: number; y: number } {
    const directVisionPoint = this.getVisionCoordinatePoint(action);
    if (directVisionPoint) {
      return directVisionPoint;
    }

    const scopedTargetBBox = targetElement ? this.getScopedElementBBox(targetElement) : null;
    const fallback = targetElement
      ? this.getDefaultInteractionPoint(targetElement, scopedTargetBBox ?? targetElement.bbox)
      : (() => {
          if (!action.bbox) {
            throw new Error('Interactive action missing bbox');
          }

          return this.absoluteBBoxCenter(
            relativeBBoxToBoundsInViewport(action.bbox, this.getActiveViewportOrThrow()),
          );
        })();
    if (!targetElement) {
      return fallback;
    }

    const scopedTargetElement = scopedTargetBBox
      ? { ...targetElement, bbox: scopedTargetBBox }
      : targetElement;

    if (OVERLAY_VERIFIED_POINT_DISABLED) {
      return fallback;
    }

    const verified = findVerifiedPointForElement(scopedTargetElement);
    if (verified?.kind === 'match' && boundsContainsPoint(this.getActiveViewportOrThrow(), verified.point)) {
      return verified.point;
    }

    throw new Error(this.buildVerifiedPointError(targetElement, verified, 'point'));
  }

  private getDefaultInteractionPoint(
    targetElement: ScreenElement,
    bbox: AbsoluteBBox,
  ): { x: number; y: number } {
    if (
      (targetElement.role === 'AXCheckBox' || targetElement.role === 'AXRadioButton')
      && bbox.width > bbox.height * 2
      && bbox.height <= 48
    ) {
      const indicatorSize = Math.min(Math.max(bbox.height, 8), CONTROL_INDICATOR_MAX_SIZE);
      return {
        x: bbox.x + (indicatorSize / 2),
        y: bbox.y + (bbox.height / 2),
      };
    }

    return this.absoluteBBoxCenter(bbox);
  }

  private buildVerifiedPointError(
    targetElement: ScreenElement,
    verifiedResult: VerifiedPointResult | null,
    noun: 'point' | 'typing point',
  ): string {
    const targetLabel = targetElement.label || targetElement.id;
    const base = `Could not verify a reachable ${noun} for "${targetLabel}".`;
    if (verifiedResult?.kind === 'blocked') {
      console.warn('[RunEngine] Verified point blocked by different element', {
        targetId: targetElement.id,
        targetLabel,
        hitId: verifiedResult.hit.id,
        hitRole: verifiedResult.hit.role,
        hitLabel: verifiedResult.hit.label,
        hitValue: verifiedResult.hit.value,
      });
    }
    return `${base} Re-read the latest tree and choose a visible reachable element from the diff.`;
  }

  private absoluteBBoxCenter(bbox: AbsoluteBBox): { x: number; y: number } {
    return {
      x: bbox.x + (bbox.width / 2),
      y: bbox.y + (bbox.height / 2),
    };
  }

  private syncActionBBoxWithTarget(
    action: Action,
    _display: ReturnType<CapturePort['getActiveDisplay']>,
    targetElement: ScreenElement | undefined,
  ): void {
    if (!targetElement) {
      return;
    }

    const scopedTargetBBox = this.getScopedElementBBox(targetElement);
    if (!scopedTargetBBox) {
      return;
    }

    action.bbox = this.toScopedRelativeBBox(scopedTargetBBox);
  }

  private isTextEntryRole(role: string): boolean {
    return role === 'AXTextField'
      || role === 'AXTextArea'
      || role === 'AXSearchField'
      || role === 'AXSecureTextField'
      || role === 'AXDateField'
      || role === 'AXTimeField';
  }

  private isTypingCompatibleRole(role: string): boolean {
    return this.isTextEntryRole(role) || this.isDropdownControlRole(role);
  }

  private getTypingFocusPoint(targetElement: ScreenElement): { x: number; y: number } {
    const bbox = this.getScopedElementBBox(targetElement) ?? targetElement.bbox;
    const width = Math.max(bbox.width, 8);
    const height = Math.max(bbox.height, 8);
    const insetX = Math.min(Math.max(18, Math.round(width * 0.08)), Math.max(18, width - 10));

    return {
      x: bbox.x + width - insetX,
      y: bbox.y + (height / 2),
    };
  }

  private getPrimaryTargetProbePoint(targetElement: ScreenElement): { x: number; y: number } {
    const bbox = this.getScopedElementBBox(targetElement) ?? targetElement.bbox;
    const points = this.getTypingFocusCandidatePoints(bbox, targetElement);
    return points[0] ?? this.getTypingFocusPoint(targetElement);
  }

  private getTypingFocusCandidatePoints(
    bbox: AbsoluteBBox,
    targetElement: ScreenElement,
    preferredVerifiedPoint?: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const width = Math.max(bbox.width, 8);
    const height = Math.max(bbox.height, 8);
    const scalar = (start: number, extent: number, fraction: number) => start + (extent * fraction);
    const centerX = scalar(bbox.x, width, TYPE_TARGET_CENTER_FRACTION);
    const leftX = scalar(bbox.x, width, TYPE_TARGET_LEFT_PROBE_FRACTION);
    const rightX = scalar(bbox.x, width, TYPE_TARGET_RIGHT_PROBE_FRACTION);
    const centerY = scalar(bbox.y, height, TYPE_TARGET_CENTER_FRACTION);
    const upperY = scalar(bbox.y, height, TYPE_TARGET_UPPER_PROBE_FRACTION);
    const preferredRightPoint = this.getTypingFocusPoint(targetElement);
    const points = targetElement.role === 'AXTextArea' || height >= 56
      ? [
          ...(preferredVerifiedPoint ? [preferredVerifiedPoint] : []),
          { x: centerX, y: centerY },
          { x: leftX, y: centerY },
          { x: rightX, y: centerY },
          { x: leftX, y: upperY },
          preferredRightPoint,
        ]
      : [
          ...(preferredVerifiedPoint ? [preferredVerifiedPoint] : []),
          { x: centerX, y: centerY },
          { x: leftX, y: centerY },
          { x: rightX, y: centerY },
          preferredRightPoint,
        ];

    const seen = new Set<string>();
    return points.filter((point) => {
      const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).slice(0, TYPE_TARGET_MAX_FOCUS_ATTEMPTS);
  }

  private getFocusedInteractiveElement(): ScreenElement | null {
    return Array.from(this.formFieldStore.values()).find(
      (element) => element.focused === true,
    ) ?? null;
  }

  private async getFocusedTypingTarget(
    expectedBBox: AbsoluteBBox,
    targetElement: ScreenElement,
  ): Promise<ScreenElement | null> {
    const focusedFromCurrentTree = this.findMatchingFocusedTarget(expectedBBox, targetElement);
    if (focusedFromCurrentTree) {
      return focusedFromCurrentTree;
    }

    if (process.platform !== 'darwin') {
      return null;
    }

    try {
      const focusedContext = await getFocusedSelectionContext();
      if (focusedContext?.bounds) {
        const focusedBBox = focusedContext.bounds;
        const iou = this.computeBBoxIou(focusedBBox, expectedBBox);
        const containment = this.computeBBoxContainmentRatio(focusedBBox, expectedBBox);
        if (
          iou >= TYPE_TARGET_GEOMETRY_MATCH_MIN_IOU
          || containment >= TYPE_TARGET_CONTAINMENT_MATCH_MIN_RATIO
          || this.isBBoxNear(focusedBBox, expectedBBox)
        ) {
          return { ...targetElement, bbox: focusedBBox, focused: true };
        }

        console.warn('[RunEngine] Focused selection bounds did not match typing target', {
          expectedId: targetElement.id,
          expectedLabel: targetElement.label,
          expectedBBox,
          focusedBBox,
          iou,
          containment,
        });
      }

      await this.captureStructuredRefreshSnapshot();
      return this.findMatchingFocusedTarget(expectedBBox, targetElement);
    } catch (error) {
      console.warn('[RunEngine] Focused typing target query failed', {
        expectedId: targetElement.id,
        expectedLabel: targetElement.label,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private getHotkeyActivationPoint(): { x: number; y: number } | null {
    if (this.focusedMenuElementId) {
      return null;
    }

    const focusedElement = this.getFocusedInteractiveElement();
    if (focusedElement) {
      return this.absoluteBBoxCenter(this.getScopedElementBBox(focusedElement) ?? focusedElement.bbox);
    }

    return null;
  }

  private findBlockingInteractiveOverlay(
    targetElement: ScreenElement,
  ): { blocker: ScreenElement; owner: ScreenElement | null } | null {
    if (!this.isTypingCompatibleRole(targetElement.role)) {
      return null;
    }

    const focusedElement = this.getFocusedInteractiveElement();
    const popupOwners = Array.from(this.formFieldStore.values()).filter((element) => (
      this.isPopupOwnerRole(element.role)
      && element.id !== targetElement.id
    ));
    const openOverlays = Array.from(this.formFieldStore.values()).filter((element) => (
      this.isBlockingOverlayRole(element.role)
      && element.id !== targetElement.id
    ));

    if (
      focusedElement
      && (
        focusedElement.id === targetElement.id
        || this.isMatchingTypingTarget(focusedElement, targetElement.bbox, targetElement)
      )
    ) {
      return null;
    }

    const center = this.absoluteBBoxCenter(targetElement.bbox);
    const directBlocker = openOverlays.find((overlay) => (
      this.isPointInBBox(center, overlay.bbox)
      || this.computeBBoxContainmentRatio(overlay.bbox, targetElement.bbox) >= 0.05
      || this.computeBBoxIou(overlay.bbox, targetElement.bbox) >= 0.01
    ));
    if (directBlocker) {
      return { blocker: directBlocker, owner: focusedElement };
    }

    const ownerCandidates = popupOwners
      .filter((owner) => (
        targetElement.bbox.y >= (owner.bbox.y + owner.bbox.height - 2)
        && this.computeHorizontalOverlapRatio(owner.bbox, targetElement.bbox) >= 0.25
      ))
      .sort((left, right) => (right.bbox.y + right.bbox.height) - (left.bbox.y + left.bbox.height));

    for (const ownerCandidate of ownerCandidates) {
      const ownerBottom = ownerCandidate.bbox.y + ownerCandidate.bbox.height;
      const popupScanLimit = Math.max(
        targetElement.bbox.y + targetElement.bbox.height + 320,
        ownerBottom + 220,
      );
      const popupCandidate = Array.from(this.formFieldStore.values()).find((element) => (
        element.id !== targetElement.id
        && element.id !== ownerCandidate.id
        && this.isPopupOverlayCandidateRole(element.role)
        && element.bbox.y >= (ownerBottom - 2)
        && element.bbox.y < popupScanLimit
        && this.computeHorizontalOverlapRatio(ownerCandidate.bbox, element.bbox) >= 0.2
      ));
      if (popupCandidate) {
        return { blocker: popupCandidate, owner: ownerCandidate };
      }
    }

    return null;
  }

  private findMatchingFocusedTarget(
    expectedBBox: AbsoluteBBox,
    targetElement: ScreenElement,
  ): ScreenElement | null {
    const focusedElements = Array.from(this.formFieldStore.values()).filter(
      (element) => element.focused === true,
    );

    return focusedElements.find((element) => this.isMatchingTypingTarget(element, expectedBBox, targetElement)) ?? null;
  }

  private isMatchingTypingTarget(
    candidate: ScreenElement,
    expectedBBox: AbsoluteBBox,
    targetElement: ScreenElement,
  ): boolean {
    if (candidate.id === targetElement.id && this.isTypingCompatibleRole(candidate.role)) {
      return true;
    }

    const candidateLabel = this.normalizeElementLabel(candidate.label);
    const targetLabel = this.normalizeElementLabel(targetElement.label);
    const labelsMatch = candidateLabel === targetLabel;
    const hasSemanticLabel = this.hasMeaningfulSemanticLabel(candidateLabel) || this.hasMeaningfulSemanticLabel(targetLabel);
    if (hasSemanticLabel && !labelsMatch) {
      return false;
    }

    const iou = this.computeBBoxIou(candidate.bbox, expectedBBox);
    const containment = this.computeBBoxContainmentRatio(candidate.bbox, expectedBBox);
    if (iou >= TYPE_TARGET_GEOMETRY_MATCH_MIN_IOU) {
      return true;
    }

    if (containment >= TYPE_TARGET_CONTAINMENT_MATCH_MIN_RATIO) {
      return true;
    }

    return (
      labelsMatch
      && (
        iou >= TYPE_TARGET_LABEL_MATCH_MIN_IOU
        || this.isBBoxNear(candidate.bbox, expectedBBox)
      )
    );
  }

  private normalizeTypedTextValue(value: string | undefined): string {
    return String(value || '')
      .trim()
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/[‐‑‒–—―−]/g, '-')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private buildTypingFocusVerificationError(
    targetElement: ScreenElement,
    actualFocusedElement: ScreenElement | null,
  ): string {
    const expected = `"${targetElement.label || targetElement.id}"`;
    if (!actualFocusedElement) {
      return `Failed to verify typing focus for ${expected}; no focused element was detected after the verified click.`;
    }

    return `Failed to verify typing focus for ${expected}; the focused element was "${actualFocusedElement.label || actualFocusedElement.id}" instead.`;
  }

  private buildTypingTargetUnavailableError(targetElement: ScreenElement): string {
    const targetLabel = targetElement.label || targetElement.id;
    return `Could not verify a reachable typing point for "${targetLabel}". Re-read the latest tree and decide the next action from the diff.`;
  }


  private findUniqueElementByDescription(query: string | undefined, tool: ToolName = 'click'): ScreenElement | null {
    const normalizedQuery = this.normalizeDescription(query);
    if (!normalizedQuery) {
      return null;
    }

    const interactiveRoles = new Set([
      'AXButton',
      'AXTextField',
      'AXTextArea',
      'AXSearchField',
      'AXSecureTextField',
      'AXComboBox',
      'AXPopUpButton',
      'AXMenuButton',
      'AXMenuItem',
      'AXRadioButton',
      'AXCheckBox',
      'AXLink',
    ]);

    let candidates = Array.from(this.formFieldStore.values()).filter((element) => {
      if (tool !== 'scroll' && !interactiveRoles.has(element.role)) {
        return false;
      }
      return this.normalizeDescription(element.label) === normalizedQuery;
    });

    if (this.activeViewport) {
      candidates = candidates.filter((element) => this.getScopedElementBBox(element) !== null);
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const prioritized = candidates.filter((element) => element.role === 'AXMenuItem');
    if (prioritized.length === 1) {
      return prioritized[0];
    }

    return null;
  }

  private tryApplyInstantMatch(params: {
    action: Action;
    field: ScreenElement;
    query: string | undefined;
    samplingScreenshotBase64: string | null;
    detectStart: number;
    elementId: string;
  }): boolean {
    if (!this.activeViewport) {
      return false;
    }

    const matchedField = params.action.tool === 'type'
      ? this.resolveTypingTarget(params.field)
      : params.field;
    const descriptionMismatch = this.getElementDescriptionMismatch(
      params.action,
      params.field,
      params.query,
      params.elementId,
      matchedField,
    );
    if (descriptionMismatch) {
      return false;
    }

    console.log(`[RunEngine] [TIMING] ⚡ INSTANT MATCH for action ${params.action.seq}: element_id="${params.elementId}" - skipping vision API`);
    console.log(`[RunEngine] Instant match field: ${JSON.stringify(params.field)}`);

    if (params.action.decision) {
      return false;
    }

    const scopedMatchedFieldBounds = this.getScopedElementBBox(matchedField);
    if (!scopedMatchedFieldBounds) {
      return false;
    }

    const relativeBbox = this.toScopedRelativeBBox(scopedMatchedFieldBounds);

    params.action.bbox = relativeBbox;
    params.action.resolvedLabel = matchedField.label || params.field.label;
    params.action.currentValue = matchedField.value ?? params.field.value;
    params.action.centerColor = params.samplingScreenshotBase64
      ? sampleCenterPixel(params.samplingScreenshotBase64, relativeBbox) ?? undefined
      : undefined;
    console.log(
      `[RunEngine] [TIMING] Instant match completed for action ${params.action.seq} in ${Date.now() - params.detectStart}ms`,
    );
    return true;
  }

  private getElementDescriptionMismatch(
    action: Action,
    field: ScreenElement,
    query: string | undefined,
    elementId: string,
    resolvedField?: ScreenElement,
  ): string | null {
    const normalizedQuery = this.normalizeDescription(query);
    if (!normalizedQuery) {
      return null;
    }

    const matchedField = resolvedField ?? (action.tool === 'type'
      ? this.resolveTypingTarget(field)
      : field);
    const labels = [
      field.label,
      matchedField.label,
      field.groupLabel,
    ]
      .flatMap((label) => this.observedDescriptionLabels(label))
      .map((label) => this.normalizeDescription(label))
      .filter((label) => !this.isGenericControlDescription(label))
      .filter((label) => label.length > 0);
    if (labels.length === 0 || labels.some((label) => this.descriptionMatchesObservedLabel(normalizedQuery, label))) {
      return null;
    }

    const observed = matchedField.label || field.label || field.groupLabel || elementId;
    const message = `Element "${elementId}" resolved to "${observed}", which does not match element_description "${query}". Re-read the latest accessibility tree and choose the correct visible element.`;
    console.warn('[RunEngine] Rejecting element_id because element_description does not match target label', {
      actionSeq: action.seq,
      elementId,
      elementLabel: field.label,
      resolvedLabel: matchedField.label,
      elementDescription: query,
    });
    return message;
  }

  private observedDescriptionLabels(label: string | undefined): string[] {
    const raw = String(label || '').trim();
    if (!raw) {
      return [];
    }

    const nativeCuaMatch = /^-\s*\[\d+\]\s+([A-Za-z][A-Za-z0-9]*)(.*?)(?:\s+bounds=|$)/.exec(raw);
    if (!nativeCuaMatch) {
      return [raw];
    }

    const role = nativeCuaMatch[1]?.trim() ?? '';
    const details = nativeCuaMatch[2] ?? '';
    const quotedNames = Array.from(details.matchAll(/"([^"]+)"/g))
      .filter((match) => {
        const beforeQuote = details.slice(0, match.index).trimEnd();
        return !beforeQuote.endsWith('=');
      })
      .map((match) => match[1]?.trim() ?? '')
      .filter((alias) => alias.length > 0);
    const parentheticalNames = Array.from(details.matchAll(/\(([^)]+)\)/g))
      .map((match) => match[1]?.trim() ?? '')
      .filter((alias) => alias.length > 0);
    const visibleNames = [...parentheticalNames, ...quotedNames];
    return [
      ...visibleNames,
      ...visibleNames.map((visibleName) => role ? `${role} ${visibleName}` : ''),
    ].filter((alias) => alias.length > 0);
  }

  private descriptionMatchesObservedLabel(normalizedDescription: string, normalizedObservedLabel: string): boolean {
    if (!normalizedDescription || !normalizedObservedLabel) {
      return false;
    }
    if (normalizedDescription === normalizedObservedLabel) {
      return true;
    }

    const observedTokens = normalizedObservedLabel.match(/[a-z0-9]+/g) ?? [];
    const descriptionTokens = new Set(normalizedDescription.match(/[a-z0-9]+/g) ?? []);
    return observedTokens.length > 0
      && observedTokens.every((token) => descriptionTokens.has(token));
  }

  private isGenericControlDescription(normalizedLabel: string): boolean {
    return normalizedLabel === 'text entry area'
      || normalizedLabel === 'text field'
      || normalizedLabel === 'text area'
      || normalizedLabel === 'axtextfield'
      || normalizedLabel === 'axtextarea'
      || normalizedLabel === 'axbutton'
      || normalizedLabel === 'axcheckbox'
      || normalizedLabel === 'axradiobutton'
      || normalizedLabel === 'axpopupbutton'
      || normalizedLabel === 'pop up button'
      || normalizedLabel === 'button'
      || normalizedLabel === 'checkbox'
      || normalizedLabel === 'radio button';
  }

  private getMenuItemTypeaheadText(label: string): string {
    const target = this.normalizeMenuTypeahead(label);
    if (!target) {
      throw new Error(`Cannot select menuitem with empty label: "${label}"`);
    }

    const siblingOptions = Array.from(this.formFieldStore.values())
      .filter((element) => element.role === 'AXMenuItem')
      .map((element) => this.normalizeMenuTypeahead(element.label))
      .filter((value) => value.length > 0);

    for (let length = 1; length <= target.length; length += 1) {
      const prefix = target.slice(0, length);
      const matches = siblingOptions.filter((option) => option.startsWith(prefix));
      if (matches.length === 1) {
        return prefix;
      }
    }

    return target;
  }

  private normalizeMenuTypeahead(value: string): string {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '');
  }

  private getDropdownOptionTypeaheadText(fieldLabel: string, optionText: string): string {
    const normalizedFieldLabel = this.normalizeDropdownFieldLabel(fieldLabel);
    const target = String(optionText || '').trim().toLowerCase();
    if (!target) {
      throw new Error(`Cannot select dropdown option with empty label for field "${fieldLabel}"`);
    }

    const labeledSiblingOptions = Array.from(this.formFieldStore.values())
      .filter((element) => this.isDropdownOptionElement(element))
      .map((element) => this.parseDropdownOptionLabel(element.label))
      .filter((parsed): parsed is { fieldLabel: string; optionText: string } => parsed !== null)
      .filter((parsed) => this.normalizeDropdownFieldLabel(parsed.fieldLabel) === normalizedFieldLabel)
      .map((parsed) => parsed.optionText.trim().toLowerCase())
      .filter((value) => value.length > 0);
    const focusedDropdown = this.focusedMenuElementId
      ? this.formFieldStore.get(this.focusedMenuElementId)
      : null;
    const focusedMenuOptions = focusedDropdown
      && this.isDropdownControlRole(focusedDropdown.role)
      && this.normalizeDropdownFieldLabel(focusedDropdown.label) === normalizedFieldLabel
      ? Array.from(this.formFieldStore.values())
        .filter((element) => element.role === 'AXMenuItem')
        .map((element) => String(element.label || '').trim().toLowerCase())
        .filter((value) => value.length > 0)
      : [];
    const siblingOptions = Array.from(new Set([
      ...labeledSiblingOptions,
      ...focusedMenuOptions,
    ]));

    for (let length = 1; length <= target.length; length += 1) {
      const prefix = target.slice(0, length);
      const matches = siblingOptions.filter((option) => option.startsWith(prefix));
      if (matches.length === 1) {
        return prefix;
      }
    }

    return target;
  }

  private async trySelectObservedDropdownOption(
    targetElement: ScreenElement | undefined,
    optionText: string,
  ): Promise<boolean> {
    if (OVERLAY_VISION_MODE || !targetElement) {
      return false;
    }

    try {
      await this.captureStructuredRefreshSnapshot();
    } catch (error) {
      console.warn('[RunEngine] Failed to reread opened dropdown before option selection', {
        targetId: targetElement.id,
        targetLabel: targetElement.label,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const targetOption = this.normalizeMenuTypeahead(optionText);
    if (!targetOption) {
      return false;
    }

    const option = Array.from(this.formFieldStore.values()).find((element) => {
      if (element.role === 'AXMenuItem' || element.role === 'AXRadioButton') {
        return this.normalizeMenuTypeahead(element.label) === targetOption;
      }
      if (element.role === 'AXButton') {
        const parsed = this.parseDropdownOptionLabel(element.label);
        return parsed !== null && this.normalizeMenuTypeahead(parsed.optionText) === targetOption;
      }
      return false;
    });
    if (!option) {
      console.log('[RunEngine] Opened dropdown did not expose exact AX option; falling back to typeahead', {
        targetId: targetElement.id,
        targetLabel: targetElement.label,
        optionText,
      });
      return false;
    }

    const optionBBox = this.getScopedElementBBox(option);
    if (!optionBBox) {
      console.log('[RunEngine] Observed dropdown option is outside selected scope; falling back to typeahead', {
        targetId: targetElement.id,
        optionId: option.id,
        optionLabel: option.label,
      });
      return false;
    }

    const point = this.absoluteBBoxCenter(optionBBox);
    console.log('[RunEngine] Selecting observed AX dropdown option', {
      targetId: targetElement.id,
      targetLabel: targetElement.label,
      optionId: option.id,
      optionLabel: option.label,
      point,
    });
    if (option.nativeCua) {
      if (!this.auto.clickNativeCuaElement) {
        throw new Error('Native CUA dropdown option click execution is unavailable.');
      }
      await this.auto.clickNativeCuaElement(option.nativeCua);
      return true;
    }

    if (!OVERLAY_VISION_MODE && process.platform === 'win32' && isWindowsUiaElementId(option.id)) {
      const nativeCuaTarget = this.buildNativeCuaElementTargetFromWindowsUiaId(option.id);
      if (nativeCuaTarget) {
        if (!this.auto.clickNativeCuaElement) {
          throw new Error('Native CUA dropdown option click execution is unavailable.');
        }
        await this.auto.clickNativeCuaElement(nativeCuaTarget);
        return true;
      }
      this.assertWindowsUiaElementHasNoAttachedNativeCuaTarget(option.id);
      throw new Error(`Windows UIA dropdown option ${option.id} requires an attached native CUA target identity.`);
    }

    const nativeCuaPointTarget = this.buildNativeCuaPointTarget(point);
    if (nativeCuaPointTarget) {
      if (!this.auto.clickNativeCuaPoint) {
        throw new Error('Native CUA dropdown option point-click execution is unavailable.');
      }
      await this.auto.clickNativeCuaPoint(nativeCuaPointTarget);
      return true;
    }

    if (this.activeTargetIdentity?.kind === 'active-app') {
      throw new Error('Active app dropdown option click requires a native CUA target identity.');
    }

    throw new Error(`Overlay dropdown option ${option.id} requires a native CUA or browser ref.`);
  }

  private parseDropdownOptionLabel(label: string): { fieldLabel: string; optionText: string } | null {
    const separatorIndex = label.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= label.length - 1) {
      return null;
    }

    const fieldLabel = label.slice(0, separatorIndex).trim();
    const optionText = label.slice(separatorIndex + 1).trim();
    if (!fieldLabel || !optionText) {
      return null;
    }

    return { fieldLabel, optionText };
  }

  private isDropdownControlRole(role: string): boolean {
    return role === 'AXComboBox' || role === 'AXPopUpButton' || role === 'AXMenuButton';
  }

  private isDropdownOptionElement(element: ScreenElement): boolean {
    return element.role === 'AXButton' && this.parseDropdownOptionLabel(element.label) !== null;
  }

  private normalizeDropdownFieldLabel(label: string): string {
    return this.normalizeElementLabel(label).replace(/\s+dropdown$/i, '').trim();
  }

  private replaceFormFieldStore(elements: ScreenElement[]): void {
    this.formFieldStore.clear();
    for (const field of elements) {
      this.formFieldStore.set(field.id, field);
    }
    console.log(`[RunEngine] Stored ${elements.length} form fields for instant lookup`);
  }

  private isMenuOverlayOnlyContext(elements: ScreenElement[]): boolean {
    if (elements.length === 0) {
      return false;
    }

    let menuItemCount = 0;
    for (const element of elements) {
      if (element.role === 'AXMenuItem') {
        menuItemCount += 1;
        continue;
      }

      if (element.role === 'AXMenuBarItem' || element.role === 'AXMenuButton' || element.role === 'AXButton') {
        continue;
      }

      return false;
    }

    return menuItemCount > 0;
  }

  private mergeOverlayElements(nextElements: ScreenElement[]): ScreenElement[] {
    const preservedElements = Array.from(this.formFieldStore.values()).filter(
      (element) => element.role !== 'AXMenuItem' && element.role !== 'AXMenuBarItem' && element.role !== 'AXMenuButton',
    );

    return [...preservedElements, ...nextElements];
  }

  private mergeOverlayText(overlayText: string): string {
    const baseLines = (this.latestStructuredText || '')
      .split('\n')
      .filter((line) => !line.includes('<menuitem '));
    const overlayLines = overlayText
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    return [...baseLines, '', ...overlayLines].join('\n').trim();
  }

  private normalizeElementLabel(label: string): string {
    return String(label || '')
      .toLowerCase()
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/[‐‑‒–—―−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasMeaningfulSemanticLabel(label: string): boolean {
    return label.length > 0
      && label !== 'text field'
      && label !== 'text entry area'
      && label !== 'search field'
      && label !== 'secure text field'
      && label !== 'combo box'
      && label !== 'pop up button'
      && label !== 'menu button'
      && label !== 'button'
      && label !== 'group';
  }

  private isPointInBBox(point: { x: number; y: number }, bbox: ScreenElement['bbox']): boolean {
    return point.x >= bbox.x
      && point.x <= bbox.x + bbox.width
      && point.y >= bbox.y
      && point.y <= bbox.y + bbox.height;
  }

  private isBlockingOverlayRole(role: string): boolean {
    return role === 'AXList' || role === 'AXMenu';
  }

  private isPopupOwnerRole(role: string): boolean {
    return role === 'AXComboBox' || role === 'AXPopUpButton' || role === 'AXMenuButton';
  }

  private isPopupOverlayCandidateRole(role: string): boolean {
    return role === 'AXButton'
      || role === 'AXList'
      || role === 'AXMenu'
      || role === 'AXMenuItem'
      || role === 'AXLink'
      || role === 'AXRadioButton';
  }

  private isBBoxNear(left: ScreenElement['bbox'], right: ScreenElement['bbox']): boolean {
    return this.computeBBoxCenterDistance(left, right) <= 120;
  }

  private computeHorizontalOverlapRatio(left: ScreenElement['bbox'], right: ScreenElement['bbox']): number {
    const leftX2 = left.x + left.width;
    const rightX2 = right.x + right.width;
    const overlap = Math.max(0, Math.min(leftX2, rightX2) - Math.max(left.x, right.x));
    if (overlap === 0) {
      return 0;
    }
    return overlap / Math.max(1, Math.min(left.width, right.width));
  }

  private computeBBoxIou(left: ScreenElement['bbox'], right: ScreenElement['bbox']): number {
    const leftX2 = left.x + left.width;
    const leftY2 = left.y + left.height;
    const rightX2 = right.x + right.width;
    const rightY2 = right.y + right.height;
    const intersectionX1 = Math.max(left.x, right.x);
    const intersectionY1 = Math.max(left.y, right.y);
    const intersectionX2 = Math.min(leftX2, rightX2);
    const intersectionY2 = Math.min(leftY2, rightY2);
    const intersectionWidth = Math.max(0, intersectionX2 - intersectionX1);
    const intersectionHeight = Math.max(0, intersectionY2 - intersectionY1);
    const intersectionArea = intersectionWidth * intersectionHeight;

    if (intersectionArea === 0) {
      return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    return intersectionArea / (leftArea + rightArea - intersectionArea);
  }

  private computeBBoxContainmentRatio(left: ScreenElement['bbox'], right: ScreenElement['bbox']): number {
    const leftX2 = left.x + left.width;
    const leftY2 = left.y + left.height;
    const rightX2 = right.x + right.width;
    const rightY2 = right.y + right.height;
    const intersectionX1 = Math.max(left.x, right.x);
    const intersectionY1 = Math.max(left.y, right.y);
    const intersectionX2 = Math.min(leftX2, rightX2);
    const intersectionY2 = Math.min(leftY2, rightY2);
    const intersectionWidth = Math.max(0, intersectionX2 - intersectionX1);
    const intersectionHeight = Math.max(0, intersectionY2 - intersectionY1);
    const intersectionArea = intersectionWidth * intersectionHeight;

    if (intersectionArea === 0) {
      return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    return intersectionArea / Math.max(1, Math.min(leftArea, rightArea));
  }

  private computeBBoxCenterDistance(left: ScreenElement['bbox'], right: ScreenElement['bbox']): number {
    const leftCenterX = left.x + left.width / 2;
    const leftCenterY = left.y + left.height / 2;
    const rightCenterX = right.x + right.width / 2;
    const rightCenterY = right.y + right.height / 2;
    return Math.hypot(leftCenterX - rightCenterX, leftCenterY - rightCenterY);
  }

  private async processScreenshotWhenReady(action: Action): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    const startedAt = this.clock.now();
    const timeoutMessage = `Screenshot tool timed out after ${SCREENSHOT_BOUNDARY_TIMEOUT_MS}ms`;

    // Wait for all prior actions to be decided
    const checkReady = async (): Promise<void> => {
      // Check if all prior actions have decisions
      const priorActions = this.currentRun!.actions.filter((a) => a.seq < action.seq && a.dispatched);
      const allPriorDecided = priorActions.every(a => a.decision !== undefined);

      if (!allPriorDecided) {
        if ((this.clock.now() - startedAt) >= SCREENSHOT_BOUNDARY_TIMEOUT_MS) {
          throw new Error(timeoutMessage);
        }
        // Wait and check again
        await new Promise(resolve => setTimeout(resolve, 10));
        return checkReady();
      }
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await checkReady();

      // Mark as approved (screenshot tools don't need review)
      action.decision = 'approved';
      action.executedAt = this.clock.now();

      await Promise.race([
        this.executeScreenshotBoundary(action),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(timeoutMessage));
          }, SCREENSHOT_BOUNDARY_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[RunEngine] Screenshot boundary failed:', message);
      action.error = message;
      this.resolveToolText(action.seq, `Screenshot failed: ${message}`);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    // Update UI
    this.updateUI();
  }

  private async handleScreenshotBoundaryIfNeeded(currentSeq: number): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    // Find next action
    const nextAction = this.currentRun.actions.find(
      (a) => a.seq > currentSeq && !a.decision
    );

    if (nextAction && nextAction.tool === 'screenshot') {
      // This is a boundary - execute the screenshot
      await this.executeScreenshotBoundary(nextAction);
    }
  }

  private async executeScreenshotBoundary(action: Action): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    const params = action.params as ScreenshotParams;
    const requestedRegionId = params.region_id?.trim();
    const requestedRegion = requestedRegionId
      ? this.screenQueryRegions.get(requestedRegionId)
      : null;
    const textOnly = shouldUseStructuredScreenshotBoundary(
      params.text_only,
      INTERPRETER_OVERLAY_AGENT_MODE,
    );

    // Check if this is the first tool (batch-0 sentinel)
    const isFirstTool = action.seq === 0;

    // Handle text_only mode with a fresh accessibility-tree refresh.
    if (textOnly) {
      console.log('[RunEngine] Using text_only mode for accessibility refresh');
      const toolResult = await this.captureStructuredRefreshSnapshot();
      console.log(`[RunEngine] Accessibility refresh extracted ${this.latestStructuredText?.length || 0} characters`);
      this.resolveToolResult(action.seq, {
        kind: 'structured-screen',
        snapshot: toolResult,
      });

      return;
    }

    // Non-text_only mode returns screenshot bytes for explicit visual query tools.
    if (OVERLAY_VISION_MODE) {
      await new Promise((resolve) => setTimeout(resolve, VISION_BATCH_SCREENSHOT_SETTLE_DELAY_MS));
    }

    if (requestedRegion) {
      if (!this.activeDisplay) {
        throw new Error('No active display available for screen region capture');
      }

      const { base64 } = await this.capture.captureDisplay(
        this.activeDisplay,
        this.getScreenshotCaptureBoundsForRegion(requestedRegion),
      );
      const batchNumber = this.currentRun.actions.filter(
        (a) => a.tool === 'screenshot' && a.seq < action.seq
      ).length + 1;
      const regionSuffix = requestedRegionId ? `/${requestedRegionId.replace(/[^a-zA-Z0-9_-]+/g, '-')}` : '';
      const regionScreenshotId = `run-${this.currentRun.id}/batch-${batchNumber}${regionSuffix}`;
      this.screenshotCache.set(regionScreenshotId, base64);
      this.screenshotCache.set(`${regionScreenshotId}:cached`, 'false');

      try {
        this.materializeScreenshotFile(regionScreenshotId, base64);
        await this.vision.cache(regionScreenshotId, base64);
        this.screenshotCache.set(`${regionScreenshotId}:cached`, 'true');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[RunEngine] Failed to cache region screenshot ${regionScreenshotId} for boundary result: ${message}`);
      }

      this.resolveToolResult(action.seq, {
        kind: 'image',
        screenshotId: regionScreenshotId,
        screenshotBase64: base64,
      });
      return;
    }

    if (isFirstTool) {
      const screenshotBase64 = await this.awaitCurrentScreenshotBase64();
      try {
        console.log(
          `[RunEngine] Screenshot boundary using existing screenshot ${this.currentRun.currentScreenshotId} (base64Length=${screenshotBase64.length})`,
        );
        const pathStart = Date.now();
        await this.awaitCurrentScreenshotPath(this.currentRun.currentScreenshotId);
        console.log(
          `[RunEngine] Screenshot boundary path ready for ${this.currentRun.currentScreenshotId} in ${Date.now() - pathStart}ms`,
        );
        const cacheStart = Date.now();
        console.log(`[RunEngine] Screenshot boundary caching ${this.currentRun.currentScreenshotId}`);
        await this.vision.cache(this.currentRun.currentScreenshotId, screenshotBase64);
        console.log(
          `[RunEngine] Screenshot boundary cached ${this.currentRun.currentScreenshotId} in ${Date.now() - cacheStart}ms`,
        );
        this.screenshotCache.set(`${this.currentRun.currentScreenshotId}:cached`, 'true');
        this.resolveToolResult(action.seq, {
          kind: 'image',
          screenshotId: this.currentRun.currentScreenshotId,
          screenshotBase64,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[RunEngine] Failed to cache screenshot ${this.currentRun.currentScreenshotId} for boundary result: ${message}`);
        this.screenshotCache.set(`${this.currentRun.currentScreenshotId}:cached`, 'false');
        this.resolveToolResult(action.seq, {
          kind: 'image',
          screenshotId: this.currentRun.currentScreenshotId,
          screenshotBase64,
        });
      }
    } else {
      if (!this.activeDisplay) {
        throw new Error('No active display available for screenshot capture');
      }

      // Capture new screenshot
      console.log(`[RunEngine] Screenshot boundary capture start seq=${action.seq}`);
      const { base64 } = await this.capture.captureDisplay(
        this.activeDisplay,
        this.getCaptureBoundsForMode(),
      );
      console.log(
        `[RunEngine] Screenshot boundary capture returned seq=${action.seq} base64Length=${base64.length}`,
      );

      // Generate new batch ID
      const batchNumber = this.currentRun.actions.filter(
        (a) => a.tool === 'screenshot' && a.seq < action.seq
      ).length + 1;
      const newBatchId = `run-${this.currentRun.id}/batch-${batchNumber}`;

      this.currentRun.currentScreenshotId = newBatchId;
      this.screenshotBase64 = base64;
      this.screenshotImageSize = this.readPngImageSize(base64);
      this.screenshotCache.set(newBatchId, base64);
      this.screenshotCache.set(`${newBatchId}:cached`, 'false');
      console.log(
        `[RunEngine] Screenshot boundary post-capture state ready for ${newBatchId} imageSize=${JSON.stringify(this.screenshotImageSize)}`,
      );

      try {
        const pathStart = Date.now();
        this.materializeScreenshotFile(newBatchId, base64);
        console.log(
          `[RunEngine] Screenshot boundary path ready for ${newBatchId} in ${Date.now() - pathStart}ms`,
        );
        const cacheStart = Date.now();
        console.log(`[RunEngine] Screenshot boundary caching ${newBatchId}`);
        await this.vision.cache(newBatchId, base64);
        console.log(
          `[RunEngine] Screenshot boundary cached ${newBatchId} in ${Date.now() - cacheStart}ms`,
        );
        this.screenshotCache.set(`${newBatchId}:cached`, 'true');
        this.resolveToolResult(action.seq, {
          kind: 'image',
          screenshotId: newBatchId,
          screenshotBase64: base64,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[RunEngine] Failed to cache screenshot ${newBatchId} for boundary result: ${message}`);
        this.screenshotCache.set(`${newBatchId}:cached`, 'false');
        this.resolveToolResult(action.seq, {
          kind: 'image',
          screenshotId: newBatchId,
          screenshotBase64: base64,
        });
      }
    }
  }

  private async captureFreshVisionBatchImageResult(): Promise<ToolExecutionResult> {
    if (!this.currentRun) {
      throw new Error('No active run available for batch screenshot capture');
    }
    if (!this.activeDisplay) {
      throw new Error('No active display available for batch screenshot capture');
    }

    const { base64 } = await this.capture.captureDisplay(this.activeDisplay, this.getCaptureBoundsForMode());
    const currentId = this.currentRun.currentScreenshotId;
    const match = currentId.match(/batch-(\d+)$/);
    const nextBatchNumber = match ? Number(match[1]) + 1 : 1;
    const newBatchId = `run-${this.currentRun.id}/batch-${nextBatchNumber}`;

    this.currentRun.currentScreenshotId = newBatchId;
    this.screenshotBase64 = base64;
    this.screenshotImageSize = this.readPngImageSize(base64);
    this.screenshotCache.set(newBatchId, base64);
    this.screenshotCache.set(`${newBatchId}:cached`, 'false');

    return {
      kind: 'image',
      screenshotId: newBatchId,
      screenshotBase64: base64,
    };
  }

  private handleAgentDone(agentRun: AgentRun, result: AgentRunResult): void {
    console.log('[RunEngine] Agent done:', result.status, result.finalText.substring(0, 100));
    console.log(`[RunEngine] Agent done detail: ${JSON.stringify(result, null, 2)}`);

    this.pendingTerminalResult = { agentRun, result };
    this.maybeFinalizePendingTerminalResult('agent-done');
  }

  private maybeFinalizePendingTerminalResult(trigger: string): void {
    if (this.finalizingTerminalResult) {
      return;
    }

    const pending = this.pendingTerminalResult;
    if (!pending) {
      return;
    }

    if (this.currentAgentRun !== pending.agentRun) {
      console.warn(`[RunEngine] Dropping pending terminal result from stale agent run (${trigger})`);
      this.pendingTerminalResult = null;
      return;
    }

    if (!this.currentRun) {
      console.warn(`[RunEngine] Dropping pending terminal result because currentRun is missing (${trigger})`);
      this.pendingTerminalResult = null;
      return;
    }

    const hasUndecidedActions = this.currentRun.actions.some((action) => !action.decision && action.dispatched);
    if (this.isProcessingApproval || hasUndecidedActions) {
      console.log(
        `[RunEngine] Deferring terminal result until executor is idle (${trigger})`,
        {
          isProcessingApproval: this.isProcessingApproval,
          hasUndecidedActions,
          pendingActions: this.currentRun.actions
            .filter((action) => !action.decision && action.dispatched)
            .map((action) => ({ seq: action.seq, tool: action.tool })),
        },
      );
      return;
    }

    const { result } = pending;
    this.finalizingTerminalResult = true;
    this.pendingTerminalResult = null;
    try {
      if (result.status === 'completed') {
        this.conversationExpiresAt = this.clock.now() + this.config.conversationAppendMs;
      } else if (result.status === 'failed') {
        console.error('[RunEngine] Agent finished with error:', result.finalText);
      }

      this.resetRunState();

      if (result.status === 'failed') {
        this.showError(result.finalText);
      } else {
        this.updateUI();
      }

      for (const callback of this.agentDoneCallbacks) {
        callback(result);
      }
    } finally {
      this.finalizingTerminalResult = false;
    }
  }

  private getActiveAction(): Action | null {
    if (!this.currentRun) {
      return null;
    }

    // Find first reviewable action:
    // - Undecided (no decision)
    // - Enriched (has bbox for click/type, or is hotkey/screenshot)
    // - Before next screenshot boundary

    // First, find the next dispatched screenshot boundary. Preview-only
    // screenshot boundaries must not hide a real dispatched action that is
    // ready for review, or approval can stall indefinitely waiting on a tool
    // call that has not actually been dispatched yet.
    let nextScreenshotSeq: number | null = null;
    for (const action of this.currentRun.actions) {
      if (action.tool === 'screenshot' && action.dispatched && !action.decision) {
        nextScreenshotSeq = action.seq;
        break;
      }
    }

    // Find first undecided action before the next dispatched screenshot
    // boundary. A dispatched-but-not-enriched action still owns its position in
    // the plan; later actions must not jump ahead while enrichment catches up.
    for (const action of this.currentRun.actions) {
      if (action.decision) {
        continue; // Already decided
      }

      // Check if before boundary
      if (nextScreenshotSeq !== null && action.seq >= nextScreenshotSeq) {
        continue;
      }

      if (action.tool !== 'click' && action.tool !== 'type' && action.tool !== 'scroll' && action.tool !== 'hotkey') {
        continue;
      }

      if (!action.dispatched) {
        return null;
      }

      // Check if enriched. Returning null preserves plan order while the
      // action is still resolving; skipping it would let a later click submit a
      // partially filled form.
      if (this.actionNeedsEnrichmentBeforeReview(action)) {
        return null;
      }

      // This is the active action
      return action;
    }

    return null;
  }

  private getPreviewPlan(): Action[] {
    if (!this.currentRun) {
      return [];
    }

    const previewActions: Action[] = [];

    for (const action of this.currentRun.actions) {
      if (action.decision) {
        continue;
      }

      if (action.tool === 'screenshot') {
        break;
      }

      if (this.actionNeedsEnrichmentBeforeReview(action)) {
        continue;
      }

      if (action.tool !== 'click' && action.tool !== 'type' && action.tool !== 'scroll' && action.tool !== 'hotkey') {
        continue;
      }

      previewActions.push(action);
    }

    return previewActions;
  }

  private getGhosts(): Action[] {
    if (!this.currentRun) {
      return [];
    }

    const active = this.getActiveAction();
    if (!active) {
      return [];
    }

    const ghosts: Action[] = [];

    // Find next screenshot boundary after the active action.
    let nextScreenshotSeq: number | null = null;
    for (const action of this.currentRun.actions) {
      if (action.seq <= active.seq) {
        continue;
      }

      if (action.tool === 'screenshot' && !action.decision) {
        nextScreenshotSeq = action.seq;
        break;
      }
    }

    // Show all pending reviewable actions from the current stable screen state at once.
    for (const action of this.currentRun.actions) {
      if (action.seq <= active.seq) {
        continue;
      }

      if (action.decision) {
        continue;
      }

      if (action.tool === 'screenshot') {
        break;
      }

      if (nextScreenshotSeq !== null && action.seq >= nextScreenshotSeq) {
        break;
      }

      if (this.actionNeedsEnrichmentBeforeReview(action)) {
        continue;
      }

      if (action.tool !== 'click' && action.tool !== 'type' && action.tool !== 'scroll' && action.tool !== 'hotkey') {
        continue;
      }

      ghosts.push(action);
    }

    return ghosts;
  }

  private updateUI(executing: boolean = false, anchorAction: Action | null = null, reason: string = 'updateUI'): void {
    if (!this.currentRun) {
      this.workingAnchorAction = null;
      // No active run - hide everything
      this.logUiTiming(reason, { kind: 'hidden' }, null, [], false);
      this.ui.set({
        pill: { kind: 'hidden' },
        active: null,
        ghosts: [],
        ctrlPressed: this.ctrlPressed,
        shiftPressed: this.shiftPressed,
        executing: false,
      });
      return;
    }

    if (anchorAction) {
      this.workingAnchorAction = anchorAction;
    }

    const nextActive = this.getActiveAction();
    const nextGhosts = this.getGhosts();
    const previewPlan = this.getPreviewPlan();
    const effectiveExecuting = executing
      || this.isProcessingApproval
      || this.computerBatchExecuting
      || this.acceptAllThroughSeq !== null
      || this.sessionAutoAccept;
    const hasLiveToolSession = this.attachedToolSessionActive;
    const previewGhostsAfterAnchor = this.workingAnchorAction
      ? previewPlan.filter((action) => action.seq > this.workingAnchorAction!.seq)
      : previewPlan;

    let active = nextActive;
    let ghosts = nextGhosts;
    const pendingBatchWaitingForPreview = Boolean(this.pendingComputerBatch && !nextActive && !effectiveExecuting);

    if (pendingBatchWaitingForPreview) {
      this.workingAnchorAction = null;
      active = null;
      ghosts = previewPlan;
    } else if (effectiveExecuting && this.workingAnchorAction) {
      active = this.workingAnchorAction;
      ghosts = nextActive ? [nextActive, ...nextGhosts] : previewGhostsAfterAnchor;
    } else if (!nextActive && (this.currentAgentRun || hasLiveToolSession) && this.workingAnchorAction) {
      active = this.workingAnchorAction;
      ghosts = previewGhostsAfterAnchor;
    } else if (!nextActive && previewPlan.length > 0) {
      active = null;
      ghosts = previewPlan;
    } else if (nextActive) {
      this.workingAnchorAction = null;
    } else if (!this.currentAgentRun && !hasLiveToolSession) {
      this.workingAnchorAction = null;
    }

    if (!active) {
    }

    // Determine pill mode
    let pill: UIState['pill'];

    if (effectiveExecuting) {
      pill = { kind: 'loading', label: this.getExecutingLabel(active) };
    } else if (nextActive) {
      // Review mode
      if (nextActive.tool === 'hotkey') {
        const hotkeyLabel = typeof (nextActive.params as Partial<HotkeyParams>).hotkey === 'string'
          ? (nextActive.params as Partial<HotkeyParams>).hotkey?.trim() ?? ''
          : '';
        pill = {
          kind: 'review',
          hotkeyLabel: hotkeyLabel || 'invalid hotkey',
        };
      } else {
        pill = { kind: 'review' };
      }
    } else if (this.currentAgentRun) {
      // Loading mode: agent is running but no active action yet.
      pill = { kind: 'loading' };
    } else if (hasLiveToolSession) {
      pill = { kind: 'hidden' };
    } else {
      // Recording mode (shows waveform during screenshot/OCR + voice recording)
      pill = { kind: 'recording' };
    }

    this.logUiTiming(reason, pill, active, ghosts, effectiveExecuting);
    this.ui.set({
      pill,
      active,
      ghosts,
      ctrlPressed: this.ctrlPressed,
      shiftPressed: this.shiftPressed,
      executing: effectiveExecuting,
    });

    this.maybeFinalizePendingTerminalResult(`updateUI:${reason}`);
  }

  private logUiTiming(
    reason: string,
    pill: UIState['pill'],
    active: Action | null,
    ghosts: Action[],
    executing: boolean,
  ): void {
    const pillLabel = pill.kind === 'loading'
      ? pill.label ?? 'none'
      : pill.kind === 'review'
        ? pill.hotkeyLabel ?? 'review'
        : pill.kind === 'error'
          ? pill.message
          : pill.kind;
    const activeSeq = active?.seq ?? 'none';
    const activeTool = active?.tool ?? 'none';
    const ghostSeqs = ghosts.map((ghost) => ghost.seq).join(',') || 'none';
    const now = Date.now();
    console.log(
      `[RunEngine] [UI_TIMING] ts=${now} iso=${new Date(now).toISOString()} reason=${reason} pill=${pill.kind} pillLabel=${JSON.stringify(pillLabel)} activeSeq=${activeSeq} activeTool=${activeTool} ghosts=${ghostSeqs} executing=${executing}`,
    );
  }

  private getExecutingLabel(action: Action | null): string {
    if (!action) {
      return 'Executing...';
    }

    switch (action.tool) {
      case 'type':
        return 'Typing...';
      case 'click':
        return 'Clicking...';
      case 'hotkey':
        return 'Pressing...';
      case 'scroll':
        return 'Scrolling...';
      default:
        return 'Executing...';
    }
  }

  private async captureSamplingScreenshotBase64(): Promise<string | null> {
    try {
      const display = this.activeDisplay ?? this.capture.getActiveDisplay();
      const { base64 } = await this.capture.captureDisplay(display, this.getCaptureBoundsForMode());
      return base64;
    } catch (error) {
      console.warn(
        '[RunEngine] Failed to capture dedicated sampling screenshot:',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Run one attached overlay tool call through the shared overlay dispatcher.
   * The call remains in flight while approval/review UI is active.
   */
  async runAttachedToolCall(
    tool: ToolCall,
    options?: AttachedToolDispatchOptions,
  ): Promise<AttachedToolCallResult> {
    try {
      if (!this.currentRun || !this.attachedToolSessionActive) {
        const display = options?.display ?? this.capture.getActiveDisplay();
        const viewport = getDisplayViewport(display, options?.scopeBounds ?? null);
        if (!viewport) {
          throw new Error('Selected scope is outside the active display');
        }

        let structuredContext: { formattedText: string; elements: ScreenElement[] } = {
          formattedText: '',
          elements: [],
        };
        if (OVERLAY_AX_MODE) {
          const segmentedResult = await performSegmentedOCR(Buffer.alloc(0), display.scaleFactor, {
            scopeBounds: viewport,
            targetPid: this.activeTargetPid,
            targetWindowId: this.activeTargetWindowId,
          });
          structuredContext = normalizeStructuredContext(
            segmentedResult.formattedText,
            segmentedResult.elements,
          );
        }
        const { base64 } = await this.capture.captureDisplay(
          display,
          viewport,
        );

        this.startAttachedToolSession({
          display,
          scopeBounds: viewport,
          formattedText: structuredContext.formattedText,
          elements: structuredContext.elements,
          screenshotBase64: base64,
        });
      }

      // Create a promise that will resolve when this specific tool completes
      const completionPromise = new Promise<AttachedToolCallResult>((resolve) => {
        const seq = this.currentRun!.toolCallCount + 1;

        void this.dispatchToolCall(tool, seq, (result: ToolExecutionResult) => {
          const resultText = result.kind === 'text'
            ? result.text
            : result.kind === 'structured-screen'
              ? 'structured-screen'
              : 'image';
          // Check if result indicates success or error
          if (result.kind === 'text' && result.isError) {
            resolve({ success: false, error: resultText, result });
            return;
          }
          if (resultText.toLowerCase().includes('error') || resultText.toLowerCase().includes('cancelled')) {
            resolve({ success: false, error: resultText, result });
          } else {
            resolve({ success: true, result });
          }
        });
      });

      return await completionPromise;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
