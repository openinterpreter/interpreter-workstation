/**
 * Simplified IPC Types
 *
 * Two channels only:
 * - overlay:state (main -> renderer) - everything in one object
 * - overlay:action (renderer -> main) - user did something
 */

import type { PillMode } from './types.js';
export type { Bounds } from './types.js';
import type { Bounds } from './types.js';
import type { OverlayTargetIdentity, CurrentSelectionContext } from './target-identity.js';
import type { SkillsData } from '../../../shared/types/skill';

/**
 * User-pasted/dropped image attachment, carried from the overlay renderer
 * through IPC and the overlay WebSocket to the LLM as a vision input.
 */
export interface OverlayUserAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  dataUrl?: string;
  filePath?: string;
  extractedText?: string;
  sizeBytes?: number;
}

export interface OverlaySelectionElement {
  id: string;
  role: string;
  label: string;
  bounds: Bounds;
  nativeCua?: {
    app: string;
    elementIndex: number;
    targetIdentity?: Record<string, unknown>;
  };
  browser?: {
    tabRef: string;
    chromeTabId: number;
    browserWindowId?: number | null;
    frameId: number | string;
    chromeDocumentId?: string | null;
    refId: string;
    browserProfilePolicyId: string;
    documentRevision: string;
    origin: string | null;
    url: string;
    targetIdentity?: Record<string, unknown>;
  };
}

export type OverlayContextRole = 'target' | 'reference';
export type OverlayRegionScopeKind = 'active-app' | 'screen-region' | 'whole-screen';

export interface OverlayRegionContextItem {
  id: string;
  kind: 'region';
  role: OverlayContextRole;
  label: string;
  scopeKind: OverlayRegionScopeKind;
  appIconDataUrl?: string | null;
  appIconLabel?: string | null;
  bounds: Bounds;
  displayId: string | number | null;
  targetWindowSessionKey: string | null;
  targetIdentity: OverlayTargetIdentity;
  snapshot: CurrentSelectionContext;
  previewText: string | null;
  previewImageDataUrl: string | null;
  selectableElements?: OverlaySelectionElement[];
}

export interface OverlayFileContextItem {
  id: string;
  kind: 'file';
  role: 'reference';
  name: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string | null;
  dataUrl?: string;
  sourceKind?: 'selected-file' | 'selected-text' | 'dropped-file';
  sourceLabel?: string | null;
  sourceBounds?: Bounds | null;
  sourceDisplayId?: string | number | null;
}

export type OverlayContextItem = OverlayRegionContextItem | OverlayFileContextItem;

export interface OverlayScreenQueryRegion {
  id: string;
  role: OverlayContextRole;
  label: string;
  bounds: Bounds;
  displayId: string | number | null;
}

export interface ReviewAction {
  id: string;
  type: 'click' | 'type' | 'hotkey' | 'scroll';
  description: string;
  detail?: string;
  bounds: Bounds;
  hasBounds?: boolean;
  centerColor?: string;
  text?: string;
  currentValue?: string;
  keys?: string;
  showLabel?: boolean;
}

export interface OverlayVisualProbe {
  id: string;
  bounds: Bounds;
  dataUrl: string;
  label: string;
}

export interface OverlayGlobalApproval {
  id: string;
  title: string;
  detail: string | null;
  supportsSessionApproval: boolean;
}

export interface OverlayRunningAgent {
  agentId: string;
  threadId: string | null;
  windowSessionKey: string | null;
  workspacePath: string | null;
  label: string;
  latestAction: string | null;
  unreadCount: number;
  updatedAt: string | null;
}

export interface OverlayDashboardApproval {
  id: string;
  ownerAgentId: string | null;
  ownerKind: string;
  ownerDisplayName: string;
  ownerColor: string;
  title: string;
  detail: string | null;
  isSimpleApproval: boolean;
  supportsSessionApproval: boolean;
  timestamp: number;
}

export interface OverlayAdvancedVoiceCompletionNotice {
  id: string;
  at: number;
  threadId: string | null;
}

