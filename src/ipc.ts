/**
 * Unified IPC Abstraction Layer
 *
 * Single module that handles both Electron IPC and browser HTTP+SSE modes.
 * Components import from here instead of using window.electron directly.
 *
 * Architecture:
 * - Electron mode: Passes through to window.electron (IPC)
 * - Browser mode: HTTP for requests, SSE for events
 */

import type {
  OAuthStatus,
  OllamaStatus,
  LmStudioStatus,
  EnvApiKeysResult,
  ClaudeCodeStatus,
  CodexStatus,
  ClaudeCodeLoginResult,
  SupportedOpenAIOAuthModel,
  OpenRouterModelCatalogResult,
  ApiPreset,
} from '../shared/types/provider';
import type { ProfileSetupStatus } from '../shared/types/profile';
import type { ApiProviderModelOption } from './utils/apiProviderModelOptions';
import type { v2 } from '../server/handlers/codex-generated-types/index';
import type { InterpreterOverlaySettings } from '../apps/interpreter-overlay/shared/settings';
import type { InterpreterOverlayAccessState } from '../server/lib/subscriptionStatus';
import type {
  InterpreterOverlayStartWindowVoiceRequest,
  InterpreterOverlayStartWindowVoiceResponse,
  InterpreterOverlayOnboardingVoiceInterviewCompletedEvent,
} from '../electron/ipc/registry';
import type { LayoutState } from '../shared/types/layout';
import type {
  BrowserControlStatus,
  BrowserControlChangedEvent,
  BrowserControlPolicyGetResponse,
  BrowserControlPolicySetResponse,
  BrowserControlArrangeSplitRequest,
  BrowserControlArrangeSplitResponse,
  BrowserControlActivateTabRequest,
  BrowserControlActivateTabResponse,
} from '../shared/types/browserControl';
import type { BrowserAccessPolicy } from '../shared/browserAccessPolicy';
import type { CuaAccessPolicy } from '../shared/cuaAccessPolicy';
import type { FileThumbnailData } from '../shared/types/fileThumbnail';
import type { ProjectRunnerState } from '../shared/types/projectRunner';
import type { VaultNoteContext, VaultSnapshot, VaultSearchResult, VaultTagSummary } from '../shared/types/vault';
import {
  marketingDemoApprovalsIpc,
  marketingDemoAgentTabsIpc,
  marketingDemoBackgroundOpacityIpc,
  marketingDemoDesktopNotificationIpc,
  marketingDemoInterviewInviteIpc,
  getMarketingDemoFileUrl,
  isMarketingDemoMode,
  marketingDemoFilesIpc,
  marketingDemoGlobalToolsIpc,
  marketingDemoLocaleIpc,
  marketingDemoMcpDiscoveryIpc,
  marketingDemoPdfIpc,
  marketingDemoPrimaryColorIpc,
  marketingDemoProgrammaticTasksIpc,
  marketingDemoProfilesIpc,
  marketingDemoProvidersIpc,
  marketingDemoServersIpc,
  marketingDemoSkillsIpc,
  marketingDemoSttIpc,
  marketingDemoTelemetryIpc,
  marketingDemoThemeIpc,
  marketingDemoTopNoticesIpc,
  marketingDemoTtsIpc,
  marketingDemoToolServersIpc,
  marketingDemoUiSettingsIpc,
  marketingDemoZoomFactorIpc,
  marketingDemoUserNameIpc,
  marketingDemoVaultIpc,
  marketingDemoWindowIpc,
  marketingDemoWorkspaceIpc,
} from './demo/marketingDemo';

// ============================================================================
// Mode Detection
// ============================================================================

const viteEnv = (import.meta as ImportMeta & {
  env?: {
    DEV?: boolean;
  };
}).env;

// Cache the browser dev mode check at module initialization time
// This must happen BEFORE browserDevShim.ts sets window.electron
const _isBrowserDevMode = typeof window !== 'undefined'
  && !window.electron
  && (viteEnv?.DEV || isMarketingDemoMode());

export const isBrowserDevMode = (): boolean => _isBrowserDevMode;

export const isUnpackagedElectron = (): boolean => {
  if (typeof window === 'undefined' || !window.electron?.isPackaged) {
    return false;
  }

  return !window.electron.isPackaged();
};

function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && !!window.electron;
}

const isElectron = isElectronRuntime();
const ELECTRON_APP_SERVER_HOST = '127.0.0.1';
const NOOP_UNSUBSCRIBE = () => {};

// ============================================================================
// Context Menu Types (re-exported from registry for convenience)
// ============================================================================

export interface ContextMenuItem {
  label: string;
  action: string;           // Returned when item is clicked
  accelerator?: string;     // e.g., 'CmdOrCtrl+B'
  disabled?: boolean;
  separator?: boolean;      // If true, renders as separator (ignores other props)
  submenu?: ContextMenuItem[]; // Optional nested submenu items
}

// ============================================================================
// Select Types (re-exported from registry for convenience)
// ============================================================================

