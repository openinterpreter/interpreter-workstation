/**
 * IPC Registry
 *
 * Centralized registry of all IPC channels and their type definitions.
 * This ensures type safety across main/renderer processes and serves as documentation.
 *
 * ## Architecture
 *
 * This file is the single source of truth for all IPC communication in the application.
 * It defines:
 * - Channel names as constants (prevents typos)
 * - Request/response type interfaces (ensures type safety)
 * - Event payload types (documents event structure)
 *
 * ## Usage
 *
 * **Main Process (electron/main.ts):**
 * - Import setupIpcHandlers from electron/ipc/handlers.ts
 * - Call it once during app initialization
 *
 * **Renderer Process (React components):**
 * - Use window.electron API (defined in electron/preload.ts)
 * - All methods are typed using interfaces from this file
 *
 * **Server Process (Express routes):**
 * - Import emitters from electron/ipc/events.ts
 * - Or use server/utils/ipcBridge.ts for server-side code
 *
 * ## Event-Driven Design
 *
 * This system is designed to be event-driven, NOT polling-based:
 * - Use onXxx listeners for real-time updates
 * - Emit events when state changes (created, resolved, list-changed, etc.)
 * - Never use setInterval to poll for changes
 *
 * ## Adding New IPC Channels
 *
 * 1. Add channel name constant to IPC_CHANNELS
 * 2. Define request/response types below
 * 3. Add handler in electron/ipc/handlers.ts
 * 4. Add preload wrapper in electron/preload.ts
 * 5. Use in components via window.electron
 */

import type { FileThumbnailData } from '../../shared/types/fileThumbnail';
import type { BrowserAccessPolicy } from '../../shared/browserAccessPolicy';
import type { OnboardingInterviewAnswers } from '../../shared/types/onboardingState';

// ============================================================================
// IPC Channel Names
// ============================================================================