export type OverlayAdvancedVoiceSessionKind = 'advanced_voice' | 'onboarding_voice_interview';

export interface OverlayState {
  mode: 'idle' | 'input' | 'working' | 'review';
  action: ReviewAction | null;
  ghosts: ReviewAction[];
  pill: PillMode;
  screenshot: string | null;
  transcript: string;
  inputReady: boolean;
  isRecording: boolean;
  amplitude: number;
  ctrlPressed: boolean;
  shiftPressed: boolean;
  scopeBounds: Bounds | null;
  draftScopeBounds: Bounds | null;
  selectableElements: OverlaySelectionElement[];
  contextItems: OverlayContextItem[];
  activeRegionRole: OverlayContextRole;
  targetContextId: string | null;
  displayScaleFactor: number;
  // Display workArea in overlay-window-local DIP coordinates (display bounds
  // origin subtracted). Null until an interaction display is known. The
  // renderer keeps the interaction pill inside this rect so it never sits
  // under the macOS menu bar/notch or the Dock.
  displayWorkArea: Bounds | null;
  tracePrimaryColor: string;
  // True while the world overlay is pinned above a target window. The chrome
  // renderer hides its spatial layers (AgentMarker, ScopeSelectionSheen, etc.)
  // when this is true; the world renderer takes over drawing them.
  worldPinActive: boolean;
  // World overlay window bounds in display-local DIP coordinates while pinned.
  // For region-scoped runs this is the selected region, not the whole target
  // OS window. The world renderer subtracts this from display-local scope/action
  // bounds to get window-local CSS coordinates.
  worldTargetBounds: Bounds | null;
  worldPinClosing: boolean;
  debugVisualProbe: OverlayVisualProbe | null;
  debugExecutionSentinel: boolean;
  advancedVoiceActive: boolean;
  advancedVoiceSessionKind: OverlayAdvancedVoiceSessionKind;
  advancedVoiceCompletionNotice: OverlayAdvancedVoiceCompletionNotice | null;
  globalApproval: OverlayGlobalApproval | null;
  runningAgents: OverlayRunningAgent[];
  dashboardApprovals: OverlayDashboardApproval[];
}

export interface OverlayVisualHealth {
  source?: 'chrome' | 'world';
  renderedMode: OverlayState['mode'];
  pillKind: PillMode['kind'];
  hasDebugVisualProbe?: boolean;
  debugVisualProbeBounds?: Bounds | null;
  hasExecutionSentinel?: boolean;
  executionSentinelBounds?: Bounds | null;
  activeActionId?: string | null;
  reviewActionId?: string | null;
  activeActionBounds?: Bounds | null;
  reviewActionBounds?: Bounds | null;
  scopeFrameBounds?: Bounds | null;
  tracePrimaryColor?: string | null;
  hasRenderedDom: boolean;
  hasVisiblePill: boolean;
  // Bounds of the visible pill shell in overlay-window-local DIP coordinates,
  // or null when no pill is visible. Harness gates use this to pin pill
  // placement (e.g. never in the top band of the display work area).
  pillBounds?: Bounds | null;
  hasVisibleInputControl: boolean;
  hasVisibleReviewControl: boolean;
  hasVisibleMarker: boolean;
  hasVisibleThinkingSheen?: boolean;
  hasVisibleAffordance: boolean;
  domNodeCount: number;
  selectedWorkspaceValue?: string | null;
  selectedProfileId?: string | null;
  workspaceTriggerBounds?: Bounds | null;
  profileTriggerBounds?: Bounds | null;
  editorBounds?: Bounds | null;
  primaryActionBounds?: Bounds | null;
  contextSourceHighlightBounds?: Bounds[];
  contextChipBounds?: Array<{
    id: string;
    bounds: Bounds;
    removeBounds: Bounds | null;
    highlighted: boolean;
  }>;
  reviewControlBounds?: Bounds | null;
  workspaceOptionBounds?: Array<{ value: string; label: string; bounds: Bounds }>;
  profileOptionBounds?: Array<{ value: string; label: string; bounds: Bounds }>;
  timestamp: number;
}