export interface SelectItem {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface DesktopSourceDescriptor {
  id: string;
  name: string;
  kind: 'screen';
  displayId: string;
  thumbnailDataUrl: string | null;
}

export interface DesktopSourceListResponse {
  sources: DesktopSourceDescriptor[];
}

// ============================================================================
// Browser Mode: SSE Event Subscriptions
// ============================================================================

type EventCallback = (data: unknown) => void;
const sseListeners = new Map<string, Set<EventCallback>>();
let sseConnection: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function initSSE(): void {
  if (sseConnection || isElectron || isMarketingDemoMode()) return;

  console.log('[IPC] Initializing SSE connection');
  sseConnection = new EventSource('/api/events');

  sseConnection.onopen = () => {
    console.log('[IPC] SSE connected');
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
  };

  sseConnection.onmessage = (event) => {
    try {
      const { channel, data } = JSON.parse(event.data);
      const listeners = sseListeners.get(channel);
      if (listeners) {
        listeners.forEach((cb) => {
          try {
            cb(data);
          } catch (err) {
            console.error(`[IPC] Error in SSE listener for ${channel}:`, err);
          }
        });
      }
    } catch (err) {
      // Ignore keepalive messages
      if (!event.data.startsWith(':')) {
        console.error('[IPC] Error parsing SSE message:', err);
      }
    }
  };

  sseConnection.onerror = () => {
    console.warn('[IPC] SSE connection error, will reconnect...');
    sseConnection?.close();
    sseConnection = null;
    // Reconnect after 2 seconds
    sseReconnectTimer = setTimeout(initSSE, 2000);
  };
}

function subscribeSSE(channel: string, callback: EventCallback): () => void {
  initSSE();

  if (!sseListeners.has(channel)) {
    sseListeners.set(channel, new Set());
  }
  sseListeners.get(channel)!.add(callback);

  // Return unsubscribe function
  return () => {
    const listeners = sseListeners.get(channel);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) {
        sseListeners.delete(channel);
      }
    }
  };
}

// ============================================================================
// Browser Mode: HTTP Requests
// ============================================================================