export const IPC_CHANNELS = {
  // General
  GET_SERVER_PORT: 'get-server-port',
  GET_WINDOW_ID: 'get-window-id',
  API_REQUEST: 'api-request',
  SHUTDOWN: 'shutdown',
  RENDERER_LOG: 'renderer-log',
  OPEN_FOLDER_DIALOG: 'open-folder-dialog',
  OPEN_PATH_DIALOG: 'open-path-dialog',
  SAVE_PATH_DIALOG: 'save-path-dialog',
  OPEN_EXTERNAL: 'open-external',
  OPEN_PATH: 'open-path',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  SHOW_ITEM_IN_FOLDER: 'show-item-in-folder',
  SHOW_ITEMS_IN_FOLDER: 'show-items-in-folder',
  SHOW_CONTEXT_MENU: 'show-context-menu',
  SHOW_SELECT: 'show-select',
  DESKTOP_SOURCES_LIST: 'desktop-sources:list',
  RUNTIME_RESTARTING: 'runtime:restarting',
  RUNTIME_RESTARTED: 'runtime:restarted',

  // Approvals (event channels use plural 'approvals:' for browser proxy: approvals.onCreated)
  APPROVAL_GET: 'approval:get',
  APPROVAL_APPROVE: 'approval:approve',
  APPROVAL_DENY: 'approval:deny',
  APPROVAL_RESPOND: 'approval:respond',
  APPROVAL_CREATED: 'approvals:created',
  APPROVAL_RESOLVED: 'approvals:resolved',
  APPROVAL_TIMEOUT: 'approvals:timeout',
  APPROVAL_LIST_CHANGED: 'approvals:list-changed',

  // Agent Tabs
  AGENT_TAB_CREATE_REQUESTED: 'agent-tab:create-requested',
  AGENT_TAB_SEND_REQUESTED: 'agent-tab:send-requested',
  AGENT_TAB_STOP_REQUESTED: 'agent-tab:stop-requested',
  AGENT_TAB_CREATED: 'agent-tab:created',
  AGENT_TAB_COMPLETED: 'agent-tab:completed',
  AGENT_TAB_GET_PENDING: 'agent-tab:get-pending',
  AGENT_TAB_REGISTER_THREAD: 'agent-tab:register-thread',
  AGENT_TAB_REPORT_ACTIVITY: 'agent-tab:report-activity',
  AGENT_TAB_CONSUME_STARTUP: 'agent-tab:consume-startup',
  AGENT_TAB_DISPOSE_BINDING: 'agent-tab:dispose-binding',

  // Agent thread history
  AGENT_THREADS_DELETE: 'agentThreads:delete',
  AGENT_THREADS_DELETE_ALL: 'agentThreads:delete-all',
  AGENT_THREADS_RENAME: 'agentThreads:rename',
  AGENT_THREADS_ARCHIVE: 'agentThreads:archive',
  AGENT_THREADS_UNARCHIVE: 'agentThreads:unarchive',

  // Profiles (camelCase namespace for browser proxy: profiles.onDefaultChanged)
  PROFILES_LIST: 'profiles:list',
  PROFILES_GET: 'profiles:get',
  PROFILES_CREATE: 'profiles:create',
  PROFILES_UPDATE: 'profiles:update',
  PROFILES_DELETE: 'profiles:delete',
  PROFILES_SET_DEFAULT: 'profiles:set-default',
  PROFILES_SET_FAST: 'profiles:set-fast',
  PROFILES_RESET: 'profiles:reset',
  PROFILES_CHANGED: 'profiles:changed',
  PROFILES_DEFAULT_CHANGED: 'profiles:default-changed',
  PROFILES_CONFIG_RECOVERED: 'profiles:config-recovered',

  // Workspace
  WORKSPACE_CHANGED: 'workspace:changed',
  WORKSPACE_FILES_CHANGED: 'workspace:files-changed',
  WORKSPACE_CONFIRMATION_REQUESTED: 'workspace:confirmation-requested',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_CREATE_SAMPLE: 'workspace:create-sample',
  WORKSPACE_SET: 'workspace:set',
  WORKSPACE_CONFIRMATION_RESPOND: 'workspace:confirmation-respond',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_ADD_WATCH: 'workspace:add-watch',
  WORKSPACE_REMOVE_WATCH: 'workspace:remove-watch',
  GET_INITIAL_FILE_TREE: 'get-initial-file-tree',

  // Tool Server Setup
  SETUP_COMPLETED: 'setup:completed',
  TOOL_SERVERS_GET_SNAPSHOT: 'toolServers:get-snapshot',
  COMPUTER_USE_SETUP_REQUESTED: 'computer-use-setup:requested',
  COMPUTER_USE_SETUP_STATUS_REQUESTED: 'computer-use-setup:status-requested',

  // Overlay Settings
  OVERLAY_SETTINGS_GET: 'overlaySettings:get',
  OVERLAY_SETTINGS_SET: 'overlaySettings:set',
  OVERLAY_SETTINGS_GET_ACCESS_STATE: 'overlaySettings:get-access-state',
  OVERLAY_SETTINGS_GET_PERMISSION_STATUS: 'overlaySettings:get-permission-status',
  OVERLAY_SETTINGS_REQUEST_ACCESSIBILITY_PERMISSION: 'overlaySettings:request-accessibility-permission',
  OVERLAY_SETTINGS_REQUEST_SCREEN_RECORDING_PERMISSION: 'overlaySettings:request-screen-recording-permission',
  OVERLAY_SETTINGS_OPEN_ACCESSIBILITY_SETTINGS: 'overlaySettings:open-accessibility-settings',
  OVERLAY_SETTINGS_OPEN_SCREEN_RECORDING_SETTINGS: 'overlaySettings:open-screen-recording-settings',
  INTERPRETER_OVERLAY_START_WINDOW_VOICE: 'interpreterOverlay:start-window-voice',
  INTERPRETER_OVERLAY_ONBOARDING_VOICE_INTERVIEW_COMPLETED: 'interpreterOverlay:onboarding-voice-interview-completed',

  // Window/Title Bar
  MAC_TITLEBAR_CLICKED: 'mac-titlebar-clicked',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreen-changed',
  WINDOW_CREATE: 'window:create',
  WINDOW_DETACH_TAB: 'window:detach-tab',
  WINDOW_TRANSFER_TAB_OUT: 'window:transfer-tab-out',

  // Tab Navigation (menu shortcuts) - plural 'tabs:' for browser proxy: tabs.onClose()
  TAB_CLOSE: 'tabs:close',
  TAB_NEW: 'tabs:new',
  TAB_NEXT: 'tabs:next',
  TAB_PREVIOUS: 'tabs:previous',
  TAB_GO_TO: 'tabs:go-to',

  // Quick Actions
  QUICK_OPEN: 'quick-open',
  TOGGLE_EXPLORER: 'toggle-explorer',
  FOCUS_AGENT: 'focus-agent',
  NEW_SIDEBAR_AGENT: 'new-sidebar-agent',
  OPEN_INBOX: 'open-inbox',
  OPEN_SETTINGS: 'open-settings',

  // PDF
  PDF_UPDATE_FORM_DATA: 'pdf:update-form-data',
  PDF_FILL_FIELD: 'pdf:fill-field',
  PDF_READ_STRUCTURE: 'pdf:read-structure',

  // Markdown
  MARKDOWN_FORMAT: 'markdown:format',

  // File Refresh (namespace matches 'files' object in preload for browser proxy compatibility)
  FILE_REFRESHED: 'files:refreshed',

  // Checkpoints (kebab-case for browser proxy compatibility)
  CHECKPOINT_GET: 'checkpoint:get',
  CHECKPOINT_RESTORE: 'checkpoint:restore',
  CHECKPOINT_SETTINGS_GET: 'checkpoint:settings-get',
  CHECKPOINT_SETTINGS_SET: 'checkpoint:settings-set',
  CHECKPOINT_SETTINGS_CHANGED: 'checkpoint:settings-changed',
  CHECKPOINT_STATUS_CHANGED: 'checkpoint:status-changed',

  // File Operations
  FILES_START_DRAG: 'files:start-drag',
  FILES_DOWNLOAD_URL: 'files:download-url',
  FILES_SAVE_CLIPBOARD_IMAGE: 'files:save-clipboard-image',
  FILES_MOVE: 'files:move',
  FILES_RENAME: 'files:rename',
  FILES_DELETE: 'files:delete',
  FILES_TRASH: 'files:trash',
  FILES_DUPLICATE: 'files:duplicate',
  FILES_COPY_PATH: 'files:copy-path',
  FILES_READ: 'files:read',
  FILES_READ_BINARY: 'files:read-binary',
  FILES_WRITE: 'files:write',
  FILES_WRITE_BINARY: 'files:write-binary',
  FILES_GET_THUMBNAILS: 'files:get-thumbnails',
  FILES_CREATE: 'files:create',
  FILES_CREATE_FOLDER: 'files:create-folder',
  FILES_CREATE_BOOKMARK: 'files:create-bookmark',
  FILES_COPY_EXTERNAL: 'files:copy-external',
  FILES_IS_DIRECTORY: 'files:is-directory',
  FILES_GET_STATS: 'files:get-stats',
  FILES_LIST_DIRECTORY: 'files:list-directory',

  // Project Runner
  PROJECT_RUNNER_START: 'projectRunner:start',
  PROJECT_RUNNER_STOP: 'projectRunner:stop',
  PROJECT_RUNNER_GET_STATUS: 'projectRunner:get-status',
  PROJECT_RUNNER_CHANGED: 'projectRunner:changed',

  // Shell Operations
  SHELL_REVEAL_IN_FINDER: 'shell:reveal-in-finder',
  SHELL_COPY_FILE: 'shell:copy-file',
  SHELL_CUT_FILE: 'shell:cut-file',

  // Conversations
  CONVERSATION_SAVE: 'conversation:save',
  CONVERSATION_LOAD: 'conversation:load',
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_LIST_WITH_PREVIEWS: 'conversation:listWithPreviews',
  CONVERSATION_DELETE: 'conversation:delete',

  // OfficeExtension
  OFFICE_EXTENSION_CONVERT: 'office-extension:convert',
  OFFICE_EXTENSION_DOWNLOAD: 'office-extension:download',
  OFFICE_EXTENSION_STATUS: 'office-extension:status',
  OFFICE_EXTENSION_ENSURE_RUNNING: 'office-extension:ensure-running',
  OFFICE_EXTENSION_CHECK_INSTALLED: 'office-extension:check-installed',
  OFFICE_EXTENSION_INSTALL: 'office-extension:install',
  OFFICE_EXTENSION_INSTALL_PROGRESS: 'office-extension:install-progress',
  OFFICE_EXTENSION_UNINSTALL: 'office-extension:uninstall',

  // VoiceExtension
  VOICE_EXTENSION_CHECK_INSTALLED: 'voice-extension:check-installed',
  VOICE_EXTENSION_INSTALL: 'voice-extension:install',
  VOICE_EXTENSION_INSTALL_PROGRESS: 'voice-extension:install-progress',

  // Text-to-Speech
  TTS_GET_SETTINGS: 'tts:get-settings',
  TTS_SET_SETTINGS: 'tts:set-settings',
  TTS_LIST_MODELS: 'tts:list-models',
  TTS_INSTALL_MODEL: 'tts:install-model',
  TTS_GET_VOICES: 'tts:get-voices',
  TTS_SPEAK: 'tts:speak',
  TTS_SETTINGS_CHANGED: 'tts:settings-changed',
  TTS_INSTALL_PROGRESS: 'tts:install-progress',
  TTS_PLAYBACK_REQUESTED: 'tts:playback-requested',

  // Speech-to-Text
  STT_GET_SETTINGS: 'stt:get-settings',
  STT_SET_SETTINGS: 'stt:set-settings',
  STT_SETTINGS_CHANGED: 'stt:settings-changed',

  // Workstation control channels (one-way, main -> renderer)
  WORKSTATION_OPEN_FILE: 'workstation:open-file',
  WORKSTATION_OPEN_URL: 'workstation:open-url',
  WORKSTATION_CLOSE_TAB: 'workstation:close-tab',
  WORKSTATION_FOCUS_TAB: 'workstation:focus-tab',
  WORKSTATION_TOGGLE_SIDEBAR: 'workstation:toggle-sidebar',

  // Renderer lifecycle (renderer -> main, one-way)
  RENDERER_READY: 'renderer:ready',

  // App Update (main -> renderer events + renderer -> main actions)
  APP_UPDATE_READY: 'appUpdate:ready',
  APP_UPDATE_CHECKING: 'appUpdate:checking',
  APP_UPDATE_UP_TO_DATE: 'appUpdate:up-to-date',
  APP_UPDATE_ERROR: 'appUpdate:error',
  APP_UPDATE_INSTALL: 'appUpdate:install',
  APP_UPDATE_CHECK_NOW: 'appUpdate:check-now',

  // App toasts
  APP_TOAST_SHOW: 'appToasts:show',

  // Browser
  BROWSER_CREATE: 'browser:create',
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_GO_BACK: 'browser:go-back',
  BROWSER_GO_FORWARD: 'browser:go-forward',
  BROWSER_RELOAD: 'browser:reload',
  BROWSER_STOP: 'browser:stop',
  BROWSER_CLOSE: 'browser:close',
  BROWSER_GET_STATE: 'browser:get-state',
  BROWSER_ATTACH: 'browser:attach',
  BROWSER_DETACH: 'browser:detach',
  BROWSER_SET_BOUNDS: 'browser:set-bounds',
  BROWSER_FOCUS: 'browser:focus',
  BROWSER_EVENT: 'browser:event',
  BROWSER_GET_PERSISTED_TABS: 'browser:get-persisted-tabs',
  BROWSER_TAB_CREATED: 'browser:tab-created',
  BROWSER_TAB_CLOSED: 'browser:tab-closed',
  BROWSER_CONTROL_GET_STATUS: 'browser-control:get-status',
  BROWSER_CONTROL_GET_POLICY: 'browser-control:get-policy',
  BROWSER_CONTROL_SET_POLICY: 'browser-control:set-policy',
  BROWSER_CONTROL_ARRANGE_SPLIT: 'browser-control:arrange-split',
  BROWSER_CONTROL_ACTIVATE_TAB: 'browser-control:activate-tab',
  BROWSER_CONTROL_CHANGED: 'browserControl:changed',

  // Movie editor
  MOVIE_COMPILE_COMPONENTS: 'movie:compile-components',
  MOVIE_EXPORT: 'movie:export',
  MOVIE_EXPORT_CANCEL: 'movie:export-cancel',
  MOVIE_EXPORT_PROGRESS: 'movie:export-progress',

  // Background Opacity (camelCase namespace for browser proxy: backgroundOpacity.onChanged)
  BACKGROUND_OPACITY_GET: 'background-opacity:get',
  BACKGROUND_OPACITY_SET: 'background-opacity:set',
  BACKGROUND_OPACITY_CHANGED: 'backgroundOpacity:changed',

  // Zoom Factor (camelCase namespace for browser proxy: zoomFactor.get/set/onChanged)
  ZOOM_FACTOR_GET: 'zoom-factor:get',
  ZOOM_FACTOR_SET: 'zoom-factor:set',
  ZOOM_FACTOR_CHANGED: 'zoomFactor:changed',

  // Locale
  LOCALE_GET: 'locale:get',
  LOCALE_SET: 'locale:set',
  LOCALE_CHANGED: 'locale:changed',

  // Theme
  THEME_GET: 'theme:get',
  THEME_SET: 'theme:set',
  THEME_CHANGED: 'theme:changed',

  // Primary Color (camelCase namespace for browser proxy: primaryColor.onChanged)
  PRIMARY_COLOR_GET: 'primary-color:get',
  PRIMARY_COLOR_SET: 'primary-color:set',
  PRIMARY_COLOR_CHANGED: 'primaryColor:changed',

  // UI Settings - boolean setting channels are generated by shared/booleanSettings.ts

  // Test Logging (for E2E tests - redirects backend logs to per-test files)
  TEST_LOG_START: 'test-log:start',
  TEST_LOG_END: 'test-log:end',

  // Servers namespace (tool server CRUD + tool execution)
  SERVERS_LIST: 'servers:list',
  SERVERS_GET: 'servers:get',
  SERVERS_ADD: 'servers:add',
  SERVERS_START_OAUTH: 'servers:start-oauth',
  SERVERS_UPDATE: 'servers:update',
  SERVERS_DELETE: 'servers:delete',
  SERVERS_TOGGLE: 'servers:toggle',
  SERVERS_CALL_TOOL: 'servers:call-tool',

  // Tool Servers (camelCase namespace for browser proxy: toolServers.onChanged)
  TOOL_SERVERS_CHANGED: 'toolServers:changed',

  // Subagent Tool Events (camelCase namespace for browser proxy: subagentTools.onToolCall)
  SUBAGENT_TOOL_CALL: 'subagentTools:tool-call',

  // Agent Notifications (camelCase namespace for browser proxy: agentNotifications.onNotification)
  AGENT_NOTIFICATION: 'agentNotifications:notification',

  // Programmatic Agent Tasks (camelCase namespace for browser proxy: programmaticTasks.startHeaded / onStarted)
  PROGRAMMATIC_TASK_START_HEADED: 'programmaticTasks:start-headed',
  PROGRAMMATIC_TASK_STARTED: 'programmaticTasks:started',

  // Feedback
  FEEDBACK_SUBMIT: 'feedback:submit',

  // Global Tools (camelCase namespace for browser proxy: globalTools.onChanged)
  GLOBAL_TOOLS_LIST: 'global-tools:list',
  GLOBAL_TOOLS_GET: 'global-tools:get',
  GLOBAL_TOOLS_SET: 'global-tools:set',
  GLOBAL_TOOLS_CHANGED: 'globalTools:changed',

  AUTH_DEEP_LINK: 'auth:deep-link',

  // Terminal (camelCase namespace for browser proxy: terminal.onData)
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_CLOSE: 'terminal:close',
  TERMINAL_DATA: 'terminal:data',   // Event: server -> client (PTY output)
  TERMINAL_EXIT: 'terminal:exit',   // Event: server -> client (PTY exited)

  // Codex Server (camelCase namespace for browser proxy: codex.onEvent)
  CODEX_REQUEST: 'codex:request',
  CODEX_SAVE_THREAD: 'codex:save-thread',
  CODEX_LOAD_THREAD: 'codex:load-thread',
  CODEX_EVENT: 'codex:event',
  CODEX_LIST_THREADS: 'codex:list-threads',

  // Skills
  SKILLS_LIST: 'skills:list',
  SKILLS_DELETE: 'skills:delete',
  SKILLS_REVEAL: 'skills:reveal',
  SKILLS_CHANGED: 'skills:changed',

  // Desktop Notifications (camelCase namespace for browser proxy: desktopNotification.onClicked)
  DESKTOP_NOTIFICATION_SHOW: 'desktop-notification:show',
  DESKTOP_NOTIFICATION_CLICKED: 'desktopNotification:clicked',

  // User Email (onboarding Stay Connected screen)
  USER_EMAIL_GET: 'user-email:get',
  USER_EMAIL_SET: 'user-email:set',

  // Onboarding Persona (derived from environment detection)
  ONBOARDING_PERSONA_GET: 'onboarding-persona:get',
  ONBOARDING_PERSONA_SET: 'onboarding-persona:set',

  // Onboarding Permissions
  ONBOARDING_PERMISSIONS_GET: 'onboarding-permissions:get',
  ONBOARDING_PERMISSIONS_SET: 'onboarding-permissions:set',

  // Environment Detection
  ENVIRONMENT_DETECTION_DETECT: 'environment-detection:detect',

  // Newsletter
  NEWSLETTER_SUBSCRIBE: 'newsletter:subscribe',
} as const;

