import type { Bounds, RelativeBBox, DisplayInfo, ClickParams, TypeParams, HotkeyParams, ScrollParams, ScreenshotParams, UIState } from './types.js';
import type { StructuredScreenSnapshot, ToolExecutionResult } from './tool-results.js';

// Re-export types that are used in port interfaces
export type { Bounds, RelativeBBox, DisplayInfo, ClickParams, TypeParams, HotkeyParams, ScrollParams, ScreenshotParams, UIState };
export type { StructuredScreenSnapshot, ToolExecutionResult };

// Vision Port

export interface VisionPort {
  /**
   * Cache a screenshot on the server with the given ID.
   * @param id - Screenshot ID (e.g., "run-<runId>/batch-<n>")
   * @param screenshotBase64 - Optional base64-encoded screenshot
   * @param screenshotPath - Optional local PNG path accessible to the desktop server
   */
  cache(id: string, screenshotBase64?: string, screenshotPath?: string): Promise<void>;

  /**
   * Detect an element in a screenshot.
   * @param id - Screenshot ID
   * @param query - Natural language element description
   * @param screenshotBase64 - Optional base64 screenshot. If provided and screenshot not cached, will cache it first.
   * @param screenshotPath - Optional local PNG path. Use as a lower-overhead transport when both processes share a filesystem.
   * @returns Either { bbox } for successful detection or { text } for multi/no-match (final message for model)
   */
  detect(id: string, query: string, screenshotBase64?: string, screenshotPath?: string): Promise<{ bbox: RelativeBBox } | { text: string }>;

  /**
   * Query the vision model about a screenshot.
   * @param id - Screenshot ID (must be cached)
   * @param query - Natural language question
   * @param screenshotBase64 - Optional; if provided, server caches this screenshot under id before answering
   * @param screenshotPath - Optional local PNG path for the same purpose
   * @returns { text } with the answer
   */
  query(id: string, query: string, screenshotBase64?: string, screenshotPath?: string): Promise<{ text: string }>;
}

// Capture Port

export interface CapturePort {
  /**
   * Get metadata about the display where the cursor is currently located.
   * @returns DisplayInfo for the active (cursor) display
   */
  getActiveDisplay(): DisplayInfo;

  /**
   * Resolve a specific display by ID.
   * @param displayId - Display identifier returned by getActiveDisplay()
   */
  getDisplayById(displayId: string): DisplayInfo;

  /**
   * Capture a screenshot of the provided display, optionally cropped to a screen-space DIP bounds rect.
   * @param display - DisplayInfo for the target display
   * @param cropBoundsDIP - Optional absolute screen-space crop rect in DIP
   */
  captureDisplay(
    display: DisplayInfo,
    cropBoundsDIP?: Bounds,
  ): Promise<{ base64: string; display: DisplayInfo }>;

  /**
   * Capture a full-display screenshot of the active (cursor) display.
   * @returns Base64-encoded screenshot and DisplayInfo
   */
  captureActiveDisplay(): Promise<{ base64: string; display: DisplayInfo }>;

  /**
   * Capture the bottom strip for a specific display.
   * @returns Base64-encoded screenshot strip and DisplayInfo
   */
  captureDisplayStrip(display: DisplayInfo): Promise<{ base64: string; display: DisplayInfo }>;

  /**
   * Capture the bottom strip screenshot used only for the visible overlay background.
   * @returns Base64-encoded screenshot strip and DisplayInfo
   */
  captureActiveDisplayStrip(): Promise<{ base64: string; display: DisplayInfo }>;
}

// Tool Call Type

export type ToolCall =
  | AtomicToolCall
  | { name: 'screenshot'; params: ScreenshotParams }
  | { name: 'computer_batch'; params: ComputerBatchParams };

export type AtomicToolCall =
  | { name: 'click';  params: ClickParams }
  | { name: 'type';   params: TypeParams }
  | { name: 'hotkey'; params: HotkeyParams }
  | { name: 'scroll'; params: ScrollParams };

export interface ComputerBatchParams {
  actions: Array<{
    seq: number;
    tool: AtomicToolCall;
  }>;
}

export interface AgentToolCallPreview {
  seq: number;
  tool: ToolCall;
}

export interface AgentToolBatchPreview {
  batchId: string;
  turn: number;
  actions: AgentToolCallPreview[];
}

export type AgentRunStatus = 'completed' | 'failed' | 'cancelled';