async function httpCall<T = unknown>(
  namespace: string,
  method: string,
  args: unknown[]
): Promise<T> {
  const response = await fetch(`/api/ipc/${namespace}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// ============================================================================
// Browser Mode: Native Feature Implementations
// ============================================================================

async function browserOpenFolderDialog(): Promise<{
  canceled: boolean;
  filePaths: string[];
}> {
  // Use File System Access API if available
  if ('showDirectoryPicker' in window) {
    try {
      const handle = await (window as any).showDirectoryPicker();
      // Note: We only get the directory name, not the full path (browser security)
      return { canceled: false, filePaths: [handle.name] };
    } catch (err: any) {
      // User cancelled or API not supported
      if (err.name === 'AbortError') {
        return { canceled: true, filePaths: [] };
      }
      console.warn('[IPC] File System Access API error:', err);
    }
  }
  return { canceled: true, filePaths: [] };
}

// Store for pending context menu resolution
let pendingContextMenuResolve: ((action: string | null) => void) | null = null;

function browserShowContextMenu(items: ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    pendingContextMenuResolve = resolve;
    window.dispatchEvent(
      new CustomEvent('show-context-menu', {
        detail: { items },
      })
    );
  });
}

// Called by BrowserContextMenu when an item is clicked or menu is dismissed
export function resolveContextMenu(action: string | null): void {
  if (pendingContextMenuResolve) {
    pendingContextMenuResolve(action);
    pendingContextMenuResolve = null;
  }
}

// Store for pending select resolution
let pendingSelectResolve: ((value: string | null) => void) | null = null;

interface BrowserSelectDetail {
  items: SelectItem[];
  currentValue?: string;
  x: number;
  y: number;
}

function browserShowSelect(
  items: SelectItem[],
  currentValue: string | undefined,
  x: number,
  y: number
): Promise<string | null> {
  return new Promise((resolve) => {
    pendingSelectResolve = resolve;
    window.dispatchEvent(
      new CustomEvent<BrowserSelectDetail>('show-select', {
        detail: { items, currentValue, x, y },
      })
    );
  });
}

// Called by BrowserSelect when an item is clicked or menu is dismissed
export function resolveSelect(value: string | null): void {
  if (pendingSelectResolve) {
    pendingSelectResolve(value);
    pendingSelectResolve = null;
  }
}

// ============================================================================
// Proxy-based Client
// ============================================================================

/**
 * Convert method name to SSE channel name.
 * onFilesChanged -> files-changed
 * onCreated -> created
 */
function methodToChannel(namespace: string, method: string): string {
  // Remove 'on' prefix and convert to kebab-case
  const eventName = method
    .slice(2) // Remove 'on'
    .replace(/([A-Z])/g, '-$1') // camelCase to kebab-case
    .toLowerCase()
    .slice(1); // Remove leading hyphen

  return `${namespace}:${eventName}`;
}

function createBrowserProxy(): any {
  return new Proxy(
    {},
    {
      get(_, namespace: string) {
        // Namespace proxy - each namespace is itself a proxy
        return new Proxy(
          {},
          {
            get(_, method: string) {
              // Event subscription methods (start with 'on')
              if (method.startsWith('on') && method.length > 2) {
                const channel = methodToChannel(namespace, method);
                return (callback: EventCallback) => subscribeSSE(channel, callback);
              }

              // Regular methods - make HTTP call
              return (...args: unknown[]) => httpCall(namespace, method, args);
            },
          }
        );
      },
    }
  );
}

function createMarketingDemoClient(): any {
  return new Proxy(
    {},
    {
      get(_, namespace: string | symbol) {
        if (typeof namespace !== 'string') {
          return undefined;
        }
        return new Proxy(
          {},
          {
            get(_, method: string | symbol) {
              if (typeof method !== 'string') {
                return undefined;
              }
              if (method.startsWith('on') && method.length > 2) {
                return () => NOOP_UNSUBSCRIBE;
              }

              return async () => {
                throw new Error(`[MarketingDemo] ${namespace}.${method} is disabled.`);
              };
            },
          },
        );
      },
    },
  );
}

// Use Electron IPC if available, otherwise use browser proxy
// In Electron mode, also create a fallback proxy for namespaces not defined in window.electron
function createElectronFallbackProxy(namespace: string): any {
  // For namespaces not in window.electron, use apiRequest to hit /api/ipc/:namespace/:method
  return new Proxy(
    {},
    {
      get(_, method: string) {
        // Event subscriptions FAIL LOUDLY - namespace must be added to preload.ts
        if (method.startsWith('on') && method.length > 2) {
          throw new Error(
            `[IPC] Event subscription "${namespace}.${method}" failed: ` +
            `namespace "${namespace}" is not defined in electron/preload.ts. ` +
            `Add it to preload.ts to enable event subscriptions in Electron mode.`
          );
        }

        // Regular methods - use apiRequest to call HTTP endpoint
        return async (...args: unknown[]) => {
          const response = await window.electron.apiRequest({
            method: 'POST',
            path: `/api/ipc/${namespace}/${method}`,
            body: args,
          });
          if (!response.ok) {
            throw new Error((response.data as any)?.error || 'Request failed');
          }
          return response.data;
        };
      },
    }
  );
}

function createElectronClient(): any {
  return new Proxy(
    {},
    {
      get(_, namespace: string) {
        // If namespace exists in window.electron, use it (proper IPC)
        if (window.electron && (window.electron as any)[namespace]) {
          return (window.electron as any)[namespace];
        }
        // Otherwise, use fallback that routes through apiRequest
        return createElectronFallbackProxy(namespace);
      },
    }
  );
}

const client = isMarketingDemoMode()
  ? createMarketingDemoClient()
  : isElectron
    ? createElectronClient()
    : createBrowserProxy();

// ============================================================================
// Typed IPC Interfaces
// ============================================================================

type OAuthProviderType = 'openai' | 'claude';

interface ProvidersIpc {
  initiateOAuth(providerType: OAuthProviderType): Promise<{ authUrl: string; flowId: string }>;
  completeOAuth(providerType: OAuthProviderType, code: string, flowId: string): Promise<{ success: boolean; email?: string; error?: string }>;
  getOAuthStatus(providerType: OAuthProviderType): Promise<OAuthStatus>;
  listOpenAIOAuthModels(): Promise<{ models: SupportedOpenAIOAuthModel[] }>;
  listOpenRouterModels(options?: { forceRefresh?: boolean }): Promise<OpenRouterModelCatalogResult>;
  listDeepSeekModels(apiKey: string): Promise<{ models: ApiProviderModelOption[] }>;
  listInterpreterProviders(includeUnconfigured?: boolean): Promise<{ providers: v2.InterpreterProvider[] }>;
  setInterpreterProvider(providerId: string, profile?: string): Promise<{ success: true }>;
  listInterpreterModels(providerId?: string, includeHidden?: boolean): Promise<{ models: SupportedOpenAIOAuthModel[] }>;
  setInterpreterModel(
    model: string,
    reasoningEffort?: v2.InterpreterModelSetParams["reasoningEffort"],
    profile?: string,
  ): Promise<{ success: true }>;
  listInterpreterHarnesses(providerId: string, model?: string): Promise<{ harnesses: v2.InterpreterHarness[] }>;
  setInterpreterHarness(harness?: string, profile?: string): Promise<{ success: true }>;
  disconnectOAuth(providerType: OAuthProviderType): Promise<{ success: boolean }>;
  getOllamaStatus(baseURL?: string, apiKey?: string): Promise<OllamaStatus>;
  getLmStudioStatus(baseURL?: string, apiKey?: string): Promise<LmStudioStatus>;
  getEnvApiKeys(): Promise<EnvApiKeysResult>;
  getEnvApiKey(type: ApiPreset): Promise<{ key: string | null }>;
  getClaudeCodeStatus(): Promise<ClaudeCodeStatus>;
  runClaudeLogin(): Promise<ClaudeCodeLoginResult>;
  setClaudeCodePath(customPath: string | null): Promise<{ success: boolean; error?: string }>;
  setCodexPath(customPath: string | null): Promise<{ success: boolean; error?: string }>;
  getCodexStatus(): Promise<CodexStatus>;
  getGitHubCliAuth(): Promise<{
    installed: boolean;
    loggedIn: boolean;
    source?: 'gh-cli' | 'env';
    path?: string;
    error?: string;
  }>;
  addGitHubMcpServerFromCliAuth(): Promise<{
    success: boolean;
    serverId?: string;
    installed: boolean;
    loggedIn: boolean;
    source?: 'gh-cli' | 'env';
    path?: string;
    error?: string;
  }>;
  probeResponsesApiSupport(baseURL: string): Promise<{ supported: boolean; reachable: boolean }>;
  rescanBinaryPaths(): Promise<{
    claude: { found: boolean; path?: string };
    codex: { found: boolean; path?: string };
  }>;
  getAllProfileStatuses(isAuthenticated?: boolean): Promise<Record<string, ProfileSetupStatus>>;
}

interface RuntimeIpc {
  onRestarting(callback: (event: { requestedAt: number; runningAgentCount: number }) => void): () => void;
  onRestarted(callback: (event: { restartedAt: number; stoppedAgentCount?: number }) => void): () => void;
}

interface OverlaySettingsIpc {
  get(): Promise<{ settings: InterpreterOverlaySettings }>;
  set(settings: InterpreterOverlaySettings): Promise<{ success: boolean; settings: InterpreterOverlaySettings }>;
  getAccessState(options?: { forceRefresh?: boolean }): Promise<{ state: InterpreterOverlayAccessState }>;
  getPermissionStatus(): Promise<{
    status: {
      accessibilityGranted: boolean;
      screenRecordingGranted: boolean;
      screenRecordingStatus: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
    };
  }>;
  requestAccessibilityPermission(): Promise<{
    success: boolean;
    status: {
      accessibilityGranted: boolean;
      screenRecordingGranted: boolean;
      screenRecordingStatus: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
    };
    error?: string;
  }>;
  requestScreenRecordingPermission(): Promise<{
    success: boolean;
    status: {
      accessibilityGranted: boolean;
      screenRecordingGranted: boolean;
      screenRecordingStatus: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
    };
    error?: string;
  }>;
  openAccessibilitySettings(): Promise<{ success: boolean; error?: string }>;
  openScreenRecordingSettings(): Promise<{ success: boolean; error?: string }>;
}

interface ComputerUseSetupIpc {
  onRequested(callback: (event: { reason: 'desktop-tool' }) => void): () => void;
  onStatusRequested(callback: (event: { requestId: string }) => void): () => void;
  ready(): Promise<{ success: boolean }>;
  reportStatus(
    requestId: string,
    status: {
      accessibilityGranted: boolean;
      screenRecordingGranted: boolean;
      screenRecordingStatus?: string;
    },
  ): Promise<{ success: boolean }>;
}

interface NativeToolsIpc {
  restart(): Promise<{ success: boolean }>;
  getNetworkAccess(): Promise<{ enabled: boolean }>;
  setNetworkAccess(enabled: boolean): Promise<{ success: boolean }>;
  getSandboxNetworkAccess(): Promise<{ enabled: boolean }>;
  setSandboxNetworkAccess(enabled: boolean): Promise<{ success: boolean }>;
  getApprovalPolicy(): Promise<{ policy: 'never' | 'on-failure' | 'on-request' | 'untrusted' }>;
  setApprovalPolicy(policy: 'never' | 'on-failure' | 'on-request' | 'untrusted'): Promise<{ success: boolean }>;
  getSandboxMode(): Promise<{ mode: 'read-only' | 'workspace-write' | 'danger-full-access' }>;
  setSandboxMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<{ success: boolean }>;
  getReadAccessMode(): Promise<{ mode: 'workspace-only' | 'full-system' }>;
  setReadAccessMode(mode: 'workspace-only' | 'full-system'): Promise<{ success: boolean }>;
  getMacosTempAccess(): Promise<{ enabled: boolean }>;
  setMacosTempAccess(enabled: boolean): Promise<{ success: boolean }>;
  getMacosScreenshotAccess(): Promise<{ enabled: boolean }>;
  setMacosScreenshotAccess(enabled: boolean): Promise<{ success: boolean }>;
  getCuaAccessPolicy(): Promise<{ policy: CuaAccessPolicy }>;
  setCuaAccessPolicy(policy: CuaAccessPolicy): Promise<{ success: boolean; policy: CuaAccessPolicy }>;
  getApprovalAutoApproveForTests(): Promise<{ enabled: boolean }>;
  setApprovalAutoApproveForTests(enabled: boolean): Promise<{ success: boolean }>;
  setupWindowsSandbox(mode: 'elevated' | 'unelevated'): Promise<{
    success: boolean;
    error: string | null;
    mode: 'elevated' | 'unelevated';
  }>;
}

interface BrowserControlIpc {
  getStatus(): Promise<BrowserControlStatus>;
  getPolicy(): Promise<BrowserControlPolicyGetResponse>;
  setPolicy(policy: BrowserAccessPolicy): Promise<BrowserControlPolicySetResponse>;
  arrangeSplit(request: BrowserControlArrangeSplitRequest): Promise<BrowserControlArrangeSplitResponse>;
  activateTab(request: BrowserControlActivateTabRequest): Promise<BrowserControlActivateTabResponse>;
  onChanged?(callback: (event: BrowserControlChangedEvent) => void): () => void;
}

interface VaultIpc {
  getSnapshot(): Promise<VaultSnapshot>;
  getNoteContext(request: { filePath: string }): Promise<VaultNoteContext>;
  getTags(request?: { limit?: number }): Promise<{ tags: VaultTagSummary[] }>;
  searchNotes(request: { query: string; limit?: number }): Promise<{ results: VaultSearchResult[] }>;
}

interface ProjectRunnerIpc {
  start(projectPath: string): Promise<{ success: boolean; state: ProjectRunnerState; error?: string }>;
  stop(projectPath: string): Promise<{ success: boolean; state: ProjectRunnerState; error?: string }>;
  getStatus(projectPath: string): Promise<{ success: boolean; state: ProjectRunnerState }>;
  onChanged?(callback: (event: { state: ProjectRunnerState }) => void): () => void;
}

interface AgentThreadsIpc {
  deleteThread(threadId: string): Promise<{ success: boolean; error?: string }>;
  deleteAll(): Promise<{ success: boolean; trashedCount?: number; error?: string }>;
  renameThread(threadId: string, name: string): Promise<{ success: boolean; name?: string; error?: string }>;
  archiveThread(threadId: string): Promise<{ success: boolean; error?: string }>;
  unarchiveThread(threadId: string): Promise<{ success: boolean; error?: string }>;
}

const disabledAgentThreadsIpc: AgentThreadsIpc = {
  deleteThread: async () => {
    throw new Error('[IPC] agentThreads.deleteThread is only available in Electron.');
  },
  deleteAll: async () => {
    throw new Error('[IPC] agentThreads.deleteAll is only available in Electron.');
  },
  renameThread: async () => {
    throw new Error('[IPC] agentThreads.renameThread is only available in Electron.');
  },
  archiveThread: async () => {
    throw new Error('[IPC] agentThreads.archiveThread is only available in Electron.');
  },
  unarchiveThread: async () => {
    throw new Error('[IPC] agentThreads.unarchiveThread is only available in Electron.');
  },
};

// ============================================================================
// Exported Namespaces
// ============================================================================

export const approvals = isMarketingDemoMode() ? marketingDemoApprovalsIpc : client.approvals;
export const runtime: RuntimeIpc = isMarketingDemoMode()
  ? {
    onRestarting: () => NOOP_UNSUBSCRIBE,
    onRestarted: () => NOOP_UNSUBSCRIBE,
  }
  : client.runtime;
export const agentTabs = isMarketingDemoMode() ? marketingDemoAgentTabsIpc : client.agentTabs;
export const agentThreads: AgentThreadsIpc = isMarketingDemoMode()
  ? disabledAgentThreadsIpc
  : isElectron
    ? window.electron.agentThreads
    : disabledAgentThreadsIpc;
export const workspace = isMarketingDemoMode() ? marketingDemoWorkspaceIpc : client.workspace;
export const vault: VaultIpc = isMarketingDemoMode() ? marketingDemoVaultIpc : client.vault;
export const setup = client.setup;
export const computerUseSetup: ComputerUseSetupIpc = {
  onRequested: (callback) => client.computerUseSetup.onRequested(callback),
  onStatusRequested: (callback) => client.computerUseSetup.onStatusRequested(callback),
  ready: async () => {
    const response = await apiRequest({
      method: 'POST',
      path: '/api/ipc/computerUseSetup/ready',
      body: [],
    });
    if (!response.ok) {
      const error = response.data && typeof response.data === 'object' && 'error' in response.data
        ? String((response.data as { error: unknown }).error)
        : `Computer Use Setup ready failed with status ${response.status}`;
      throw new Error(error);
    }
    return response.data as { success: boolean };
  },
  reportStatus: async (requestId, status) => {
    const response = await apiRequest({
      method: 'POST',
      path: '/api/ipc/computerUseSetup/status',
      body: [requestId, status],
    });
    if (!response.ok) {
      const error = response.data && typeof response.data === 'object' && 'error' in response.data
        ? String((response.data as { error: unknown }).error)
        : `Computer Use Setup status failed with status ${response.status}`;
      throw new Error(error);
    }
    return response.data as { success: boolean };
  },
};
export const profiles = isMarketingDemoMode() ? marketingDemoProfilesIpc : client.profiles;
export const settings = client.settings;
export const servers = isMarketingDemoMode() ? marketingDemoServersIpc : client.servers;
export const pdf = isMarketingDemoMode() ? marketingDemoPdfIpc : client.pdf;
export const markdown = client.markdown;
export const files = isMarketingDemoMode() ? marketingDemoFilesIpc : client.files;
export const projectRunner: ProjectRunnerIpc = client.projectRunner;
export const movie = client.movie;
export const remotion = client.remotion;
export const checkpoint = client.checkpoint;
export const shell = client.shell;
export const desktopSources = client.desktopSources as {
  list(request?: {
    types?: Array<'screen'>;
    thumbnailSize?: { width: number; height: number };
  }): Promise<DesktopSourceListResponse>;
};
export const conversations = client.conversations;
export const officeExtension = client.officeExtension;
export const voiceExtension = client.voiceExtension;
export const tts = isMarketingDemoMode() ? marketingDemoTtsIpc : client.tts;
export const stt = isMarketingDemoMode() ? marketingDemoSttIpc : client.stt;
export const browser = client.browser;
export const browserControl: BrowserControlIpc = client.browserControl;
export const locale = isMarketingDemoMode() ? marketingDemoLocaleIpc : client.locale;
export const backgroundOpacity = isMarketingDemoMode()
  ? marketingDemoBackgroundOpacityIpc
  : client.backgroundOpacity;
export const zoomFactor = isMarketingDemoMode() ? marketingDemoZoomFactorIpc : client.zoomFactor;
export const theme = isMarketingDemoMode() ? marketingDemoThemeIpc : client.theme;
export const primaryColor = isMarketingDemoMode()
  ? marketingDemoPrimaryColorIpc
  : client.primaryColor;
export const windowIpc = isMarketingDemoMode() ? marketingDemoWindowIpc : client.window;
export const tabs = client.tabs;
export const quickActions = client.quickActions;
export const workstation = client.workstation;
export const appUpdate = client.appUpdate;
export const toolServers = isMarketingDemoMode() ? marketingDemoToolServersIpc : client.toolServers;
export const mcpDiscovery = isMarketingDemoMode() ? marketingDemoMcpDiscoveryIpc : client.mcpDiscovery;
export const subagentTools = client.subagentTools;
export const providers: ProvidersIpc = isMarketingDemoMode()
  ? marketingDemoProvidersIpc as ProvidersIpc
  : client.providers;
export const agentSettings = client.agentSettings;
export const uiSettings = isMarketingDemoMode() ? marketingDemoUiSettingsIpc : client.uiSettings;
export const overlaySettings: OverlaySettingsIpc = client.overlaySettings;
export const interpreterOverlay: {
  startWindowVoiceMode(request?: InterpreterOverlayStartWindowVoiceRequest): Promise<InterpreterOverlayStartWindowVoiceResponse>;
  onOnboardingVoiceInterviewCompleted(
    callback: (event: InterpreterOverlayOnboardingVoiceInterviewCompletedEvent) => void,
  ): () => void;
} = client.interpreterOverlay;
export const agentNotifications = client.agentNotifications;
export const appToasts = client.appToasts;
export const programmaticTasks = isMarketingDemoMode()
  ? marketingDemoProgrammaticTasksIpc
  : client.programmaticTasks;
export const userName = isMarketingDemoMode() ? marketingDemoUserNameIpc : client.userName;
export const whatsNew = client.whatsNew;
export const topNotices = isMarketingDemoMode() ? marketingDemoTopNoticesIpc : client.topNotices;
export const interviewInvite = isMarketingDemoMode() ? marketingDemoInterviewInviteIpc : client.interviewInvite;
export const telemetry = isMarketingDemoMode() ? marketingDemoTelemetryIpc : client.telemetry;
export const globalTools = isMarketingDemoMode() ? marketingDemoGlobalToolsIpc : client.globalTools;
export const nativeTools: NativeToolsIpc = client.nativeTools;
export const auth = client.auth;
export const terminal = client.terminal;
// Codex Server IPC removed - Codex Server profile removed in model system redesign
// export const codex = client.codex;
export const skills = isMarketingDemoMode() ? marketingDemoSkillsIpc : client.skills;
export const skillSettings = client.skillSettings;
export const desktopNotification = isMarketingDemoMode()
  ? marketingDemoDesktopNotificationIpc
  : client.desktopNotification;
export const mcpSettings = client.mcpSettings;
export const userEmail = client.userEmail;
export const onboardingPersona = client.onboardingPersona;
export const onboardingState = client.onboardingState;
export const environmentDetection = client.environmentDetection;
export const newsletter = client.newsletter;

// ============================================================================
// Top-level Methods
// ============================================================================

export interface RuntimeSystemInfo {
  platform: string;
  osRelease: string;
  nativeMacTransparencyEnabled?: boolean;
}

function getBrowserSystemInfo(): RuntimeSystemInfo {
  const userAgent = navigator.userAgent || '';

  let platform = 'unknown';
  if (/Windows/i.test(userAgent)) {
    platform = 'win32';
  } else if (/Macintosh|Mac OS X/i.test(userAgent)) {
    platform = 'darwin';
  } else if (/Linux/i.test(userAgent)) {
    platform = 'linux';
  }

  const windowsVersionMatch = userAgent.match(/Windows NT ([0-9.]+)/i);
  return {
    platform,
    osRelease: windowsVersionMatch?.[1] ?? '',
    nativeMacTransparencyEnabled: platform === 'darwin' ? true : undefined,
  };
}

export function getRuntimeSystemInfo(): RuntimeSystemInfo {
  if (!isElectron) {
    return getBrowserSystemInfo();
  }

  const platform = window.electron?.getPlatform?.();
  const osRelease = window.electron?.getOsRelease?.();
  const nativeMacTransparencyEnabled = window.electron?.isNativeMacTransparencyEnabled?.();
  if (!platform || !osRelease) {
    return getBrowserSystemInfo();
  }

  return { platform, osRelease, nativeMacTransparencyEnabled };
}

export async function getServerPort(): Promise<number> {
  if (!isElectron) return 5177;
  return window.electron.getServerPort();
}

export async function getAppServerOrigin(): Promise<string> {
  if (!isElectron) {
    return '';
  }
  const port = await getServerPort();
  return `http://${ELECTRON_APP_SERVER_HOST}:${port}`;
}

/**
 * Get the full URL for any API path.
 * Handles browser dev mode (relative URL for Vite proxy) vs Electron (absolute URL).
 */
export async function getApiUrl(path: string): Promise<string> {
  if (!isElectron) {
    return path; // Relative URL goes through Vite proxy
  }
  const origin = await getAppServerOrigin();
  return appendWindowSessionKey(`${origin}${path}`);
}

/**
 * Get the full URL for a file API endpoint.
 * In Electron, user-opened files load directly from `file://` so they are not
 * constrained by the workspace-scoped HTTP file route.
 */
export async function getFileUrl(filePath: string, raw = true): Promise<string> {
  if (isMarketingDemoMode()) {
    const demoFileUrl = getMarketingDemoFileUrl(filePath);
    if (demoFileUrl) {
      return demoFileUrl;
    }
  }
  if (isElectron) {
    return filePathToUri(filePath);
  }
  const query = raw ? '?raw=true' : '';
  return getApiUrl(`/api/files/${encodeURIComponent(filePath)}${query}`);
}

export type { FileThumbnailData } from '../shared/types/fileThumbnail';

export async function getFileThumbnails(
  paths: string[],
  size?: number
): Promise<{ thumbnails: Record<string, FileThumbnailData> }> {
  if (isMarketingDemoMode()) {
    return files.getThumbnails(paths, size);
  }

  if (isElectron) {
    return files.getThumbnails(paths, size);
  }

  const response = await apiRequest({
    method: 'POST',
    path: '/api/workspace/thumbnails',
    body: { paths, size },
  });

  if (!response.ok) {
    const errorData = response.data as { error?: string } | undefined;
    throw new Error(errorData?.error || `Request failed with status ${response.status}`);
  }

  return response.data as { thumbnails: Record<string, FileThumbnailData> };
}

export async function getWindowId(): Promise<number> {
  if (!isElectron) return 1;
  return window.electron.getWindowId();
}

export function getWindowSessionKey(): string | null {
  if (!isElectron) {
    return null;
  }
  return window.electron.getWindowSessionKey();
}

export function getWindowBootstrapLayout(): LayoutState | null {
  if (!isElectron) {
    return null;
  }
  return window.electron.getWindowBootstrapLayout();
}

export function appendWindowSessionKey(pathOrUrl: string): string {
  const sessionKey = getWindowSessionKey();
  if (!sessionKey) {
    return pathOrUrl;
  }

  const isAbsoluteHttpUrl = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://');
  const url = new URL(pathOrUrl, isAbsoluteHttpUrl ? undefined : 'http://127.0.0.1');
  url.searchParams.set('windowSessionKey', sessionKey);

  return isAbsoluteHttpUrl
    ? url.toString()
    : `${url.pathname}${url.search}${url.hash}`;
}

export async function apiRequest(request: {
  method: string;
  path: string;
  body?: unknown;
}): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!isElectron) {
    if (isMarketingDemoMode()) {
      return {
        ok: false,
        status: 503,
        data: { error: `[MarketingDemo] ${request.method} ${request.path} is disabled.` },
      };
    }
    try {
      const options: RequestInit = {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (request.body && request.method !== 'GET') {
        options.body = JSON.stringify(request.body);
      }
      const response = await fetch(request.path, options);
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    } catch (err: any) {
      return { ok: false, status: 500, data: { error: err.message } };
    }
  }
  return window.electron.apiRequest(request);
}