export interface OverlayOpenWorkspaceOption {
  sessionKey: string;
  windowId: number;
  workspacePath: string;
  workspaceName: string;
  label: string;
}

export interface OverlayRecentWorkspaceOption {
  workspacePath: string;
  workspaceName: string;
  label: string;
  lastOpened: number;
}

export interface OverlayProfileOption {
  id: string;
  label: string;
  description?: string;
  isDefault: boolean;
  kind: 'agent';
}

export interface OverlayBootstrapData {
  currentWorkspacePath: string | null;
  currentWorkspaceName: string | null;
  openWorkspaces: OverlayOpenWorkspaceOption[];
  recentWorkspaces: OverlayRecentWorkspaceOption[];
  profiles: OverlayProfileOption[];
  defaultProfileId: string | null;
  preferredWorkspacePath: string | null;
  preferredWorkspaceName: string | null;
  preferredNoWorkspace: boolean;
  preferredProfileId: string | null;
}

export interface OverlaySkillsResponse {
  success: boolean;
  data?: SkillsData;
  error?: string;
}

export type OverlayAction =
  | { type: 'accept' }
  | { type: 'accept-all' }
  | { type: 'accept-all-session' }
  | { type: 'reject' }
  | { type: 'dismiss' }
  | { type: 'draft-changed'; text: string }
  | { type: 'scope-selection-started' }
  | { type: 'scope-selection-ended' }
  | { type: 'scope-draft-changed'; bounds: Bounds | null }
  | { type: 'scope-selected'; bounds: Bounds }
  | { type: 'region-selected'; bounds: Bounds; role?: OverlayContextRole }
  | { type: 'clear-input-context' }
  | { type: 'remove-context-item'; id: string }
  | { type: 'set-active-region-role'; role: OverlayContextRole }
  | { type: 'files-dropped'; files: OverlayFileContextItem[] }
  | { type: 'toggle-voice-recording' }
  | { type: 'stop-advanced-voice' }
  | { type: 'approve-global-approval' }
  | { type: 'deny-global-approval' }
  | { type: 'reveal-agent-window'; agentId: string }
  | { type: 'stop-agent-window'; agentId: string }
  | { type: 'send-agent-window-message'; agentId: string; message: string }
  | { type: 'approve-dashboard-approval'; approvalId: string; rememberForSession?: boolean }
  | { type: 'deny-dashboard-approval'; approvalId: string }
  | { type: 'renderer-ready' }
  | { type: 'request-state-sync'; reason: 'renderer-ready' | 'input-focus-request' }
  | { type: 'input-focus-change'; focused: boolean }
  | { type: 'visual-health'; health: OverlayVisualHealth }
  | {
      type: 'submit';
      text: string;
      attachments?: OverlayUserAttachment[];
      contextItems?: OverlayContextItem[];
      workspacePath: string | null;
      targetWindowSessionKey: string | null;
      profileId: string;
    };

export const DEFAULT_OVERLAY_STATE: OverlayState = {
  mode: 'idle',
  action: null,
  ghosts: [],
  pill: { kind: 'hidden' },
  screenshot: null,
  transcript: '',
  inputReady: false,
  isRecording: false,
  amplitude: 0,
  ctrlPressed: false,
  shiftPressed: false,
  scopeBounds: null,
  draftScopeBounds: null,
  selectableElements: [],
  contextItems: [],
  activeRegionRole: 'target',
  targetContextId: null,
  displayScaleFactor: 1,
  displayWorkArea: null,
  tracePrimaryColor: '#2979ff',
  worldPinActive: false,
  worldTargetBounds: null,
  worldPinClosing: false,
  debugVisualProbe: null,
  debugExecutionSentinel: false,
  advancedVoiceActive: false,
  advancedVoiceSessionKind: 'advanced_voice',
  advancedVoiceCompletionNotice: null,
  globalApproval: null,
  runningAgents: [],
  dashboardApprovals: [],
};