export interface AgentRunResult {
  status: AgentRunStatus;
  finalText: string;
  reason: string | null;
}

// Agent Port

export interface AgentRun {
  /**
   * Register a callback for a full proposed action batch before sequential dispatch begins.
   * This powers immediate ghost rendering for future actions while execution remains serial.
   */
  onBatchPreview(cb: (preview: AgentToolBatchPreview) => void): void;

  /**
   * Register a callback for each tool call emitted by the agent.
   * @param cb - Callback invoked with (tool, seq, resolve).
   *             - tool: The tool call emitted
   *             - seq: Local sequence number assigned by agent adapter
   *             - resolve: Function to call with result text once action is executed/resolved
   */
  onToolCall(cb: (tool: ToolCall, seq: number, resolve: (result: ToolExecutionResult) => void) => void): void;

  /**
   * Register a callback for when the agent run completes.
   * @param cb - Callback invoked with the structured terminal result
   */
  onDone(cb: (result: AgentRunResult) => void): void;

  /**
   * Abort the agent run immediately.
   */
  abort(): void;
}

export interface AgentPort {
  /**
   * Start a new agent run.
   * @param conversationId - Conversation ID for context reuse (15s append window)
   * @param userText - User's transcribed speech text
   * @param abortSignal - AbortSignal for external cancellation
   * @returns AgentRun handle
   */
  start(
    conversationId: string,
    userText: string,
    abortSignal: AbortSignal,
    options?: {
      initialSnapshot?: StructuredScreenSnapshot;
      initialImageCapture?: {
        screenshotId: string;
        screenshotBase64: string;
      };
      computerEnvironment?: 'windows' | 'mac' | 'linux';
      systemAddendum?: string;
      userAttachments?: import('./ipc.js').OverlayUserAttachment[];
      screenRegions?: import('./ipc.js').OverlayScreenQueryRegion[];
    },
  ): Promise<AgentRun>;
}

// Automation Port

export interface NativeCuaElementTarget {
  app: string;
  elementIndex: number;
  targetIdentity: Record<string, unknown>;
}

export interface NativeCuaPointTarget {
  app: string;
  x: number;
  y: number;
  targetIdentity: Record<string, unknown>;
}

export interface NativeCuaAppWindowTarget {
  app: string;
  targetIdentity: Record<string, unknown>;
}

export interface BrowserPageElementTarget {
  refId: string;
  targetIdentity: Record<string, unknown>;
}

export interface AutomationPort {
  /**
   * Click at the specified device pixel coordinates.
   * @param centerPx - Center coordinates in device pixels
   * @param interactionKind - Special-case interaction mode for controls that need
   * stable activation semantics.
   */
  click(
    centerPx: { x: number; y: number },
    interactionKind?: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option',
    interactionText?: string,
    targetBounds?: Bounds | null,
  ): Promise<void>;

  /**
   * Activate an accessibility/UIA element by opaque element id.
   * Platform adapters own resolving the id to their native tree.
   */
  clickElement?(
    elementId: string,
    interactionKind?: 'default' | 'button' | 'menuitem' | 'radio' | 'checkbox' | 'dropdown-option',
    interactionText?: string,
    centerPx?: { x: number; y: number } | null,
    referenceWindowBounds?: Bounds | null,
  ): Promise<void>;

  /**
   * Activate a native CUA element ref observed in the selected-context snapshot.
   */
  clickNativeCuaElement?(target: NativeCuaElementTarget): Promise<void>;

  /**
   * Click a screen-space point inside a native CUA app-window target.
   */
  clickNativeCuaPoint?(target: NativeCuaPointTarget): Promise<void>;

  /**
   * Type text at the specified location.
   * Implementation: click to focus, then type programmatically (keystroke simulation, not paste).
   * MUST await completion before resolving.
   * @param centerPx - Center coordinates in device pixels
   * @param text - Text to type
   * @param clearFirst - If true, select-all before typing to replace existing content
   */
  typeAt(
    centerPx: { x: number; y: number },
    text: string,
    clearFirst?: boolean,
    targetBounds?: Bounds | null,
  ): Promise<void>;

  /**
   * Write text to an accessibility/UIA element by opaque element id.
   */
  typeElement?(
    elementId: string,
    text: string,
    clearFirst?: boolean,
    centerPx?: { x: number; y: number } | null,
    referenceWindowBounds?: Bounds | null,
  ): Promise<void>;