export function log(level: string, ...args: unknown[]): void {
  if (!isElectron) {
    const logFn =
      level === 'ERROR'
        ? console.error
        : level === 'WARN'
          ? console.warn
          : console.log;
    logFn(`[${level}]`, ...args);
    return;
  }
  window.electron.log(level, ...args);
}

export async function openExternal(url: string): Promise<void> {
  if (!isElectron) {
    window.open(url, '_blank');
    return;
  }
  return window.electron.openExternal(url);
}

export async function openPath(filePath: string): Promise<{ error: string | null }> {
  if (!isElectron) {
    window.open(filePath, '_blank');
    return { error: null };
  }
  return window.electron.openPath(filePath);
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!isElectron) {
    if (!navigator.clipboard?.writeText) {
      throw new Error('Clipboard write is unavailable');
    }
    await navigator.clipboard.writeText(text);
    return;
  }

  const response = await window.electron.writeClipboardText(text);
  if (!response.success) {
    throw new Error(response.error || 'Failed to write text to clipboard');
  }
}

export async function openFolderDialog(): Promise<{
  canceled: boolean;
  filePaths: string[];
}> {
  if (!isElectron) {
    return browserOpenFolderDialog();
  }
  return window.electron.openFolderDialog();
}

export async function openPathDialog(options?: {
  type?: 'file' | 'folder' | 'both';
  defaultPath?: string;
  title?: string;
}): Promise<{
  canceled: boolean;
  filePaths: string[];
}> {
  if (!isElectron) {
    // Fall back to folder dialog in browser mode
    return browserOpenFolderDialog();
  }
  return window.electron.openPathDialog(options);
}

