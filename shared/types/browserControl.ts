import type { BrowserAccessPolicy } from '../browserAccessPolicy';

export type BrowserExtensionRelayPhase = 'idle' | 'starting' | 'ready' | 'error' | 'stopped';

export interface BrowserControlTarget {
  tabRef: string;
  targetId: string;
  type: string;
  title: string;
  url: string;
  controlSource?: 'user' | 'agent-created' | 'auto-created';
}

export type BrowserControlTabControlState = 'observable' | 'controllable';

export interface BrowserControlBrowserTab {
  tabRef: string;
  chromeTabId: number;
  windowId: number;
  index: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  title: string;
  url: string;
  status: string;
  controlState: BrowserControlTabControlState;
  controlStateDetail?: string;
  targetId?: string;
  sessionId?: string;
}

export interface BrowserControlBrowserWindow {
  windowId: number;
  focused: boolean;
  type: string;
  state: string;
  tabs: BrowserControlBrowserTab[];
}

export interface BrowserControlPageElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserControlPageElement {
  refId: string;
  index: number;
  tagName: string;
  role: string;
  name: string;
  text: string;
  value: string | null;
  inputType: string | null;
  checked: boolean | null;
  disabled: boolean;
  editable: boolean;
  clickable: boolean;
  bounds: BrowserControlPageElementBounds;
}

export interface BrowserControlPageElementFrame {
  frameId: number;
  chromeDocumentId: string | null;
  url: string;
  documentRevision: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
    screenBounds: BrowserControlPageElementBounds | null;
  };
  selectionText: string;
  totalElementCount: number;
  returnedElementCount: number;
  truncatedElementCount: number;
  elements: BrowserControlPageElement[];
}

export interface BrowserControlPageElementInventory {
  tabRef: string;
  chromeTabId: number;
  browserProfilePolicyId: string;
  origin: string | null;
  frames: BrowserControlPageElementFrame[];
}

export interface BrowserControlPageTraceResult {
  tabRef: string;
  chromeTabId: number;
  frameId: number;
  refId: string | null;
  bounds: BrowserControlPageElementBounds;
}

export interface BrowserControlPageClickResult {
  tabRef: string;
  chromeTabId: number;
  frameId: number;
  refId: string;
  bounds: BrowserControlPageElementBounds;
}

export interface BrowserControlPageTypeResult {
  tabRef: string;
  chromeTabId: number;
  frameId: number;
  refId: string;
  value: string;
  bounds: BrowserControlPageElementBounds;
}

export interface BrowserControlPageSelectResult {
  tabRef: string;
  chromeTabId: number;
  frameId: number;
  refId: string;
  value: string;
  bounds: BrowserControlPageElementBounds;
}

export interface BrowserControlPageScrollResult {
  tabRef: string;
  chromeTabId: number;
  frameId: number;
  refId?: string;
  scrollX: number;
  scrollY: number;
  viewport: {
    width: number;
    height: number;
  };
}

export interface BrowserControlConnection {
  extensionId: string;
  stableKey: string | null;
  profileId: string;
  browserName: string | null;
  version: string | null;
  activeSessions: number;
  targets: BrowserControlTarget[];
  browserWindows: BrowserControlBrowserWindow[];
  focusedWindowId: number | null;
  activeTabRef: string | null;
  focusedWindow: BrowserControlBrowserWindow | null;
  activeTab: BrowserControlBrowserTab | null;
}

export type BrowserControlProfileConnectionState = 'detected' | 'connected';

export interface BrowserControlProfile {
  profileId: string;
  policyProfileId: string | null;
  browserName: string | null;
  browserChannel: string | null;
  profileName: string;
  profilePath: string;
  userDataDir: string;
  extensionId: string | null;
  stableKey: string | null;
  connectionState: BrowserControlProfileConnectionState;
  activeSessions: number;
  windowCount: number;
  tabCount: number;
}

export interface BrowserControlRelayStatus {
  phase: BrowserExtensionRelayPhase;
  version: string | null;
  runtimeDir: string | null;
  relayLogPath: string | null;
  relayCdpLogPath: string | null;
  ownsRelayProcess: boolean;
  lastError: string | null;
  reachable: boolean;
  endpoint: string;
}

export interface BrowserControlStatus {
  relay: BrowserControlRelayStatus;
  connections: BrowserControlConnection[];
  profiles: BrowserControlProfile[];
  connectedBrowsers: number;
  activeSessions: number;
}

export interface BrowserControlPolicyGetResponse {
  policy: BrowserAccessPolicy;
}

export interface BrowserControlPolicySetResponse {
  success: boolean;
  policy: BrowserAccessPolicy;
  error?: string;
}

export interface BrowserControlChangedEvent {
  reason: 'policy' | 'status';
  policy: BrowserAccessPolicy;
}

export interface BrowserControlArrangeSplitRequest {
  extensionId: string;
  targetId: string;
}

export interface BrowserControlArrangeSplitResponse {
  success: boolean;
  error?: string;
}

export interface BrowserControlActivateTabRequest {
  tabRef: string;
}

export interface BrowserControlActivateTabResponse {
  success: boolean;
  error?: string;
}