  /**
   * Replace the value of a native CUA element ref observed in the selected-context snapshot.
   */
  setNativeCuaElementValue?(target: NativeCuaElementTarget, value: string): Promise<void>;

  /**
   * Type literal text into a native CUA element ref observed in the selected-context snapshot.
   */
  typeNativeCuaElementText?(target: NativeCuaElementTarget, text: string): Promise<void>;

  /**
   * Type literal text into the focused control in the active native CUA app-window target.
   */
  typeNativeCuaAppWindowText?(target: NativeCuaAppWindowTarget, text: string): Promise<void>;

  /**
   * Select an option in a native CUA dropdown ref observed in the selected-context snapshot.
   */
  selectNativeCuaElementOption?(target: NativeCuaElementTarget, option: string): Promise<void>;

  /**
   * Scroll a native CUA element ref observed in the selected-context snapshot.
   */
  scrollNativeCuaElement?(target: NativeCuaElementTarget, direction: ScrollParams['direction'], pages: number): Promise<void>;

  /**
   * Scroll inside the active native CUA app-window target.
   */
  scrollNativeCuaAppWindow?(target: NativeCuaAppWindowTarget, direction: ScrollParams['direction'], pages: number): Promise<void>;

  /**
   * Press a key or key-combination in the active native CUA app-window target.
   */
  pressNativeCuaKey?(target: NativeCuaAppWindowTarget, key: string): Promise<void>;

  /**
   * Click a browser page element ref observed in the selected-context snapshot.
   */
  clickBrowserPageElement?(target: BrowserPageElementTarget): Promise<void>;

  /**
   * Replace text in a browser page element ref observed in the selected-context snapshot.
   */
  typeBrowserPageElement?(target: BrowserPageElementTarget, text: string): Promise<void>;

  /**
   * Select an exact option in a browser page select element ref observed in the selected-context snapshot.
   */
  selectBrowserPageElementOption?(target: BrowserPageElementTarget, value: string): Promise<void>;

  /**
   * Scroll a browser page frame observed in the selected-context snapshot.
   */
  scrollBrowserPageElement?(target: BrowserPageElementTarget, direction: ScrollParams['direction'], amount: number): Promise<void>;

  /**
   * Select an exact visible option for an accessibility/UIA dropdown by opaque element id.
   */
  selectOptionElement?(
    elementId: string,
    optionText: string,
    centerPx?: { x: number; y: number } | null,
    targetBounds?: Bounds | null,
  ): Promise<void>;

  /**
   * Type text into the currently focused control without performing another click first.
   * Used for already-open dropdowns/menus where another click would toggle or dismiss the control.
   * @param text - Text to type
   * @param clearFirst - If true, select-all before typing to replace existing content
   */
  typeFocused(
    text: string,
    clearFirst?: boolean,
    centerPx?: { x: number; y: number } | null,
    targetBounds?: Bounds | null,
    preferClipboard?: boolean,
  ): Promise<void>;

  /**
   * Set text on the currently focused accessibility element via AXValue.
   * Used as a fallback when synthetic keystrokes do not update a focused text control.
   * @param text - Text to assign to the focused element
   * @returns true if the focused element accepted the AX value write
   */
  setFocusedText(text: string): Promise<boolean>;

  /**
   * Press a hotkey combination.
   * The hotkey string is verbatim from the model; adapter is responsible for parsing and execution.
   * If a token is unrecognized, return an error (do not throw).
   * @param hotkey - Verbatim hotkey string (e.g., "cmd+shift+a")
   */
  pressHotkey(hotkey: string, centerPx?: { x: number; y: number } | null): Promise<void>;

  /**
   * Scroll on the specified element or coordinate.
   * The pointer is moved to the resolved location before emitting the wheel event.
   * @param centerPx - Target coordinates in screen DIP
   * @param direction - Wheel direction
   * @param amount - OS-dependent wheel steps
   */
  scroll(
    centerPx: { x: number; y: number },
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
  ): Promise<void>;

  /**
   * Scroll an accessibility/UIA element by opaque element id.
   */
  scrollElement?(
    elementId: string,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
  ): Promise<void>;
}

// UI Port

export interface UIPort {
  /**
   * Set the current UI state (idempotent).
   * Sends the full state to the renderer; renderer diffs and updates as needed.
   * @param state - Complete UIState
   */
  set(state: UIState): void;