export async function savePathDialog(options?: {
  defaultPath?: string;
  title?: string;
  buttonLabel?: string;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}): Promise<{
  canceled: boolean;
  filePath?: string;
}> {
  if (!isElectron) {
    throw new Error('Save path dialog is unavailable outside Electron');
  }

  return window.electron.savePathDialog(options);
}

export async function showItemInFolder(path: string): Promise<void> {
  if (!isElectron) {
    await shell.revealInFinder(path);
    return;
  }
  return window.electron.showItemInFolder(path);
}

export async function showItemsInFolder(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  if (!isElectron) {
    await shell.revealInFinder(paths[0]);
    return;
  }

  return window.electron.showItemsInFolder(paths);
}

export function getPathForFile(file: File): string {
  if (!isElectronRuntime()) {
    return '';
  }
  return window.electron.getPathForFile(file) ?? '';
}

export function pathBasename(filePath: string): string {
  if (!filePath) return '';
  if (isElectronRuntime()) {
    return window.electron.pathBasename(filePath);
  }
  const segments = filePath.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return filePath;
}

export function pathDirname(filePath: string): string {
  if (!filePath) return '';
  if (isElectronRuntime()) {
    return window.electron.pathDirname(filePath);
  }
  const segments = filePath.split(/[\\/]/);
  while (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  if (segments.length === 0) return filePath;
  segments.pop();
  if (segments.length === 0) return '';
  return segments.join('/');
}

export function pathSplit(filePath: string): string[] {
  if (!filePath) return [];
  if (isElectronRuntime()) {
    return filePath.split(window.electron.pathSep).filter(Boolean);
  }
  // Browser fallback: handle both separators
  return filePath.split(/[\\/]/).filter(Boolean);
}

export function isAbsolutePath(filePath: string): boolean {
  if (!filePath) return false;
  if (isElectronRuntime()) {
    return window.electron.pathIsAbsolute(filePath);
  }
  // Browser fallback
  if (filePath.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return true;
  return false;
}

export function pathNormalize(filePath: string): string {
  if (!filePath) return '';
  if (isElectronRuntime()) {
    return window.electron.pathNormalize(filePath);
  }
  if (/^[A-Za-z]:[\\/]/.test(filePath)) {
    const drive = filePath.slice(0, 2);
    const rest = filePath.slice(2).replace(/[\\/]+/g, '\\');
    return `${drive}${rest}`;
  }
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    const trimmed = filePath.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '\\');
    return `\\\\${trimmed}`;
  }
  const normalized = filePath.replace(/\/+/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/$/, '');
}