// ============================================================================
// Request/Response Type Definitions
// ============================================================================

// General

export interface ApiRequestParams {
  method: string;
  path: string;
  body?: any;
}

export interface ApiRequestResponse {
  ok: boolean;
  status: number;
  data: any;
}

export interface ShutdownResponse {
  success: boolean;
}

export interface OpenFolderDialogResponse {
  canceled: boolean;
  filePaths: string[];
}

export interface OpenPathDialogOptions {
  type?: 'file' | 'folder' | 'both';
  defaultPath?: string;
  title?: string;
}

export interface OpenPathDialogResponse {
  canceled: boolean;
  filePaths: string[];
}

export interface SavePathDialogOptions {
  defaultPath?: string;
  title?: string;
  buttonLabel?: string;
  filters?: Array<{
    name: string;
    extensions: string[];
  }>;
}

export interface SavePathDialogResponse {
  canceled: boolean;
  filePath?: string;
}

export interface OpenPathResponse {
  error: string | null;
}

export interface ClipboardWriteTextRequest {
  text: string;
}

export interface ClipboardWriteTextResponse {
  success: boolean;
  error?: string;
}

export interface ShowItemsInFolderRequest {
  paths: string[];
}

export interface DesktopSourceListRequest {
  types?: Array<'screen'>;
  thumbnailSize?: {
    width: number;
    height: number;
  };
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

// Generic Context Menu

export interface GenericContextMenuItem {
  label: string;
  action: string;           // Returned when item is clicked
  accelerator?: string;     // e.g., 'CmdOrCtrl+B'
  disabled?: boolean;
  separator?: boolean;      // If true, renders as separator (ignores other props)
  submenu?: GenericContextMenuItem[]; // Optional nested submenu items
}

export interface GenericContextMenuRequest {
  items: GenericContextMenuItem[];
  x?: number;               // Optional position (browser mode)
  y?: number;
}

export interface GenericContextMenuResponse {
  action: string | null;    // null if menu was dismissed
}

// Native Select (dropdown)

export interface SelectItem {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectRequest {
  items: SelectItem[];
  currentValue?: string;    // Currently selected value (for checkmark)
  x: number;                // Position relative to window
  y: number;
}

export interface SelectResponse {
  value: string | null;     // null if menu was dismissed
}

// Approvals
// Types are now primarily defined in shared/types/approval.ts
// These are re-exported here for IPC compatibility

import type {
  QuestionRequest,
  QuestionResult,
  QuestionResponse,
} from '../../shared/types/approval';
import type {
  TtsModelId,
  TtsModelSize,
  TtsProvider,
  TtsSettings,
} from '../../shared/types/tts';
import type { SttBackend, SttSettings } from '../../shared/types/stt';

export interface ApprovalGetRequest {
  toolCallId?: string;
}

export interface ApprovalGetResponse {
  approvals: QuestionRequest[];
}

export interface ApprovalActionRequest {
  id: string;
}

export interface ApprovalActionResponse {
  success: boolean;
  error?: string;
}

export interface ApprovalRespondRequest {
  id: string;
  result: QuestionResult;
}

export interface ApprovalRespondResponse {
  success: boolean;
  error?: string;
}

/** @deprecated Use QuestionRequest from shared/types/approval.ts */
export interface ApprovalData {
  id: string;
  toolName: string;
  serverId: string;
  args: any;
  timestamp: number;
  toolCallId?: string;
}

export interface ApprovalCreatedEvent {
  approval: QuestionRequest;
}

export interface ApprovalResolvedEvent {
  id: string;
  /** Present for simple approvals (backwards compat) */
  approved?: boolean;
  /** Present for all responses */
  answers?: QuestionResponse;
  /** User clicked Skip */
  skipped?: boolean;
  /** Timer auto-selected defaults */
  timedOut?: boolean;
}

export interface ApprovalTimeoutEvent {
  id: string;
}

export interface ApprovalListChangedEvent {
  count: number;
  approvals: QuestionRequest[];
}

export interface RuntimeRestartedEvent {
  restartedAt: number;
  stoppedAgentCount?: number;
}

export interface RuntimeRestartingEvent {
  requestedAt: number;
  runningAgentCount: number;
}

// Re-export for convenience
export type { QuestionRequest, QuestionResult, QuestionResponse } from '../../shared/types/approval';

// Agent Tabs

export interface AgentTabCreateRequestedEvent {
  requestId: string;
  agentId: string;
  callerToken: string;
  startupId?: string;
  initialMessage?: string;
  systemPrompt?: string;
  timeout: number;
  threadId?: string;
  workspacePath?: string;
  targetWindowSessionKey?: string;
  allowedToolNames?: string[];
  toolProfileId?: string;
  modelConfig?: import('../../shared/types/model').AgentModelConfig;
  activate?: boolean;
  completionDisposition?: 'keep_open' | 'close_tab';
  channel?: MessagingChannel;
  channelLabel?: string;
  channelThreadId?: string;
}

export interface AgentTabCreatedRequest {
  requestId: string;
  agentId: string;
}

export interface AgentTabSendRequestedEvent {
  agentId: string;
  threadId?: string;
  message: string;
  workspacePath?: string | null;
  messageSource?: import('../../shared/types/messageSendSource').MessageSendSource | null;
}

export interface AgentTabStopRequestedEvent {
  agentId: string;
  threadId?: string;
}

export interface AgentTabCreatedResponse {
  success: boolean;
  error?: string;
}

export interface AgentTabCompletedRequest {
  requestId: string;
  threadId?: string;
  messages: any[];
  error?: string;
}

export interface AgentTabCompletedResponse {
  success: boolean;
  error?: string;
}

export interface AgentTabGetPendingResponse {
  requests: PendingAgentTabRequest[];
}

export interface AgentTabRegisterThreadRequest {
  agentId: string;
  threadId: string;
  callerToken: string;
  workspacePath?: string;
  allowedToolNames?: string[];
  modelConfig?: import('../../shared/types/model').AgentModelConfig;
  toolProfileId?: string;
}

export interface AgentTabRegisterThreadResponse {
  success: boolean;
  error?: string;
}

export interface AgentTabReportActivityRequest {
  agentId: string;
  activity: Partial<import('../../shared/utils/agentAttention').AgentActivityState>;
}

export interface AgentTabReportActivityResponse {
  success: boolean;
  error?: string;
}

export interface AgentTabDisposeBindingRequest {
  callerToken: string;
}

export interface AgentTabDisposeBindingResponse {
  success: boolean;
  error?: string;
}

export interface AgentTabConsumeStartupRequest {
  agentId: string;
  startupId: string;
}

export interface AgentTabConsumeStartupResponse {
  success: boolean;
  startup: {
    startupId: string;
    initialMessage?: string;
    attachments?: import('../../src/lib/codex/api-types').StreamImageAttachment[];
    completionDisposition: 'keep_open' | 'close_tab';
  } | null;
  error?: string;
}

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
  timeout: number;
  createdAt: number;
  threadId?: string;
  modelConfig?: import('../../shared/types/model').AgentModelConfig;
  activate?: boolean;
  startupAttachments?: import('../../src/lib/codex/api-types').StreamImageAttachment[];
  completionDisposition: 'keep_open' | 'close_tab';
}

// Agent thread history

export interface AgentThreadsDeleteResponse {
  success: boolean;
  error?: string;
}

export interface AgentThreadsDeleteAllResponse {
  success: boolean;
  trashedCount?: number;
  error?: string;
}

export interface AgentThreadsRenameResponse {
  success: boolean;
  name?: string;
  error?: string;
}

export interface AgentThreadsArchiveResponse {
  success: boolean;
  error?: string;
}

export interface AgentThreadsUnarchiveResponse {
  success: boolean;
  error?: string;
}

// Profiles

export interface ProfilesDefaultChangedEvent {
  defaultProfileId: string | null;
  fastProfileId: string | null;
}

export interface ProfilesChangedEvent {
  defaultProfileId: string | null;
  fastProfileId: string | null;
  profileId: string | null;
}

export interface ProfilesConfigRecoveredEvent {
  filePath: string;
  backupPath: string | null;
  issues: string[];
}

// Workspace

export interface WorkspaceChangedEvent {
  workspacePath: string | null;
}

export interface WorkspaceConfirmationRequestedEvent {
  requestId: string;
  workspacePath: string;
  title: string;
  message: string;
  permissionNote: string;
  backupNote: string;
  confirmLabel: string;
  cancelLabel: string;
  variant?: 'confirm' | 'notice';
  detailItemsLabel?: string;
  detailItems?: string[];
}

export interface WorkspaceConfirmationRespondRequest {
  requestId: string;
  approved: boolean;
}

export interface WorkspaceConfirmationRespondResponse {
  success: boolean;
}

export interface WorkspaceCreateSampleResponse {
  success: boolean;
  workspacePath?: string;
  error?: string;
}

export interface WorkspaceFilesChangedEvent {
  eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change';
  path?: string; // Path of the specific file/directory that changed (relative to workspace)
  mtime?: number; // Modified time (for change events)
}

export interface CachedFileTree {
  workspacePath: string;
  files: any[];
  timestamp: number;
}

export interface WindowCreateRequest {
  workspacePath?: string | null;
  background?: boolean;
}

export interface WindowCreateResponse {
  success: boolean;
  windowId?: number;
  sessionKey?: string;
  error?: string;
}

export interface WindowDetachTabRequest {
  tab: import('../../shared/types/layout').Tab;
  workspacePath: string | null;
}

export interface WindowDetachTabResponse {
  success: boolean;
  windowId?: number;
  sessionKey?: string;
  error?: string;
}

export interface WindowTransferTabOutRequest {
  sourceSessionKey: string;
  tabId: string;
}

export interface WindowTransferTabOutResponse {
  success: boolean;
  error?: string;
}

// Tool Server Setup

export interface SetupCompletedEvent {
  serverId: string;
  configured: boolean;
  email?: string;
  error?: string;
}

export interface ComputerUseSetupRequestedEvent {
  reason: 'desktop-tool';
}

export interface ComputerUseSetupStatusRequestedEvent {
  requestId: string;
}

// PDF

export interface PdfUpdateFormDataRequest {
  filePath: string;
  formData: {
    fields: Array<{
      name: string;
      type: string;
      value: any;
    }>;
  };
}

export interface PdfUpdateFormDataResponse {
  success: boolean;
  error?: string;
}

export interface PdfFillFieldEvent {
  filePath: string;
  identifier: string | number;
  value: any;
}

export interface PdfReadStructureRequest {
  filePath: string;
  page?: number;
}

// Re-export the canonical types from the shared utility
export type { PdfStructure, PdfElement, PageInfo, BoundingBox } from '../../server/utils/pdfStructure';

// File Refresh

export interface FileRefreshedEvent {
  filePath: string;
}

// Checkpoints

export interface CheckpointFileEntry {
  path: string;
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface CheckpointGetRequest {
  messageId: string;
}

export interface CheckpointGetResponse {
  success: boolean;
  checkpoint?: {
    messageId: string;
    files: CheckpointFileEntry[];
    timestamp: string;
    hasBefore: boolean;
    hasAfter: boolean;
  };
  error?: string;
}

export interface CheckpointRestoreRequest {
  messageId: string;
  type: 'before' | 'after';
  paths?: string[];
}

export interface CheckpointRestoreResponse {
  success: boolean;
  restored: string[];
  error?: string;
}

export interface CheckpointStatusEvent {
  messageId: string;
  type: 'before' | 'after';
  state: 'saving' | 'saved' | 'error';
  checkpoint?: {
    messageId: string;
    files: CheckpointFileEntry[];
    timestamp: string;
    hasBefore: boolean;
    hasAfter: boolean;
  };
  error?: string;
}

// Checkpoint Settings

export interface CheckpointSettings {
  enabled: boolean;
  retentionDays: number;
  requireApprovalForLargeFiles: boolean;
}

export interface CheckpointSettingsGetResponse {
  settings: CheckpointSettings;
}

export interface CheckpointSettingsSetRequest {
  settings: Partial<CheckpointSettings>;
}

export interface CheckpointSettingsSetResponse {
  success: boolean;
  settings: CheckpointSettings;
  error?: string;
}

export interface CheckpointSettingsChangedEvent {
  settings: CheckpointSettings;
}

// OfficeExtension

export interface OfficeExtensionConvertRequest {
  filetype: string;
  outputtype: string;
  key?: string;
  title?: string;
  filePath?: string;
  url?: string;
  outputPath?: string;
}

export interface OfficeExtensionConvertResponse {
  success: boolean;
  url?: string;
  outputPath?: string;
  error?: string;
}

export interface OfficeExtensionDownloadRequest {
  url: string;
}

export interface OfficeExtensionDownloadResponse {
  success: boolean;
  buffer?: ArrayBuffer;
  error?: string;
}

export interface OfficeExtensionStatusResponse {
  running: boolean;
  port: number;
}

export interface OfficeExtensionEnsureRunningResponse {
  success: boolean;
  error?: string;
}

export interface OfficeExtensionCheckInstalledResponse {
  installed: boolean;
}

export interface OfficeExtensionInstallResponse {
  success: boolean;
  error?: string;
}

export interface OfficeExtensionInstallProgressEvent {
  stage: 'downloading' | 'extracting' | 'configuring' | 'complete' | 'error';
  bytesDownloaded?: number;
  totalBytes?: number;
  message?: string;
  error?: string;
}

export interface OfficeExtensionUninstallResponse {
  success: boolean;
  error?: string;
}

// VoiceExtension

export interface VoiceExtensionCheckInstalledRequest {
  backend?: SttBackend;
}

export interface VoiceExtensionCheckInstalledResponse {
  installed: boolean;
  installPath?: string;
  error?: string;
}

export interface VoiceExtensionInstallRequest {
  backend?: SttBackend;
}

export interface VoiceExtensionInstallResponse {
  success: boolean;
  error?: string;
}

export interface InterpreterOverlayStartWindowVoiceRequest {
  selectedText?: string | null;
  sessionKind?: 'advanced_voice' | 'onboarding_voice_interview';
}

export interface InterpreterOverlayStartWindowVoiceResponse {
  success: boolean;
  error?: string;
}

export type InterpreterOverlayOnboardingVoiceInterviewCompletedEvent = OnboardingInterviewAnswers;

export interface VoiceExtensionInstallProgressEvent {
  stage: 'preparing' | 'downloading' | 'copying' | 'complete' | 'error';
  message?: string;
  error?: string;
}

// Text-to-Speech

export interface TtsGetSettingsResponse {
  settings: TtsSettings;
  installRoot: string;
}

export interface TtsSetSettingsRequest {
  settings: Partial<TtsSettings>;
}

export interface TtsSetSettingsResponse {
  success: boolean;
  settings: TtsSettings;
  error?: string;
}

export interface TtsModelStatus {
  id: TtsModelId;
  size: TtsModelSize;
  label: string;
  description: string;
  installed: boolean;
  installPath: string;
}

export interface TtsListModelsResponse {
  models: TtsModelStatus[];
  installRoot: string;
}

export interface TtsInstallModelRequest {
  modelId: TtsModelId;
}

export interface TtsInstallModelResponse {
  success: boolean;
  modelId: TtsModelId;
  installPath?: string;
  error?: string;
}

export interface TtsVoiceOption {
  id: number;
  label: string;
}

export interface TtsGetVoicesRequest {
  modelId?: TtsModelId;
}

export interface TtsGetVoicesResponse {
  modelId: TtsModelId;
  installed: boolean;
  voices: TtsVoiceOption[];
  error?: string;
}

export interface TtsSpeakRequest {
  text?: string;
  inputPath?: string;
  outputPath?: string;
  play?: boolean;
  source?: 'manual' | 'assistant-auto';
  requestTag?: string;
  messageId?: string;
  sentenceIndex?: number;
  modelId?: TtsModelId;
  voiceId?: number;
  speed?: number;
  provider?: TtsProvider;
}

export interface TtsSpeakResponse {
  success: boolean;
  chars?: number;
  outputPath?: string;
  modelId?: TtsModelId;
  voiceId?: number;
  durationSeconds?: number;
  error?: string;
}

export interface TtsSettingsChangedEvent {
  settings: TtsSettings;
}

export interface TtsInstallProgressEvent {
  modelId: TtsModelId;
  stage: 'preparing' | 'downloading' | 'extracting' | 'complete' | 'error';
  message?: string;
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
}

export interface TtsPlaybackRequestedEvent {
  audioBase64: string;
  mimeType: 'audio/wav';
  text: string;
  source: 'manual' | 'assistant-auto';
  requestTag?: string;
  messageId?: string;
  sentenceIndex?: number;
  modelId: TtsModelId;
  voiceId: number;
  speed: number;
}

// Speech-to-Text

export interface SttGetSettingsResponse {
  settings: SttSettings;
}

export interface SttSetSettingsRequest {
  settings: Partial<SttSettings>;
}

export interface SttSetSettingsResponse {
  success: boolean;
  settings: SttSettings;
  error?: string;
}

export interface SttSettingsChangedEvent {
  settings: SttSettings;
}

// File Operations

export interface FilesMoveRequest {
  sourcePath: string;
  destPath: string;
}

export interface FilesMoveResponse {
  success: boolean;
  error?: string;
}

export interface FilesRenameRequest {
  path: string;
  newName: string;
}

export interface FilesRenameResponse {
  success: boolean;
  newPath?: string;
  error?: string;
}

export interface FilesDeleteRequest {
  path: string;
}

export interface FilesDeleteResponse {
  success: boolean;
  error?: string;
}

export interface FilesTrashRequest {
  path: string;
}

export interface FilesTrashResponse {
  success: boolean;
  error?: string;
}

export interface FilesDuplicateRequest {
  path: string;
}

export interface FilesDuplicateResponse {
  success: boolean;
  newPath?: string;
  error?: string;
}

export interface FilesCreateFolderRequest {
  parentPath: string;
  name?: string;
}

export interface FilesCreateFolderResponse {
  success: boolean;
  path?: string;
  error?: string;
}

export interface FilesCopyPathRequest {
  path: string;
}

export interface FilesCopyPathResponse {
  success: boolean;
  error?: string;
}

export interface FilesReadRequest {
  path: string;
}

export interface FilesReadResponse {
  content: string;
}

export interface FilesReadBinaryRequest {
  path: string;
}

export interface FilesReadBinaryResponse {
  buffer: ArrayBuffer;
}

export interface FilesWriteRequest {
  path: string;
  content: string;
}

export interface FilesWriteResponse {
  success: boolean;
}

export interface FilesWriteBinaryRequest {
  path: string;
  buffer: ArrayBuffer;
}

export interface FilesWriteBinaryResponse {
  success: boolean;
}

export interface FilesGetThumbnailsRequest {
  paths: string[];
  size?: number;
}

export interface FilesGetThumbnailsResponse {
  thumbnails: Record<string, FileThumbnailData>;
}

export interface FilesCreateRequest {
  type: 'note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie';
  workspacePath: string;
}

export interface FilesCreateResponse {
  success: boolean;
  path?: string;
  error?: string;
}

export interface FilesCreateBookmarkRequest {
  url: string;
  title: string;
  faviconUrl?: string;
  destFolder: string;
}

export interface FilesCreateBookmarkResponse {
  success: boolean;
  path?: string;
  error?: string;
}

export interface FilesCopyExternalRequest {
  sourcePaths: string[];
  destFolder: string;
}

export interface FilesCopyExternalResponse {
  success: boolean;
  copiedPaths?: string[];
  error?: string;
}

export interface FilesIsDirectoryRequest {
  path: string;
}

export interface FilesIsDirectoryResponse {
  isDirectory: boolean;
}

export interface FilesGetStatsRequest {
  path: string;
}

export interface FilesGetStatsResponse {
  size: number | null;
  lineCount: number | null;
  itemCount: number | null;
  isDirectory: boolean;
}

export interface FilesListDirectoryRequest {
  path: string;
}

export interface FilesListDirectoryResponse {
  success: boolean;
  entries?: import('../../shared/types/folder').FolderTreeNode[];
  error?: string;
}

export interface FilesStartDragRequest {
  filePath: string;
}

export interface FilesStartDragResponse {
  success: boolean;
  error?: string;
}

export interface FilesDownloadUrlRequest {
  url: string;
  suggestedFilename?: string;
}

export interface FilesSaveClipboardImageRequest {
  imageData: ArrayBuffer;
  mimeType: string;
  suggestedFilename?: string;
}

export interface FilesDownloadUrlResponse {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface ProjectRunnerPathRequest {
  projectPath: string;
}

export interface ProjectRunnerStartResponse {
  success: boolean;
  state: import('../../shared/types/projectRunner').ProjectRunnerState;
  error?: string;
}

export interface ProjectRunnerStopResponse {
  success: boolean;
  state: import('../../shared/types/projectRunner').ProjectRunnerState;
  error?: string;
}

export interface ProjectRunnerGetStatusResponse {
  success: boolean;
  state: import('../../shared/types/projectRunner').ProjectRunnerState;
}

export interface ProjectRunnerChangedEvent {
  state: import('../../shared/types/projectRunner').ProjectRunnerState;
}

export interface MovieExportRequest {
  exportId: string;
  manifestPath: string;
  outputPath?: string;
}

export interface MovieCancelExportRequest {
  exportId: string;
}

export interface MovieCompileComponentsRequest {
  manifestPath: string;
}

export interface MovieCompileComponentsResponse {
  success: boolean;
  code?: string;
  error?: string;
}

export interface MovieExportResponse {
  success: boolean;
  outputPath?: string;
  cancelled?: boolean;
  error?: string;
}

export interface MovieCancelExportResponse {
  success: boolean;
  error?: string;
}

export interface MovieExportProgressEvent {
  exportId: string;
  manifestPath: string;
  stage: 'preparing' | 'rendering' | 'encoding' | 'muxing' | 'complete' | 'cancelled' | 'error';
  progress: number | null;
  message: string | null;
}

// Shell Operations

export interface ShellRevealInFinderRequest {
  path: string;
}

export interface ShellRevealInFinderResponse {
  success: boolean;
  error?: string;
}

export interface ShellCopyFileRequest {
  path: string;
}

export interface ShellCopyFileResponse {
  success: boolean;
  error?: string;
}

export interface ShellCutFileRequest {
  path: string;
}

export interface ShellCutFileResponse {
  success: boolean;
  error?: string;
}

// Conversations

export interface ConversationMetadata {
  conversationId: string;
  agentId: string;
  profileId?: string;  // Optional - may use modelConfig instead
  modelConfig?: import('../../shared/types/model').AgentModelConfig;  // Full model config for profile preservation
  workspacePath?: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedConversation {
  conversationId: string;
  threadState: any; // ExportedMessageRepository from assistant-ui
  metadata: ConversationMetadata;
  // NEW: Subagent tool calls lookup - NOT stored in threadState because assistant-ui strips it
  // Key: parentToolCallId, Value: array of tool call events for that subagent
  subagentToolCalls?: Record<string, SubagentToolCallEvent[]>;
}

// IPC requests
export interface ConversationSaveRequest {
  workspace: string;
  conversation: SavedConversation;
}

export interface ConversationSaveResponse {
  success: boolean;
  error?: string;
}

export interface ConversationLoadRequest {
  workspace: string;
  conversationId: string;
}

export interface ConversationLoadResponse {
  success: boolean;
  conversation?: SavedConversation;
  error?: string;
}

export interface ConversationListRequest {
  workspace: string;
}

export interface ConversationListResponse {
  success: boolean;
  conversations?: ConversationMetadata[];
  error?: string;
}

export interface ConversationListWithPreviewsRequest {
  workspace: string;
}

export interface ConversationWithPreview extends ConversationMetadata {
  firstMessagePreview: string;
  lastMessagePreview: string;
}

export interface ConversationListWithPreviewsResponse {
  success: boolean;
  conversations?: ConversationWithPreview[];
  error?: string;
}

export interface ConversationDeleteRequest {
  workspace: string;
  conversationId: string;
}

export interface ConversationDeleteResponse {
  success: boolean;
  error?: string;
}

// Browser

export interface BrowserCreateRequest {
  id: string;
  url: string;
  browserId?: string;
  faviconUrl?: string;
}

export interface BrowserCreateResponse {
  success: boolean;
  error?: string;
}

export interface BrowserNavigateRequest {
  id: string;
  url: string;
}

export interface BrowserNavigateResponse {
  success: boolean;
  error?: string;
}

export interface BrowserIdRequest {
  id: string;
}

export interface BrowserDetachRequest {
  id: string;
}

export interface BrowserActionResponse {
  success: boolean;
  error?: string;
}

export interface BrowserGetStateRequest {
  id: string;
}

export interface BrowserGetStateResponse {
  success: boolean;
  state?: {
    url: string;
    title: string;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  };
  error?: string;
}

export interface BrowserAttachRequest {
  id: string;
  windowId: number;
}

export interface BrowserSetBoundsRequest {
  id: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BrowserEvent {
  id: string;
  type: 'url-changed' | 'title-changed' | 'loading-changed' | 'navigation-state-changed';
  data: any;
}

export interface BrowserPersistedTab {
  browserId: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

export interface BrowserGetPersistedTabsResponse {
  success: boolean;
  tabs?: BrowserPersistedTab[];
  error?: string;
}

export interface BrowserTabCreatedEvent {
  browserId: string;
  url: string;
}

export interface BrowserTabClosedEvent {
  browserId: string;
}

// Workstation Control Events (one-way, main -> renderer)

export interface WorkstationOpenFileEvent {
  path: string;
  page?: number;
  origin?: 'external-file-open';
}

export interface WorkstationOpenUrlEvent {
  url: string;
}

export interface WorkstationCloseTabEvent {
  id: string;
}

export interface WorkstationFocusTabEvent {
  id: string;
}

export interface WorkstationToggleSidebarEvent {
  side: 'left' | 'right';
  open?: boolean;  // explicit open/close state (if undefined, toggles)
}

// App Update

export interface AppUpdateReadyEvent {
  version: string;
}

export interface AppUpdateErrorEvent {
  message: string;
}

export interface AppUpdateInstallResponse {
  success: boolean;
}

export interface AppUpdateCheckNowResponse {
  success: boolean;
}

// Browser Control

export interface BrowserControlGetPolicyResponse {
  policy: BrowserAccessPolicy;
}

export interface BrowserControlSetPolicyRequest {
  policy: BrowserAccessPolicy;
}

export interface BrowserControlSetPolicyResponse {
  success: boolean;
  policy: BrowserAccessPolicy;
  error?: string;
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

export interface BrowserControlChangedEvent {
  reason: 'policy' | 'status';
  policy: BrowserAccessPolicy;
}

// Background Opacity

export interface BackgroundOpacityGetResponse {
  opacity: number; // 0-1 range
}

export interface BackgroundOpacitySetRequest {
  opacity: number; // 0-1 range
}

export interface BackgroundOpacitySetResponse {
  success: boolean;
  error?: string;
}

export interface BackgroundOpacityChangedEvent {
  opacity: number; // 0-1 range
}

// Zoom Factor

export interface ZoomFactorGetResponse {
  zoomFactor: number; // 0.5-3 range
}

export interface ZoomFactorSetRequest {
  zoomFactor: number; // 0.5-3 range
}

export interface ZoomFactorSetResponse {
  success: boolean;
  error?: string;
}

export interface ZoomFactorChangedEvent {
  zoomFactor: number;
}

// Locale

export interface LocaleGetResponse {
  language: string;
}

export interface LocaleSetRequest {
  language: string;
}

export interface LocaleSetResponse {
  success: boolean;
  error?: string;
}

export interface LocaleChangedEvent {
  language: string;
}

// Theme

export interface ThemeGetResponse {
  theme: 'light' | 'dark' | 'system';
}

export interface ThemeSetRequest {
  theme: 'light' | 'dark' | 'system';
}

export interface ThemeSetResponse {
  success: boolean;
  error?: string;
}

export interface ThemeChangedEvent {
  theme: 'light' | 'dark' | 'system';
}

// Primary Color

export interface PrimaryColorGetResponse {
  color: string;
}

export interface PrimaryColorSetRequest {
  color: string;
}

export interface PrimaryColorSetResponse {
  success: boolean;
  error?: string;
}

export interface PrimaryColorChangedEvent {
  color: string;
}

// UI Settings - boolean setting types from shared/booleanSettings.ts
export type { BooleanSettingGetResponse, BooleanSettingSetResult, BooleanSettingChangedEvent } from '../../shared/booleanSettings';
export { booleanSettingChannels, BOOLEAN_UI_SETTING_IDS, type BooleanUISettingId } from '../../shared/booleanSettings';

// Tool Servers

export interface ToolServerInfo {
  id: string;
  name: string;
  description?: string;
  state: {
    status: 'connecting' | 'connected' | 'failed' | 'disconnected';
    error?: string;
  };
  config?: any;
  globallyDisabled?: boolean;
}

export interface ToolServersChangedEvent {
  servers: ToolServerInfo[];
}

// Window/Fullscreen

export interface WindowFullscreenChangedEvent {
  isFullScreen: boolean;
}

// Subagent Tool Events

export interface SubagentToolCallEvent {
  /** Full path from root to this tool call, e.g., ["explore-abc", "task-def", "read_file-ghi"] */
  toolCallPath: string[];
  /** Depth in the subagent tree (toolCallPath.length) */
  depth: number;
  /** @deprecated Use toolCallPath[0] for root parent. Kept for backwards compatibility. */
  parentToolCallId: string;    // The explore/read/edit tool call ID
  subagentName: string;        // "explore", "read", "edit", "task"
  toolCall: {
    toolCallId: string;
    toolName: string;
    args: any;
  };
  result?: {
    output: any;
    isError: boolean;
  };
  /** Text delta for real-time text streaming */
  textDelta?: string;
  stepIndex: number;
  timestamp: string;
}

// Agent Notifications

export interface AgentNotificationEvent {
  agentId: string;
  content: string;
  source: string;
}

export interface AppToastEvent {
  message: string;
  variant: 'info' | 'success' | 'error';
  autoDismissMs?: number;
}

export interface ProgrammaticTaskStartedEvent {
  mode: 'headed' | 'headless';
  message: string;
  messagePreview: string;
  timestamp: string;
}

export interface ProgrammaticTaskStartHeadedRequest {
  message?: string;
  system?: string;
  timeoutMs?: number;
  workspace?: string;
  threadId?: string;
}

export interface ProgrammaticTaskStartHeadedResult {
  mode: 'headed';
  // True only after the renderer acknowledges that the visible tab was created.
  opened: boolean;
  timestamp: string;
  messageCount: number;
  messages: any[];
  error?: string;
  agentId?: string;
  requestId?: string;
  threadId?: string;
}

export interface ProgrammaticTaskStartHeadedResponse {
  success: boolean;
  result?: ProgrammaticTaskStartHeadedResult;
  error?: string;
}

// Tab Navigation Events
// These are simple events with no payload (except TAB_GO_TO which takes an index)
// - TAB_CLOSE: Close the active tab (CMD+W)
// - TAB_NEW: Open a new main-area agent tab (CMD+T)
// - TAB_NEXT: Select next tab (CMD+Shift+])
// - TAB_PREVIOUS: Select previous tab (CMD+Shift+[)
// - TAB_GO_TO: Go to specific tab by index (CMD+1-9, where -1 means last tab)
// - QUICK_OPEN: Open explorer sidebar and focus search bar (CMD+K)
// - TOGGLE_EXPLORER: Toggle explorer sidebar (CMD+E)
// - FOCUS_AGENT: Toggle the right sidebar (CMD+L)
// - NEW_SIDEBAR_AGENT: Create a new pinned sidebar agent (CMD+Shift+L)

// Feedback

export interface FeedbackSubmitRequest {
  email: string;
  message: string;
  includeLogs: boolean;
  images?: Array<{ data: string; name: string }>;
}

export interface FeedbackSubmitResponse {
  success: boolean;
  id?: string;
  error?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isApprovalData(data: any): data is ApprovalData {
  return (
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    typeof data.toolName === 'string' &&
    typeof data.serverId === 'string' &&
    typeof data.timestamp === 'number'
  );
}

export function isApprovalListChangedEvent(data: any): data is ApprovalListChangedEvent {
  return (
    typeof data === 'object' &&
    typeof data.count === 'number' &&
    Array.isArray(data.approvals)
  );
}

// ============================================================================
// Type Exports for External Use
// ============================================================================

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];

// Global Tools

export interface GlobalToolsListResponse {
  tools: Record<string, boolean>;
}

export interface GlobalToolsGetRequest {
  serverId: string;
}

export interface GlobalToolsGetResponse {
  enabled: boolean;
}

export interface GlobalToolsSetRequest {
  serverId: string;
  enabled: boolean;
}

export interface GlobalToolsSetResponse {
  success: boolean;
  error?: string;
}

export interface GlobalToolsChangedEvent {
  serverId: string;
  enabled: boolean;
}

export interface AuthDeepLinkEvent {
  url: string;
}

// Terminal

export interface TerminalCreateRequest {
  cwd?: string;
}

export interface TerminalCreateResponse {
  sessionId: string;
}

export interface TerminalWriteRequest {
  sessionId: string;
  data: string;
}

export interface TerminalWriteResponse {
  success: boolean;
  error?: string;
}

export interface TerminalResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalResizeResponse {
  success: boolean;
  error?: string;
}

export interface TerminalCloseRequest {
  sessionId: string;
}

export interface TerminalCloseResponse {
  success: boolean;
  error?: string;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

// Codex Server

export interface CodexEvent {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexRequestParams {
  method: string;
  params: unknown;
}

export interface CodexSaveThreadRequest {
  thread_id: string;
  items: unknown[];
}

export interface CodexLoadThreadResponse {
  items: unknown[] | null;
}

export interface CodexListThreadsResponse {
  threads: { id: string; name: string; updated_at: number }[];
}

// Skills

export interface SkillsListRequest {
  workspacePath?: string | null;
}

export interface SkillsListResponse {
  success: boolean;
  data?: import('../../shared/types/skill').SkillsData;
  error?: string;
}

// Desktop Notifications

export interface DesktopNotificationShowRequest {
  title: string;
  body: string;
  agentId?: string;
  approvalId?: string;
}

export interface DesktopNotificationShowResponse {
  success: boolean;
}

export interface DesktopNotificationClickedEvent {
  agentId?: string;
  approvalId?: string;
}

// User Email

export interface UserEmailGetResponse {
  email: string | null;
}

export interface UserEmailSetRequest {
  email: string;
}

export interface UserEmailSetResponse {
  success: boolean;
  email: string;
}

// Onboarding Persona

export interface OnboardingPersonaGetResponse {
  persona: import('../../server/configStore').OnboardingPersona | null;
}

export interface OnboardingPersonaSetRequest {
  bucket: 'non-developer' | 'developer' | 'developer-local-ai';
  subCategories: string[];
  detectedProviders: string[];
}

export interface OnboardingPersonaSetResponse {
  success: boolean;
}

// Onboarding Permissions

export interface OnboardingPermissionsGetResponse {
  permissions: import('../../server/configStore').OnboardingPermissions;
}

export interface OnboardingPermissionsSetRequest {
  readOutsideWorkspace: 'deny' | 'allow';
  writeFilesInWorkspace: boolean;
}

export interface OnboardingPermissionsSetResponse {
  success: boolean;
}

// Environment Detection

export interface EnvironmentDetectionResponse {
  signals: import('../../server/environmentDetection').EnvironmentDetectionResult;
  persona: import('../../server/derivePersona').DerivedPersona;
}

// Newsletter

export interface NewsletterSubscribeRequest {
  email: string;
}

export interface NewsletterSubscribeResponse {
  success: boolean;
}
import type { MessagingChannel } from '../../shared/types/messaging';