  /**
   * Blur the overlay window to release focus.
   * Must be called before automation actions so clicks reach target apps.
   */
  blur(): void;

  /**
   * Register a callback for Accept action (Ctrl key, pill left-click, or bbox click).
   * @param cb - Callback invoked when user accepts
   */
  onAccept(cb: () => void): void;

  /**
   * Register a callback for Accept All action (Shift+Ctrl or shifted accept button).
   * @param cb - Callback invoked when user accepts the visible review group
   */
  onAcceptAll(cb: () => void): void;

  /**
   * Register a callback for enabling automatic approval for the current overlay session.
   * @param cb - Callback invoked when user accepts all future traces in this session
   */
  onAcceptAllSession(cb: () => void): void;

  /**
   * Register a callback for Reject action (Esc key, pill right-click, or outside interaction).
   * @param cb - Callback invoked when user rejects
   */
  onReject(cb: () => void): void;
}

// Input Port

export interface InputPort {
  /**
   * Register a callback for Ctrl key down event.
   * @param cb - Callback invoked when Ctrl is pressed
   */
  onCtrlDown(cb: () => void): void;

  /**
   * Register a callback for Ctrl key up event.
   * @param cb - Callback invoked when Ctrl is released
   */
  onCtrlUp(cb: () => void): void;

  /**
   * Register a callback for Shift key down event.
   * @param cb - Callback invoked when Shift is pressed
   */
  onShiftDown(cb: () => void): void;

  /**
   * Register a callback for Shift key up event.
   * @param cb - Callback invoked when Shift is released
   */
  onShiftUp(cb: () => void): void;

  /**
   * Register a callback for Ctrl+Space down event.
   * @param cb - Callback invoked when Ctrl+Space is pressed
   */
  onCtrlSpaceDown(cb: () => void): void;

  /**
   * Register a callback for Ctrl+Space up event.
   * @param cb - Callback invoked when Ctrl+Space is released
   */
  onCtrlSpaceUp(cb: () => void): void;

  /**
   * Register a callback for Esc key press event.
   * @param cb - Callback invoked when Esc is pressed
   */
  onEsc(cb: () => void): void;

  /**
   * Register a callback for global mouse down events.
   * Coordinates are in the same screen-space units emitted by the native input backend.
   */
  onMouseDown?(cb: (point: { x: number; y: number; button: number; coordinateSpace?: 'dip' | 'physical' }) => void): void;

  /**
   * Register a callback for global Ctrl+V paste shortcuts while the input backend is active.
   */
  onPasteShortcut?(cb: () => void): void;

  /**
   * Register a callback for global Enter submit shortcuts while the input backend is active.
   */
  onSubmitShortcut?(cb: () => void): void;

  /**
   * Register a callback for global mouse move events.
   */
  onMouseMove?(cb: (point: { x: number; y: number; coordinateSpace?: 'dip' | 'physical' }) => void): void;

  /**
   * Register a callback for global mouse up events.
   */
  onMouseUp?(cb: (point: { x: number; y: number; button: number; coordinateSpace?: 'dip' | 'physical' }) => void): void;
}

// Utility Ports

export interface Clock {
  /**
   * Get current timestamp in milliseconds.
   * @returns Timestamp (e.g., Date.now())
   */
  now(): number;
}

export interface Ids {
  /**
   * Generate a unique ID.
   * @returns UUID string
   */
  uuid(): string;
}

// STT Port

export interface STTPort {
  /**
   * Start recording audio from the system microphone.
   * Called when Ctrl key is pressed.
   * Returns immediately (non-blocking).
   * @throws Error if microphone access is denied
   */
  startRecording(): void;

  /**
   * Stop recording and transcribe the captured audio.
   * Called when Ctrl key is released.
   * Stops audio capture, sends audio to transcription service, and waits for result.
   * @returns Promise resolving to object with transcribed text
   * @throws Error if transcription fails
   */
  stopRecording(): Promise<{ text: string }>;

  /**
   * Abort the current recording immediately.
   * Called when Esc is pressed during recording.
   * Stops capture and cancels any in-flight transcription request.
   * Does NOT return text.
   */
  abortRecording(): void;

  /**
   * Register a callback for partial transcripts (streaming).
   * Optional method for future enhancement - not required for MVP.
   * @param callback - Function to call with partial transcript text
   */
  onPartialTranscript?(callback: (text: string) => void): void;
}