function getPathRoot(input: string): string {
  if (!input) return '';
  if (input.startsWith('\\\\') || input.startsWith('//')) return '\\\\';
  if (input.startsWith('/')) return '/';

  const drive = input.slice(0, 2);
  if (drive.length === 2 && drive[1] === ':') {
    return drive;
  }

  return '';
}

function stripRootSegments(segments: string[], root: string): string[] {
  if (root.length === 2 && root[1] === ':' && segments.length > 0) {
    const first = segments[0];
    if (first.length === 2 && first[1] === ':' && first.toLowerCase() === root.toLowerCase()) {
      return segments.slice(1);
    }
  }
  return segments;
}

function joinNormalizedSegments(root: string, segments: string[]): string {
  const normalized: string[] = [];
  const isAbsoluteRoot = root === '/' || root === '\\\\' || (root.length === 2 && root[1] === ':');

  for (const segment of segments) {
    if (!segment || segment === '.') continue;

    if (segment === '..') {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '..') {
        normalized.pop();
        continue;
      }
      if (!isAbsoluteRoot) {
        normalized.push(segment);
      }
      continue;
    }

    normalized.push(segment);
  }

  if (root === '/') {
    return normalized.length === 0 ? '/' : pathJoin('/', ...normalized);
  }

  if (root === '\\\\') {
    if (normalized.length === 0) return '\\\\';
    return `\\\\${normalized.join('\\')}`;
  }

  if (root.length === 2 && root[1] === ':') {
    if (normalized.length === 0) return `${root}\\`;
    return `${root}\\${normalized.join('\\')}`;
  }

  if (normalized.length === 0) return '';
  return pathJoin(...normalized);
}

export function pathResolve(fromPath: string, toPath: string): string {
  if (isElectronRuntime()) {
    return window.electron.pathResolve(fromPath, toPath);
  }

  if (!fromPath) return pathNormalize(toPath);
  if (!toPath) return pathNormalize(fromPath);

  if (isAbsolutePath(toPath) || toPath.startsWith('\\\\') || toPath.startsWith('//')) {
    return pathNormalize(toPath);
  }

  const root = getPathRoot(fromPath);
  const fromSegments = stripRootSegments(pathSplit(fromPath), root);
  const toSegments = pathSplit(toPath);

  return joinNormalizedSegments(root, [...fromSegments, ...toSegments]);
}

export function pathRelative(fromPath: string, toPath: string): string {
  if (!toPath) return '';
  if (isElectronRuntime()) {
    return window.electron.pathRelative(fromPath, toPath);
  }
  if (!fromPath) {
    return pathNormalize(toPath);
  }

  const normalizedFrom = pathNormalize(fromPath);
  const normalizedTo = pathNormalize(toPath);
  const fromRoot = getPathRoot(normalizedFrom);
  const toRoot = getPathRoot(normalizedTo);
  const rootsMatch = fromRoot.length === 2
    && fromRoot[1] === ':'
    && toRoot.length === 2
    && toRoot[1] === ':'
    ? fromRoot.toLowerCase() === toRoot.toLowerCase()
    : fromRoot === toRoot;

  if (!rootsMatch) {
    return normalizedTo;
  }

  const fromSegments = stripRootSegments(pathSplit(normalizedFrom), fromRoot);
  const toSegments = stripRootSegments(pathSplit(normalizedTo), toRoot);
  let sharedLength = 0;

  while (sharedLength < fromSegments.length && sharedLength < toSegments.length) {
    const fromSegment = fromSegments[sharedLength] ?? '';
    const toSegment = toSegments[sharedLength] ?? '';
    const segmentsMatch = fromRoot === '\\\\' || (fromRoot.length === 2 && fromRoot[1] === ':')
      ? fromSegment.toLowerCase() === toSegment.toLowerCase()
      : fromSegment === toSegment;

    if (!segmentsMatch) {
      break;
    }
    sharedLength += 1;
  }

  const parents = Array.from({ length: fromSegments.length - sharedLength }, () => '..');
  const relativeSegments = [...parents, ...toSegments.slice(sharedLength)];
  if (relativeSegments.length === 0) {
    return '';
  }

  const separator = fromRoot === '\\\\'
    || (fromRoot.length === 2 && fromRoot[1] === ':')
    || normalizedFrom.includes('\\')
    || normalizedTo.includes('\\')
    ? '\\'
    : '/';

  return relativeSegments.join(separator);
}

// NOTE(victor): Windows paths use backslashes; normalize via Node's path.normalize before comparison
export function pathStartsWith(filePath: string, prefix: string): boolean {
  if (isElectronRuntime()) {
    const normalized = window.electron.pathNormalize(filePath);
    const normalizedPrefix = window.electron.pathNormalize(prefix);
    return normalized.startsWith(normalizedPrefix + window.electron.pathSep);
  }
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedPrefix = prefix.replace(/\\/g, '/');
  return normalized.startsWith(normalizedPrefix + '/');
}

export function pathStripPrefix(filePath: string, prefix: string): string {
  if (isElectronRuntime()) {
    const normalized = window.electron.pathNormalize(filePath);
    const normalizedPrefix = window.electron.pathNormalize(prefix);
    return normalized.slice(normalizedPrefix.length + 1);
  }
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedPrefix = prefix.replace(/\\/g, '/');
  return normalized.slice(normalizedPrefix.length + 1);
}

// NOTE(victor): Checks if two paths refer to the same file, handling absolute
// vs relative paths (one may be a suffix of the other).
export function pathsMatch(a: string, b: string): boolean {
  if (isElectronRuntime()) {
    const na = window.electron.pathNormalize(a);
    const nb = window.electron.pathNormalize(b);
    const sep = window.electron.pathSep;
    return na === nb || na.endsWith(sep + nb) || nb.endsWith(sep + na);
  }
  const na = a.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const nb = b.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

function encodeFileUriPath(filePath: string): string {
  return encodeURI(filePath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

export function filePathToUri(filePath: string): string {
  if (!filePath) return 'file://';
  if (isElectronRuntime()) {
    return window.electron.pathToFileURL(filePath);
  }

  const normalized = pathNormalize(filePath);
  if (normalized.startsWith('\\\\')) {
    const trimmed = normalized.slice(2).replace(/\\/g, '/');
    return `file://${encodeFileUriPath(trimmed)}`;
  }

  const slashPath = normalized.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(slashPath)) {
    return `file:///${encodeFileUriPath(slashPath)}`;
  }
  return `file://${encodeFileUriPath(slashPath)}`;
}

export function pathJoin(...segments: string[]): string {
  if (isElectronRuntime()) {
    return window.electron.pathJoin(...segments);
  }
  // Browser fallback: simple join with forward slashes
  return segments
    .filter(s => s)
    .join('/')
    .replace(/\/+/g, '/');
}

/**
 * Show a generic context menu with the given items.
 * Returns the action string of the clicked item, or null if dismissed.
 * Works in both Electron (native menu) and browser (shadcn menu) modes.
 *
 * `menu` is an optional telemetry label used to distinguish call sites
 * (e.g. "file_tree", "chat_message", "thread_list"). It is not rendered.
 */
export async function showContextMenu(
  items: ContextMenuItem[],
  menu?: string,
): Promise<string | null> {
  // In test mode, use browser-style HTML menu (which Playwright can interact with)
  // instead of native Electron menu (which Playwright cannot)
  const useHtmlMenu = !isElectron || (window as any).__TEST_USE_HTML_CONTEXT_MENU;

  const action = useHtmlMenu
    ? await browserShowContextMenu(items)
    : (await window.electron.showContextMenu({ items })).action;

  if (action) {
    // Import lazily to avoid a cycle (telemetry imports from @/ipc).
    import('./utils/telemetry')
      .then(({ trackContextMenuAction }) =>
        trackContextMenuAction({ menu: menu ?? 'unknown', action }),
      )
      .catch(() => {});
  }

  return action;
}

/**
 * Show a native select dropdown at the specified position.
 * Returns the selected value, or null if dismissed.
 * Works in both Electron (native menu) and browser (custom dropdown) modes.
 */
export async function showSelect(
  items: SelectItem[],
  currentValue: string | undefined,
  x: number,
  y: number
): Promise<string | null> {
  if (!isElectron) {
    return browserShowSelect(items, currentValue, x, y);
  }
  const result = await window.electron.showSelect({ items, currentValue, x, y });
  return result.value;
}

export function macTitlebarClicked(): void {
  if (!isElectron) return;
  window.electron.macTitlebarClicked();
}

export function signalRendererReady(): void {
  if (!isElectron) return;
  window.electron.rendererReady();
}

export async function shutdown(): Promise<{ success: boolean }> {
  if (!isElectron) {
    return { success: true };
  }
  return window.electron.shutdown();
}
