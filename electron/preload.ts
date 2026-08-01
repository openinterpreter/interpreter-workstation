import { contextBridge, ipcRenderer, webUtils } from 'electron';
import * as Sentry from '@sentry/electron/renderer';
import path from 'path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { IPC_CHANNELS } from './ipc/registry';
import {
  parseWindowBootstrapLayoutArg,
  parseWindowSessionKeyArg,
} from './windowSessionArgs';
import { shouldDisableMacTransparency } from './utils/macWindowAppearance';
import type {
  ApiRequestParams,
  ApiRequestResponse,
  ShutdownResponse,
  OpenFolderDialogResponse,
  OpenPathResponse,
  SavePathDialogOptions,
  SavePathDialogResponse,
  ClipboardWriteTextRequest,
  ClipboardWriteTextResponse,
  ShowItemsInFolderRequest,
  ApprovalGetRequest,
  ApprovalGetResponse,
  ApprovalActionRequest,
  ApprovalActionResponse,
  ApprovalRespondRequest,
  ApprovalRespondResponse,
  ApprovalCreatedEvent,
  ApprovalResolvedEvent,
  ApprovalTimeoutEvent,
  ApprovalListChangedEvent,
  RuntimeRestartingEvent,
  RuntimeRestartedEvent,
  AgentTabCreateRequestedEvent,
  AgentTabSendRequestedEvent,
  AgentTabStopRequestedEvent,
  AgentTabCreatedRequest,
  AgentTabCreatedResponse,
  AgentTabCompletedRequest,
  AgentTabCompletedResponse,
  AgentTabConsumeStartupRequest,
  AgentTabConsumeStartupResponse,
  AgentTabDisposeBindingRequest,
  AgentTabDisposeBindingResponse,
  AgentTabGetPendingResponse,
  AgentTabReportActivityRequest,
  AgentTabReportActivityResponse,
  AgentTabRegisterThreadRequest,
  AgentTabRegisterThreadResponse,
  AgentThreadsDeleteAllResponse,
  AgentThreadsDeleteResponse,
  AgentThreadsArchiveResponse,
  AgentThreadsRenameResponse,
  AgentThreadsUnarchiveResponse,
  ProfilesChangedEvent,
  ProfilesConfigRecoveredEvent,
  ProfilesDefaultChangedEvent,
  SetupCompletedEvent,
  ComputerUseSetupRequestedEvent,
  WorkspaceConfirmationRequestedEvent,
  WorkspaceConfirmationRespondRequest,
  WorkspaceConfirmationRespondResponse,
  WorkspaceCreateSampleResponse,
  WorkspaceFilesChangedEvent,
  PdfUpdateFormDataRequest,
  PdfUpdateFormDataResponse,
  PdfFillFieldEvent,
  FileRefreshedEvent,
  CheckpointGetResponse,
  CheckpointRestoreResponse,
  CheckpointSettings,
  CheckpointSettingsGetResponse,
  CheckpointSettingsSetResponse,
  CheckpointSettingsChangedEvent,
  CheckpointStatusEvent,
  FilesMoveRequest,
  FilesMoveResponse,
  FilesRenameRequest,
  FilesRenameResponse,
  FilesDeleteRequest,
  FilesDeleteResponse,
  FilesTrashRequest,
  FilesTrashResponse,
  FilesDuplicateRequest,
  FilesDuplicateResponse,
  FilesCopyPathRequest,
  FilesCopyPathResponse,
  FilesReadRequest,
  FilesReadResponse,
  FilesReadBinaryRequest,
  FilesReadBinaryResponse,
  FilesWriteRequest,
  FilesWriteResponse,
  FilesWriteBinaryRequest,
  FilesWriteBinaryResponse,
  FilesGetThumbnailsRequest,
  FilesGetThumbnailsResponse,
  FilesCreateRequest,
  FilesCreateResponse,
  FilesCreateFolderRequest,
  FilesCreateFolderResponse,
  FilesCreateBookmarkRequest,
  FilesCreateBookmarkResponse,
  FilesCopyExternalRequest,
  FilesCopyExternalResponse,
  FilesIsDirectoryRequest,
  FilesIsDirectoryResponse,
  FilesGetStatsRequest,
  FilesGetStatsResponse,
  FilesListDirectoryRequest,
  FilesListDirectoryResponse,
  FilesStartDragRequest,
  FilesSaveClipboardImageRequest,
  FilesDownloadUrlRequest,
  FilesDownloadUrlResponse,
  ProjectRunnerPathRequest,
  ProjectRunnerStartResponse,
  ProjectRunnerStopResponse,
  ProjectRunnerGetStatusResponse,
  ProjectRunnerChangedEvent,
  MovieCancelExportRequest,
  MovieCancelExportResponse,
  MovieExportRequest,
  MovieExportResponse,
  MovieExportProgressEvent,
  MovieCompileComponentsRequest,
  MovieCompileComponentsResponse,
  ShellRevealInFinderRequest,
  ShellRevealInFinderResponse,
  ShellCopyFileRequest,
  ShellCopyFileResponse,
  ShellCutFileRequest,
  ShellCutFileResponse,
  ConversationSaveRequest,
  ConversationSaveResponse,
  ConversationLoadRequest,
  ConversationLoadResponse,
  ConversationListRequest,
  ConversationListResponse,
  ConversationListWithPreviewsRequest,
  ConversationListWithPreviewsResponse,
  ConversationDeleteRequest,
  ConversationDeleteResponse,
  OfficeExtensionConvertRequest,
  OfficeExtensionConvertResponse,
  OfficeExtensionDownloadRequest,
  OfficeExtensionDownloadResponse,
  OfficeExtensionStatusResponse,
  OfficeExtensionEnsureRunningResponse,
  BrowserCreateRequest,
  BrowserCreateResponse,
  BrowserNavigateRequest,
  BrowserNavigateResponse,
  BrowserIdRequest,
  BrowserActionResponse,
  BrowserGetStateRequest,
  BrowserGetStateResponse,
  BrowserAttachRequest,
  BrowserSetBoundsRequest,
  BrowserEvent,
  BrowserGetPersistedTabsResponse,
  BrowserTabCreatedEvent,
  BrowserTabClosedEvent,
  BrowserControlArrangeSplitRequest,
  BrowserControlArrangeSplitResponse,
  BrowserControlGetPolicyResponse,
  BrowserControlSetPolicyRequest,
  BrowserControlSetPolicyResponse,
  BrowserControlChangedEvent,
  BackgroundOpacityGetResponse,
  BackgroundOpacitySetRequest,
  ZoomFactorChangedEvent,
  ZoomFactorGetResponse,
  ZoomFactorSetRequest,
  WindowCreateRequest,
  WindowCreateResponse,
  WindowDetachTabRequest,
  WindowDetachTabResponse,
  WindowTransferTabOutRequest,
  WindowTransferTabOutResponse,
  LocaleGetResponse,
  LocaleSetRequest,
  LocaleSetResponse,
  LocaleChangedEvent,
  BackgroundOpacitySetResponse,
  BackgroundOpacityChangedEvent,
  ZoomFactorSetResponse,
  ThemeGetResponse,
  ThemeSetRequest,
  ThemeSetResponse,
  ThemeChangedEvent,
  PrimaryColorGetResponse,
  PrimaryColorSetRequest,
  PrimaryColorSetResponse,
  PrimaryColorChangedEvent,
  WindowFullscreenChangedEvent,
  WorkstationOpenFileEvent,
  WorkstationOpenUrlEvent,
  WorkstationCloseTabEvent,
  WorkstationFocusTabEvent,
  WorkstationToggleSidebarEvent,
  ToolServersChangedEvent,
  SubagentToolCallEvent,
  AgentNotificationEvent,
  AppToastEvent,
  ProgrammaticTaskStartHeadedRequest,
  ProgrammaticTaskStartHeadedResponse,
  ProgrammaticTaskStartedEvent,
  GenericContextMenuRequest,
  GenericContextMenuResponse,
  SelectRequest,
  SelectResponse,
  DesktopSourceListRequest,
  DesktopSourceListResponse,
  CachedFileTree,
  FeedbackSubmitRequest,
  FeedbackSubmitResponse,
  GlobalToolsListResponse,
  GlobalToolsGetResponse,
  GlobalToolsSetResponse,
  GlobalToolsChangedEvent,
  AuthDeepLinkEvent,
  TerminalCreateResponse,
  TerminalWriteResponse,
  TerminalResizeResponse,
  TerminalCloseResponse,
  TerminalDataEvent,
  TerminalExitEvent,
  CodexEvent,
  CodexLoadThreadResponse,
  CodexListThreadsResponse,
  SkillsListRequest,
  SkillsListResponse,
  DesktopNotificationShowRequest,
  DesktopNotificationShowResponse,
  DesktopNotificationClickedEvent,
  AppUpdateReadyEvent,
  AppUpdateErrorEvent,
  AppUpdateInstallResponse,
  VoiceExtensionCheckInstalledRequest,
  VoiceExtensionInstallRequest,
  TtsGetSettingsResponse,
  TtsSetSettingsRequest,
  TtsSetSettingsResponse,
  TtsListModelsResponse,
  TtsInstallModelRequest,
  TtsInstallModelResponse,
  TtsGetVoicesRequest,
  TtsGetVoicesResponse,
  TtsSpeakRequest,
  TtsSpeakResponse,
  TtsSettingsChangedEvent,
  TtsInstallProgressEvent,
  TtsPlaybackRequestedEvent,
  SttGetSettingsResponse,
  SttSetSettingsRequest,
  SttSetSettingsResponse,
  SttSettingsChangedEvent,
  AppUpdateCheckNowResponse,
} from './ipc/registry';
import type { LayoutState } from '../shared/types/layout';
import { WORKSTATION_SENTRY_DSN } from '../shared/constants/sentry';
import type {
  BrowserControlActivateTabRequest,
  BrowserControlActivateTabResponse,
  BrowserControlStatus,
} from '../shared/types/browserControl';

// NOTE(victor): In dev mode, main process has Sentry disabled (enabled: app.isPackaged)
// so the sentry-ipc:// protocol isn't registered. We detect packaged apps by checking
// if running from an asar archive - this is the canonical preload pattern since
// app.isPackaged isn't available in preload context.
const isPackagedApp = __dirname.includes('app.asar');
Sentry.init({ enabled: isPackagedApp && Boolean(WORKSTATION_SENTRY_DSN) });
const windowSessionKey = parseWindowSessionKeyArg(process.argv) ?? 'window-unknown';
const windowBootstrapLayout = parseWindowBootstrapLayoutArg(process.argv);

// Define the API interface
export interface ElectronAPI {
  getServerPort: () => Promise<number>;
  getWindowId: () => Promise<number>;
  getWindowSessionKey: () => string;
  getWindowBootstrapLayout: () => LayoutState | null;
  isPackaged: () => boolean;
  getPlatform: () => NodeJS.Platform;
  getOsRelease: () => string;
  isNativeMacTransparencyEnabled: () => boolean;
  apiRequest: (request: ApiRequestParams) => Promise<ApiRequestResponse>;
  shutdown: () => Promise<ShutdownResponse>;
  getInitialFileTree: () => Promise<CachedFileTree | null>;
  log: (level: string, ...args: any[]) => void;
  openFolderDialog: () => Promise<OpenFolderDialogResponse>;
  openPathDialog: (options?: { type?: 'file' | 'folder' | 'both'; defaultPath?: string; title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  savePathDialog: (options?: SavePathDialogOptions) => Promise<SavePathDialogResponse>;
  writeClipboardText: (text: string) => Promise<ClipboardWriteTextResponse>;
  getPathForFile: (file: File) => string;
  pathBasename: (filePath: string) => string;
  pathDirname: (filePath: string) => string;
  pathJoin: (...segments: string[]) => string;
  pathResolve: (fromPath: string, toPath: string) => string;
  pathSep: string;
  pathIsAbsolute: (filePath: string) => boolean;
  pathNormalize: (filePath: string) => string;
  pathRelative: (fromPath: string, toPath: string) => string;
  pathToFileURL: (filePath: string) => string;
  openExternal: (url: string) => Promise<void>;
  openPath: (filePath: string) => Promise<OpenPathResponse>;
  showItemInFolder: (fullPath: string) => Promise<void>;
  showItemsInFolder: (fullPaths: string[]) => Promise<void>;
  showContextMenu: (request: GenericContextMenuRequest) => Promise<GenericContextMenuResponse>;
  showSelect: (request: SelectRequest) => Promise<SelectResponse>;
  desktopSources: {
    list: (request?: DesktopSourceListRequest) => Promise<DesktopSourceListResponse>;
  };
  macTitlebarClicked: () => void;
  rendererReady: () => void;

  // Approval IPC methods
  approvals: {
    onCreated: (callback: (event: ApprovalCreatedEvent) => void) => () => void;
    onResolved: (callback: (event: ApprovalResolvedEvent) => void) => () => void;
    onTimeout: (callback: (event: ApprovalTimeoutEvent) => void) => () => void;
    onListChanged: (callback: (event: ApprovalListChangedEvent) => void) => () => void;
    get: (request: ApprovalGetRequest) => Promise<ApprovalGetResponse>;
    approve: (request: ApprovalActionRequest) => Promise<ApprovalActionResponse>;
    deny: (request: ApprovalActionRequest) => Promise<ApprovalActionResponse>;
    respond: (request: ApprovalRespondRequest) => Promise<ApprovalRespondResponse>;
  };

  runtime: {
    onRestarting: (callback: (event: RuntimeRestartingEvent) => void) => () => void;
    onRestarted: (callback: (event: RuntimeRestartedEvent) => void) => () => void;
  };

  // Agent Tab IPC methods
  agentTabs: {
    onCreateRequested: (callback: (request: AgentTabCreateRequestedEvent) => void) => () => void;
    onSendRequested: (callback: (event: AgentTabSendRequestedEvent) => void) => () => void;
    onStopRequested: (callback: (event: AgentTabStopRequestedEvent) => void) => () => void;
    created: (data: AgentTabCreatedRequest) => Promise<AgentTabCreatedResponse>;
    completed: (data: AgentTabCompletedRequest) => Promise<AgentTabCompletedResponse>;
    getPending: () => Promise<AgentTabGetPendingResponse>;
    registerThread: (data: AgentTabRegisterThreadRequest) => Promise<AgentTabRegisterThreadResponse>;
    reportActivity: (data: AgentTabReportActivityRequest) => Promise<AgentTabReportActivityResponse>;
    disposeBinding: (data: AgentTabDisposeBindingRequest) => Promise<AgentTabDisposeBindingResponse>;
    consumeStartup: (data: AgentTabConsumeStartupRequest) => Promise<AgentTabConsumeStartupResponse>;
  };

  agentThreads: {
    deleteThread: (threadId: string) => Promise<AgentThreadsDeleteResponse>;
    deleteAll: () => Promise<AgentThreadsDeleteAllResponse>;
    renameThread: (threadId: string, name: string) => Promise<AgentThreadsRenameResponse>;
    archiveThread: (threadId: string) => Promise<AgentThreadsArchiveResponse>;
    unarchiveThread: (threadId: string) => Promise<AgentThreadsUnarchiveResponse>;
  };

  // Profiles IPC methods
  profiles: {
    list: () => Promise<{ profiles: any[]; defaultProfileId: string | null; fastProfileId: string | null }>;
    get: (profileId: string) => Promise<any>;
    create: (profile: any) => Promise<{ success: boolean; profile: any }>;
    update: (profileId: string, updates: any) => Promise<{ success: boolean; profile: any }>;
    delete: (profileId: string) => Promise<{ success: boolean }>;
    setDefault: (profileId: string) => Promise<{ success: boolean; defaultProfileId: string; fastProfileId: string | null }>;
    setFast: (profileId: string) => Promise<{ success: boolean; defaultProfileId: string | null; fastProfileId: string }>;
    reset: (profileId: string) => Promise<{ success: boolean; profile: any }>;
    onChanged: (callback: (event: ProfilesChangedEvent) => void) => () => void;
    onDefaultChanged: (callback: (event: ProfilesDefaultChangedEvent) => void) => () => void;
    onConfigRecovered: (callback: (event: ProfilesConfigRecoveredEvent) => void) => () => void;
  };

  // Workspace IPC methods
  workspace: {
    get: () => Promise<{ workspace: string | null }>;
    createSample: () => Promise<WorkspaceCreateSampleResponse>;
    set: (request: { workspacePath: string }) => Promise<{ success: boolean }>;
    respondToConfirmation: (request: WorkspaceConfirmationRespondRequest) => Promise<WorkspaceConfirmationRespondResponse>;
    rename: (request: { oldPath: string; newName: string }) => Promise<{ success: boolean; newPath?: string; error?: string }>;
    addWatch: (folderPath: string) => Promise<{ success: boolean }>;
    removeWatch: (folderPath: string) => Promise<{ success: boolean }>;
    onConfirmationRequested: (callback: (event: WorkspaceConfirmationRequestedEvent) => void) => () => void;
    onChanged: (callback: (event: { workspacePath: string | null }) => void) => () => void;
    onFilesChanged: (callback: (event: WorkspaceFilesChangedEvent) => void) => () => void;
  };

  // Tool server CRUD + tool execution
  servers: {
    list: () => Promise<{ servers: any[] }>;
    get: (serverId: string) => Promise<any>;
    add: (config: any) => Promise<{ serverId: string }>;
    startOAuth: (serverId: string, scopes?: string[]) => Promise<{ authorizationUrl: string }>;
    update: (serverId: string, updates: any) => Promise<{ success: boolean }>;
    delete: (serverId: string) => Promise<{ success: boolean }>;
    toggle: (serverId: string, enabled: boolean) => Promise<{ success: boolean }>;
    callTool: (
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
      saveToDisk?: boolean,
      toolContext?: {
        profileId?: string;
        callerTabId?: string;
        workspace?: string;
        modelConfig?: import('../shared/types/model').AgentModelConfig;
      }
    ) => Promise<any>;
  };

  // Setup IPC methods
  setup: {
    onCompleted: (callback: (event: SetupCompletedEvent) => void) => () => void;
  };

  computerUseSetup: {
    onRequested: (callback: (event: ComputerUseSetupRequestedEvent) => void) => () => void;
    onStatusRequested: (callback: (event: import('./ipc/registry').ComputerUseSetupStatusRequestedEvent) => void) => () => void;
  };

  overlaySettings: {
    get: () => Promise<{ settings: import('../apps/interpreter-overlay/shared/settings').InterpreterOverlaySettings }>;
    set: (settings: import('../apps/interpreter-overlay/shared/settings').InterpreterOverlaySettings) => Promise<{ success: boolean; settings: import('../apps/interpreter-overlay/shared/settings').InterpreterOverlaySettings }>;
    getAccessState: (options?: { forceRefresh?: boolean }) => Promise<Awaited<ReturnType<typeof import('../server/handlers/settings').getInterpreterOverlaySettingsAccessState>>>;
    getPermissionStatus: () => Promise<Awaited<ReturnType<typeof import('../server/handlers/settings').getInterpreterOverlayPermissionStatus>>>;
    requestAccessibilityPermission: () => Promise<Awaited<ReturnType<typeof import('../server/handlers/settings').requestInterpreterOverlayAccessibilityPermission>>>;
    requestScreenRecordingPermission: () => Promise<Awaited<ReturnType<typeof import('../server/handlers/settings').requestInterpreterOverlayScreenRecordingPermission>>>;
    openAccessibilitySettings: () => Promise<{ success: boolean; error?: string }>;
    openScreenRecordingSettings: () => Promise<{ success: boolean; error?: string }>;
  };

  interpreterOverlay: {
    startWindowVoiceMode: (
      request?: import('./ipc/registry').InterpreterOverlayStartWindowVoiceRequest,
    ) => Promise<import('./ipc/registry').InterpreterOverlayStartWindowVoiceResponse>;
    onOnboardingVoiceInterviewCompleted: (
      callback: (event: import('./ipc/registry').InterpreterOverlayOnboardingVoiceInterviewCompletedEvent) => void,
    ) => () => void;
  };

  // PDF IPC methods
  pdf: {
    updateFormData: (filePath: string, formData: { fields: Array<{ name: string; type: string; value: any }> }) => Promise<PdfUpdateFormDataResponse>;
    onFillField: (callback: (event: PdfFillFieldEvent) => void) => () => void;
    readStructure: (filePath: string, page?: number) => Promise<import('./ipc/registry').PdfStructure | null>;
  };

  // Markdown IPC methods
  markdown: {
    onFormat: (callback: (action: string) => void) => () => void;
  };

  // File IPC methods
  // SECURITY: This namespace is only exposed to the trusted Electron renderer.
  // These methods are for explicit user-driven UI file access and are intentionally
  // more permissive than the workspace-scoped HTTP file API used in browser mode.
  // Do not mirror unrestricted read/write methods onto the HTTP IPC router.
  files: {
    onRefreshed: (callback: (event: FileRefreshedEvent) => void) => () => void;
    move: (sourcePath: string, destPath: string) => Promise<FilesMoveResponse>;
    rename: (path: string, newName: string) => Promise<FilesRenameResponse>;
    delete: (path: string) => Promise<FilesDeleteResponse>;
    trash: (path: string) => Promise<FilesTrashResponse>;
    duplicate: (path: string) => Promise<FilesDuplicateResponse>;
    copyPath: (path: string) => Promise<FilesCopyPathResponse>;
    read: (path: string) => Promise<FilesReadResponse>;
    readBinary: (path: string) => Promise<FilesReadBinaryResponse>;
    write: (path: string, content: string) => Promise<FilesWriteResponse>;
    writeBinary: (path: string, buffer: ArrayBuffer) => Promise<FilesWriteBinaryResponse>;
    getThumbnails: (paths: string[], size?: number) => Promise<FilesGetThumbnailsResponse>;
    create: (type: 'note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie', workspacePath: string) => Promise<FilesCreateResponse>;
    createFolder: (parentPath: string, name?: string) => Promise<FilesCreateFolderResponse>;
    createBookmark: (url: string, title: string, faviconUrl: string | undefined, destFolder: string) => Promise<FilesCreateBookmarkResponse>;
    copyExternal: (sourcePaths: string[], destFolder: string) => Promise<FilesCopyExternalResponse>;
    isDirectory: (path: string) => Promise<FilesIsDirectoryResponse>;
    getStats: (path: string) => Promise<FilesGetStatsResponse>;
    listDirectory: (path: string) => Promise<FilesListDirectoryResponse>;
    startDrag: (filePath: string) => void;
    downloadUrl: (url: string, suggestedFilename?: string) => Promise<FilesDownloadUrlResponse>;
    saveClipboardImage: (request: FilesSaveClipboardImageRequest) => Promise<FilesDownloadUrlResponse>;
  };
  projectRunner: {
    start: (projectPath: string) => Promise<ProjectRunnerStartResponse>;
    stop: (projectPath: string) => Promise<ProjectRunnerStopResponse>;
    getStatus: (projectPath: string) => Promise<ProjectRunnerGetStatusResponse>;
    onChanged: (callback: (event: ProjectRunnerChangedEvent) => void) => () => void;
  };

  movie: {
    compileComponents: (request: MovieCompileComponentsRequest) => Promise<MovieCompileComponentsResponse>;
    exportProject: (request: MovieExportRequest) => Promise<MovieExportResponse>;
    cancelExport: (request: MovieCancelExportRequest) => Promise<MovieCancelExportResponse>;
    onExportProgress: (callback: (event: MovieExportProgressEvent) => void) => () => void;
  };

  // Checkpoint IPC methods
  checkpoint: {
    get: (messageId: string) => Promise<CheckpointGetResponse>;
    restore: (messageId: string, type: 'before' | 'after', paths?: string[]) => Promise<CheckpointRestoreResponse>;
    getSettings: () => Promise<CheckpointSettingsGetResponse>;
    setSettings: (settings: Partial<CheckpointSettings>) => Promise<CheckpointSettingsSetResponse>;
    onSettingsChanged: (callback: (event: CheckpointSettingsChangedEvent) => void) => () => void;
    onStatusChanged: (callback: (event: CheckpointStatusEvent) => void) => () => void;
  };

  // Shell IPC methods
  shell: {
    revealInFinder: (path: string) => Promise<ShellRevealInFinderResponse>;
    copyFile: (path: string) => Promise<ShellCopyFileResponse>;
    cutFile: (path: string) => Promise<ShellCutFileResponse>;
  };

  // Conversation IPC methods
  conversations: {
    save: (request: ConversationSaveRequest) => Promise<ConversationSaveResponse>;
    load: (request: ConversationLoadRequest) => Promise<ConversationLoadResponse>;
    delete: (request: ConversationDeleteRequest) => Promise<ConversationDeleteResponse>;
    list: (request: ConversationListRequest) => Promise<ConversationListResponse>;
    listWithPreviews: (request: ConversationListWithPreviewsRequest) => Promise<ConversationListWithPreviewsResponse>;
  };

  // OfficeExtension IPC methods
  officeExtension: {
    convert: (request: OfficeExtensionConvertRequest) => Promise<OfficeExtensionConvertResponse>;
    download: (request: OfficeExtensionDownloadRequest) => Promise<OfficeExtensionDownloadResponse>;
    status: () => Promise<OfficeExtensionStatusResponse>;
    ensureRunning: () => Promise<OfficeExtensionEnsureRunningResponse>;
    checkInstalled: () => Promise<import('./ipc/registry').OfficeExtensionCheckInstalledResponse>;
    install: () => Promise<import('./ipc/registry').OfficeExtensionInstallResponse>;
    uninstall: () => Promise<import('./ipc/registry').OfficeExtensionUninstallResponse>;
    onInstallProgress: (callback: (event: import('./ipc/registry').OfficeExtensionInstallProgressEvent) => void) => () => void;
  };

  // VoiceExtension IPC methods
  voiceExtension: {
    checkInstalled: (request?: VoiceExtensionCheckInstalledRequest) => Promise<import('./ipc/registry').VoiceExtensionCheckInstalledResponse>;
    install: (request?: VoiceExtensionInstallRequest) => Promise<import('./ipc/registry').VoiceExtensionInstallResponse>;
    onInstallProgress: (callback: (event: import('./ipc/registry').VoiceExtensionInstallProgressEvent) => void) => () => void;
  };

  // Text-to-Speech IPC methods
  tts: {
    getSettings: () => Promise<TtsGetSettingsResponse>;
    setSettings: (request: TtsSetSettingsRequest) => Promise<TtsSetSettingsResponse>;
    listModels: () => Promise<TtsListModelsResponse>;
    installModel: (request: TtsInstallModelRequest) => Promise<TtsInstallModelResponse>;
    getVoices: (request?: TtsGetVoicesRequest) => Promise<TtsGetVoicesResponse>;
    speak: (request: TtsSpeakRequest) => Promise<TtsSpeakResponse>;
    onSettingsChanged: (callback: (event: TtsSettingsChangedEvent) => void) => () => void;
    onInstallProgress: (callback: (event: TtsInstallProgressEvent) => void) => () => void;
    onPlaybackRequested: (callback: (event: TtsPlaybackRequestedEvent) => void) => () => void;
  };

  // Speech-to-Text IPC methods
  stt: {
    getSettings: () => Promise<SttGetSettingsResponse>;
    setSettings: (request: SttSetSettingsRequest) => Promise<SttSetSettingsResponse>;
    onSettingsChanged: (callback: (event: SttSettingsChangedEvent) => void) => () => void;
  };

  // Browser IPC methods
  browser: {
    create: (id: string, url: string, browserId?: string, faviconUrl?: string) => Promise<BrowserCreateResponse>;
    navigate: (id: string, url: string) => Promise<BrowserNavigateResponse>;
    goBack: (id: string) => Promise<BrowserActionResponse>;
    goForward: (id: string) => Promise<BrowserActionResponse>;
    reload: (id: string) => Promise<BrowserActionResponse>;
    stop: (id: string) => Promise<BrowserActionResponse>;
    close: (id: string) => Promise<BrowserActionResponse>;
    getState: (id: string) => Promise<BrowserGetStateResponse>;
    attach: (id: string, windowId: number) => Promise<BrowserActionResponse>;
    detach: (id: string) => Promise<BrowserActionResponse>;
    setBounds: (id: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<BrowserActionResponse>;
    focus: (id: string) => Promise<BrowserActionResponse>;
    onEvent: (callback: (event: BrowserEvent) => void) => () => void;
    onTabCreated: (callback: (event: BrowserTabCreatedEvent) => void) => () => void;
    onTabClosed: (callback: (event: BrowserTabClosedEvent) => void) => () => void;
    getPersistedTabs: () => Promise<BrowserGetPersistedTabsResponse>;
  };

  browserControl: {
    getStatus: () => Promise<BrowserControlStatus>;
    getPolicy: () => Promise<BrowserControlGetPolicyResponse>;
    setPolicy: (policy: BrowserControlSetPolicyRequest['policy']) => Promise<BrowserControlSetPolicyResponse>;
    arrangeSplit: (request: BrowserControlArrangeSplitRequest) => Promise<BrowserControlArrangeSplitResponse>;
    activateTab: (request: BrowserControlActivateTabRequest) => Promise<BrowserControlActivateTabResponse>;
    onChanged: (callback: (event: BrowserControlChangedEvent) => void) => () => void;
  };

  // Locale IPC methods
  locale: {
    get: () => Promise<LocaleGetResponse>;
    set: (language: string) => Promise<LocaleSetResponse>;
    onChanged: (callback: (event: LocaleChangedEvent) => void) => () => void;
  };

  // Background Opacity IPC methods
  backgroundOpacity: {
    get: () => Promise<BackgroundOpacityGetResponse>;
    set: (opacity: number) => Promise<BackgroundOpacitySetResponse>;
    onChanged: (callback: (event: BackgroundOpacityChangedEvent) => void) => () => void;
  };

  // Zoom Factor IPC methods
  zoomFactor: {
    get: () => Promise<ZoomFactorGetResponse>;
    set: (zoomFactor: number) => Promise<ZoomFactorSetResponse>;
    onChanged: (callback: (event: ZoomFactorChangedEvent) => void) => () => void;
  };

  // Theme IPC methods
  theme: {
    get: () => Promise<ThemeGetResponse>;
    set: (theme: 'light' | 'dark' | 'system') => Promise<ThemeSetResponse>;
    onChanged: (callback: (event: ThemeChangedEvent) => void) => () => void;
  };

  // Primary Color IPC methods
  primaryColor: {
    get: () => Promise<PrimaryColorGetResponse>;
    set: (color: string) => Promise<PrimaryColorSetResponse>;
    onChanged: (callback: (event: PrimaryColorChangedEvent) => void) => () => void;
  };

  // UI Settings IPC methods (generated from BOOLEAN_UI_SETTINGS manifest)
  uiSettings: {
    [K in `get${Capitalize<import('../shared/booleanSettings').BooleanUISettingId>}`]:
      () => Promise<import('../shared/booleanSettings').BooleanSettingGetResponse>;
  } & {
    [K in `set${Capitalize<import('../shared/booleanSettings').BooleanUISettingId>}`]:
      (enabled: boolean) => Promise<import('../shared/booleanSettings').BooleanSettingSetResult>;
  } & {
    [K in `on${Capitalize<import('../shared/booleanSettings').BooleanUISettingId>}Changed`]:
      (callback: (event: import('../shared/booleanSettings').BooleanSettingChangedEvent) => void) => () => void;
  };

  // Window IPC methods
  window: {
    create: (request?: WindowCreateRequest) => Promise<WindowCreateResponse>;
    detachTab: (request: WindowDetachTabRequest) => Promise<WindowDetachTabResponse>;
    transferTabOut: (request: WindowTransferTabOutRequest) => Promise<WindowTransferTabOutResponse>;
    onFullscreenChanged: (callback: (event: WindowFullscreenChangedEvent) => void) => () => void;
  };

  // Tab navigation IPC methods (menu shortcuts)
  tabs: {
    onClose: (callback: () => void) => () => void;
    onNew: (callback: () => void) => () => void;
    onNext: (callback: () => void) => () => void;
    onPrevious: (callback: () => void) => () => void;
    onGoTo: (callback: (index: number) => void) => () => void;
  };

  // Quick actions IPC methods
  quickActions: {
    onQuickOpen: (callback: () => void) => () => void;
    onToggleExplorer: (callback: () => void) => () => void;
    onFocusAgent: (callback: () => void) => () => void;
    onNewAgent: (callback: () => void) => () => void;
    onNewSidebarAgent: (callback: () => void) => () => void;
    onOpenInbox: (callback: () => void) => () => void;
    onOpenSettings: (callback: () => void) => () => void;
  };

  // Workstation IPC methods (main -> renderer control events)
  workstation: {
    onOpenFile: (callback: (event: WorkstationOpenFileEvent) => void) => () => void;
    onOpenUrl: (callback: (event: WorkstationOpenUrlEvent) => void) => () => void;
    onCloseTab: (callback: (event: WorkstationCloseTabEvent) => void) => () => void;
    onFocusTab: (callback: (event: WorkstationFocusTabEvent) => void) => () => void;
    onToggleSidebar: (callback: (event: WorkstationToggleSidebarEvent) => void) => () => void;
  };

  appUpdate: {
    onReady: (callback: (event: AppUpdateReadyEvent) => void) => () => void;
    onChecking: (callback: () => void) => () => void;
    onUpToDate: (callback: () => void) => () => void;
    onError: (callback: (event: AppUpdateErrorEvent) => void) => () => void;
    install: () => Promise<AppUpdateInstallResponse>;
    checkNow: () => Promise<AppUpdateCheckNowResponse>;
  };

  // Tool Servers IPC methods
  toolServers: {
    getSnapshot: () => Promise<ToolServersChangedEvent | null>;
    onChanged: (callback: (event: ToolServersChangedEvent) => void) => () => void;
  };

  // Subagent Tool IPC methods
  subagentTools: {
    onToolCall: (callback: (event: SubagentToolCallEvent) => void) => () => void;
  };

  // Agent Notifications IPC methods
  agentNotifications: {
    onNotification: (callback: (event: AgentNotificationEvent) => void) => () => void;
  };
  appToasts: {
    onShow: (callback: (event: AppToastEvent) => void) => () => void;
  };

  // Programmatic Task IPC methods
  programmaticTasks: {
    startHeaded: (request: ProgrammaticTaskStartHeadedRequest) => Promise<ProgrammaticTaskStartHeadedResponse>;
    onStarted: (callback: (event: ProgrammaticTaskStartedEvent) => void) => () => void;
  };

  // Feedback IPC methods
  feedback: {
    submit: (request: FeedbackSubmitRequest) => Promise<FeedbackSubmitResponse>;
  };

  // Global Tools IPC methods
  globalTools: {
    list: () => Promise<GlobalToolsListResponse>;
    get: (serverId: string) => Promise<GlobalToolsGetResponse>;
    set: (serverId: string, enabled: boolean) => Promise<GlobalToolsSetResponse>;
    onChanged: (callback: (event: GlobalToolsChangedEvent) => void) => () => void;
  };

  auth: {
    onDeepLink: (callback: (event: AuthDeepLinkEvent) => void) => () => void;
  };

  // Terminal IPC methods
  terminal: {
    create: (cwd?: string) => Promise<TerminalCreateResponse>;
    write: (sessionId: string, data: string) => Promise<TerminalWriteResponse>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<TerminalResizeResponse>;
    close: (sessionId: string) => Promise<TerminalCloseResponse>;
    onData: (callback: (event: TerminalDataEvent) => void) => () => void;
    onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  };

  // Codex Server IPC methods
  codex: {
    request: (method: string, params: unknown) => Promise<unknown>;
    save_thread: (thread_id: string, items: unknown[]) => Promise<{ ok: boolean }>;
    load_thread: (thread_id: string) => Promise<CodexLoadThreadResponse>;
    list_threads: () => Promise<CodexListThreadsResponse>;
    on_event: (callback: (event: CodexEvent) => void) => () => void;
  };

  // Skills IPC methods
  skills: {
    list: (request?: SkillsListRequest) => Promise<SkillsListResponse>;
    delete: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
    reveal: (dirPath: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };

  // Desktop Notification IPC methods
  desktopNotification: {
    show: (request: DesktopNotificationShowRequest) => Promise<DesktopNotificationShowResponse>;
    onClicked: (callback: (event: DesktopNotificationClickedEvent) => void) => () => void;
  };
}

console.log('[Preload] Script loading...');

const agentTabCreateRequestedListeners = new Set<(request: AgentTabCreateRequestedEvent) => void>();
const agentTabSendRequestedListeners = new Set<(event: AgentTabSendRequestedEvent) => void>();
const agentTabStopRequestedListeners = new Set<(event: AgentTabStopRequestedEvent) => void>();

function dispatchAgentTabCreateRequested(request: AgentTabCreateRequestedEvent): void {
  for (const listener of agentTabCreateRequestedListeners) {
    listener(request);
  }
}

ipcRenderer.on(IPC_CHANNELS.AGENT_TAB_CREATE_REQUESTED, (_event, request: AgentTabCreateRequestedEvent) => {
  dispatchAgentTabCreateRequested(request);
});

ipcRenderer.on(IPC_CHANNELS.AGENT_TAB_SEND_REQUESTED, (_event, event: AgentTabSendRequestedEvent) => {
  for (const listener of agentTabSendRequestedListeners) {
    listener(event);
  }
});

ipcRenderer.on(IPC_CHANNELS.AGENT_TAB_STOP_REQUESTED, (_event, event: AgentTabStopRequestedEvent) => {
  for (const listener of agentTabStopRequestedListeners) {
    listener(event);
  }
});

async function replayPendingAgentTabCreateRequest(requestId?: string): Promise<void> {
  if (!requestId) return;
  const response = await ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_GET_PENDING) as AgentTabGetPendingResponse;
  const request = response.requests.find((candidate) => candidate.requestId === requestId);
  if (request) {
    dispatchAgentTabCreateRequested(request);
  }
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  getServerPort: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SERVER_PORT),
  getWindowId: () => ipcRenderer.invoke(IPC_CHANNELS.GET_WINDOW_ID),
  getWindowSessionKey: () => windowSessionKey,
  getWindowBootstrapLayout: () => windowBootstrapLayout,
  isPackaged: () => isPackagedApp,
  getPlatform: () => process.platform,
  getOsRelease: () => os.release(),
  isNativeMacTransparencyEnabled: () => !shouldDisableMacTransparency({
    platform: process.platform,
    disableMacTransparencyEnv: process.env.INTERPRETER_DISABLE_MAC_TRANSPARENCY,
    forceMacTransparencyEnv: process.env.INTERPRETER_FORCE_MAC_TRANSPARENCY,
    machineRunDirEnv: process.env.INTERPRETER_MACHINE_RUN_DIR,
  }),
  apiRequest: (request: ApiRequestParams) =>
    ipcRenderer.invoke(IPC_CHANNELS.API_REQUEST, request),
  shutdown: () => ipcRenderer.invoke(IPC_CHANNELS.SHUTDOWN),
  getInitialFileTree: () => ipcRenderer.invoke(IPC_CHANNELS.GET_INITIAL_FILE_TREE),
  log: (level: string, ...args: any[]) => ipcRenderer.send(IPC_CHANNELS.RENDERER_LOG, level, ...args),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  pathBasename: (filePath: string) => path.basename(filePath),
  pathDirname: (filePath: string) => path.dirname(filePath),
  pathJoin: (...segments: string[]) => path.join(...segments),
  pathResolve: (fromPath: string, toPath: string) => path.resolve(fromPath, toPath),
  pathSep: path.sep,
  pathIsAbsolute: (filePath: string) => path.isAbsolute(filePath),
  pathNormalize: (filePath: string) => path.normalize(filePath),
  pathRelative: (fromPath: string, toPath: string) => path.relative(fromPath, toPath),
  pathToFileURL: (filePath: string) => pathToFileURL(filePath).toString(),
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  openPathDialog: (options?: any) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PATH_DIALOG, options),
  savePathDialog: (options?: SavePathDialogOptions) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_PATH_DIALOG, options),
  writeClipboardText: (text: string) => {
    const request: ClipboardWriteTextRequest = { text };
    return ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, request);
  },
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  openPath: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PATH, filePath),
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, fullPath),
  showItemsInFolder: (fullPaths: string[]) => {
    const request: ShowItemsInFolderRequest = { paths: fullPaths };
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEMS_IN_FOLDER, request);
  },
  showContextMenu: (request: GenericContextMenuRequest) => ipcRenderer.invoke(IPC_CHANNELS.SHOW_CONTEXT_MENU, request),
  showSelect: (request: SelectRequest) => ipcRenderer.invoke(IPC_CHANNELS.SHOW_SELECT, request),
  desktopSources: {
    list: (request?: DesktopSourceListRequest) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SOURCES_LIST, request),
  },
  macTitlebarClicked: () => ipcRenderer.send(IPC_CHANNELS.MAC_TITLEBAR_CLICKED),
  rendererReady: () => ipcRenderer.send(IPC_CHANNELS.RENDERER_READY),

  // Approval IPC
  approvals: {
    onCreated: (callback: (event: ApprovalCreatedEvent) => void) => {
      const listener = (_: any, event: ApprovalCreatedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APPROVAL_CREATED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APPROVAL_CREATED, listener);
    },
    onResolved: (callback: (event: ApprovalResolvedEvent) => void) => {
      const listener = (_: any, event: ApprovalResolvedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APPROVAL_RESOLVED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APPROVAL_RESOLVED, listener);
    },
    onTimeout: (callback: (event: ApprovalTimeoutEvent) => void) => {
      const listener = (_: any, event: ApprovalTimeoutEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APPROVAL_TIMEOUT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APPROVAL_TIMEOUT, listener);
    },
    onListChanged: (callback: (event: ApprovalListChangedEvent) => void) => {
      const listener = (_: any, event: ApprovalListChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APPROVAL_LIST_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APPROVAL_LIST_CHANGED, listener);
    },
    get: (request: ApprovalGetRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_GET, request),
    approve: (request: ApprovalActionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_APPROVE, request),
    deny: (request: ApprovalActionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_DENY, request),
    respond: (request: ApprovalRespondRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_RESPOND, request),
  },

  runtime: {
    onRestarting: (callback: (event: RuntimeRestartingEvent) => void) => {
      const listener = (_: any, event: RuntimeRestartingEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.RUNTIME_RESTARTING, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNTIME_RESTARTING, listener);
    },
    onRestarted: (callback: (event: RuntimeRestartedEvent) => void) => {
      const listener = (_: any, event: RuntimeRestartedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.RUNTIME_RESTARTED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNTIME_RESTARTED, listener);
    },
  },

  // Agent Tab IPC
  agentTabs: {
    onCreateRequested: (callback: (request: AgentTabCreateRequestedEvent) => void) => {
      agentTabCreateRequestedListeners.add(callback);
      return () => {
        agentTabCreateRequestedListeners.delete(callback);
      };
    },
    onSendRequested: (callback: (event: AgentTabSendRequestedEvent) => void) => {
      agentTabSendRequestedListeners.add(callback);
      return () => {
        agentTabSendRequestedListeners.delete(callback);
      };
    },
    onStopRequested: (callback: (event: AgentTabStopRequestedEvent) => void) => {
      agentTabStopRequestedListeners.add(callback);
      return () => {
        agentTabStopRequestedListeners.delete(callback);
      };
    },
    created: (data: AgentTabCreatedRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_CREATED, data),
    completed: (data: AgentTabCompletedRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_COMPLETED, data),
    getPending: () =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_GET_PENDING),
    registerThread: (data: AgentTabRegisterThreadRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_REGISTER_THREAD, data),
    reportActivity: (data: AgentTabReportActivityRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_REPORT_ACTIVITY, data),
    disposeBinding: (data: AgentTabDisposeBindingRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_DISPOSE_BINDING, data),
    consumeStartup: (data: AgentTabConsumeStartupRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_TAB_CONSUME_STARTUP, data),
  },

  agentThreads: {
    deleteThread: (threadId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_THREADS_DELETE, { threadId }),
    deleteAll: () =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_THREADS_DELETE_ALL),
    renameThread: (threadId: string, name: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_THREADS_RENAME, { threadId, name }),
    archiveThread: (threadId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_THREADS_ARCHIVE, { threadId }),
    unarchiveThread: (threadId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_THREADS_UNARCHIVE, { threadId }),
  },

  // Profiles IPC
  profiles: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_LIST),
    get: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_GET, profileId),
    create: (profile: any) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_CREATE, profile),
    update: (profileId: string, updates: any) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_UPDATE, profileId, updates),
    delete: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_DELETE, profileId),
    setDefault: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SET_DEFAULT, profileId),
    setFast: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SET_FAST, profileId),
    reset: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILES_RESET, profileId),
    onChanged: (callback: (event: ProfilesChangedEvent) => void) => {
      const listener = (_: any, event: ProfilesChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PROFILES_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILES_CHANGED, listener);
    },
    onDefaultChanged: (callback: (event: ProfilesDefaultChangedEvent) => void) => {
      const listener = (_: any, event: ProfilesDefaultChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PROFILES_DEFAULT_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILES_DEFAULT_CHANGED, listener);
    },
    onConfigRecovered: (callback: (event: ProfilesConfigRecoveredEvent) => void) => {
      const listener = (_: any, event: ProfilesConfigRecoveredEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PROFILES_CONFIG_RECOVERED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILES_CONFIG_RECOVERED, listener);
    },
  },

  // Workspace IPC
  workspace: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET),
    createSample: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE_SAMPLE),
    set: (request: { workspacePath: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET, request),
    respondToConfirmation: (request: WorkspaceConfirmationRespondRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CONFIRMATION_RESPOND, request),
    rename: (request: { oldPath: string; newName: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RENAME, request),
    addWatch: (folderPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ADD_WATCH, folderPath),
    removeWatch: (folderPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE_WATCH, folderPath),
    onConfirmationRequested: (callback: (event: WorkspaceConfirmationRequestedEvent) => void) => {
      const listener = (_: any, event: WorkspaceConfirmationRequestedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSPACE_CONFIRMATION_REQUESTED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_CONFIRMATION_REQUESTED, listener);
    },
    onChanged: (callback: (event: { workspacePath: string | null }) => void) => {
      const listener = (_: any, event: { workspacePath: string | null }) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSPACE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_CHANGED, listener);
    },
    onFilesChanged: (callback: (event: WorkspaceFilesChangedEvent) => void) => {
      const listener = (_: any, event: WorkspaceFilesChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSPACE_FILES_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_FILES_CHANGED, listener);
    },
  },

  // Tool server CRUD + tool execution IPC
  servers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SERVERS_LIST),
    get: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.SERVERS_GET, serverId),
    add: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.SERVERS_ADD, config),
    startOAuth: (serverId: string, scopes?: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.SERVERS_START_OAUTH, serverId, scopes),
    update: (serverId: string, updates: any) =>
      ipcRenderer.invoke(IPC_CHANNELS.SERVERS_UPDATE, serverId, updates),
    delete: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.SERVERS_DELETE, serverId),
    toggle: (serverId: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.SERVERS_TOGGLE, serverId, enabled),
    callTool: (
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
      saveToDisk?: boolean,
      toolContext?: {
        profileId?: string;
        callerTabId?: string;
        workspace?: string;
        modelConfig?: import('../shared/types/model').AgentModelConfig;
      }
    ) => ipcRenderer.invoke(
      IPC_CHANNELS.SERVERS_CALL_TOOL,
      serverId,
      toolName,
      args,
      saveToDisk,
      toolContext,
    ),
  },

  // Setup IPC
  setup: {
    onCompleted: (callback: (event: SetupCompletedEvent) => void) => {
      const listener = (_: any, event: SetupCompletedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.SETUP_COMPLETED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SETUP_COMPLETED, listener);
    },
  },

  computerUseSetup: {
    onRequested: (callback: (event: ComputerUseSetupRequestedEvent) => void) => {
      const listener = (_: any, event: ComputerUseSetupRequestedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.COMPUTER_USE_SETUP_REQUESTED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.COMPUTER_USE_SETUP_REQUESTED, listener);
    },
    onStatusRequested: (callback: (event: import('./ipc/registry').ComputerUseSetupStatusRequestedEvent) => void) => {
      const listener = (_: any, event: import('./ipc/registry').ComputerUseSetupStatusRequestedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.COMPUTER_USE_SETUP_STATUS_REQUESTED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.COMPUTER_USE_SETUP_STATUS_REQUESTED, listener);
    },
  },

  overlaySettings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_GET),
    set: (settings: import('../apps/interpreter-overlay/shared/settings').InterpreterOverlaySettings) =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_SET, settings),
    getAccessState: (options?: { forceRefresh?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_GET_ACCESS_STATE, options),
    getPermissionStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_GET_PERMISSION_STATUS),
    requestAccessibilityPermission: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_REQUEST_ACCESSIBILITY_PERMISSION),
    requestScreenRecordingPermission: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_REQUEST_SCREEN_RECORDING_PERMISSION),
    openAccessibilitySettings: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_OPEN_ACCESSIBILITY_SETTINGS),
    openScreenRecordingSettings: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SETTINGS_OPEN_SCREEN_RECORDING_SETTINGS),
  },

  interpreterOverlay: {
    startWindowVoiceMode: (request?: import('./ipc/registry').InterpreterOverlayStartWindowVoiceRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.INTERPRETER_OVERLAY_START_WINDOW_VOICE, request),
    onOnboardingVoiceInterviewCompleted: (
      callback: (event: import('./ipc/registry').InterpreterOverlayOnboardingVoiceInterviewCompletedEvent) => void,
    ) => {
      const listener = (
        _event: any,
        data: import('./ipc/registry').InterpreterOverlayOnboardingVoiceInterviewCompletedEvent,
      ) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.INTERPRETER_OVERLAY_ONBOARDING_VOICE_INTERVIEW_COMPLETED, listener);
      return () => ipcRenderer.removeListener(
        IPC_CHANNELS.INTERPRETER_OVERLAY_ONBOARDING_VOICE_INTERVIEW_COMPLETED,
        listener,
      );
    },
  },

  // PDF IPC
  pdf: {
    updateFormData: (filePath: string, formData: { fields: Array<{ name: string; type: string; value: any }> }) => {
      const request: PdfUpdateFormDataRequest = { filePath, formData };
      return ipcRenderer.invoke(IPC_CHANNELS.PDF_UPDATE_FORM_DATA, request);
    },
    onFillField: (callback: (event: PdfFillFieldEvent) => void) => {
      const listener = (_: any, event: PdfFillFieldEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PDF_FILL_FIELD, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PDF_FILL_FIELD, listener);
    },
    readStructure: (filePath: string, page?: number) => {
      return ipcRenderer.invoke(IPC_CHANNELS.PDF_READ_STRUCTURE, { filePath, page });
    },
  },

  markdown: {
    onFormat: (callback: (action: string) => void) => {
      const listener = (_: any, action: string) => callback(action);
      ipcRenderer.on('markdown:format', listener);
      return () => ipcRenderer.removeListener('markdown:format', listener);
    },
  },

  // File IPC
  files: {
    onRefreshed: (callback: (event: FileRefreshedEvent) => void) => {
      const listener = (_: any, event: FileRefreshedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.FILE_REFRESHED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_REFRESHED, listener);
    },
    move: (sourcePath: string, destPath: string) => {
      const request: FilesMoveRequest = { sourcePath, destPath };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_MOVE, request);
    },
    rename: (path: string, newName: string) => {
      const request: FilesRenameRequest = { path, newName };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_RENAME, request);
    },
    delete: (path: string) => {
      const request: FilesDeleteRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_DELETE, request);
    },
    trash: (path: string) => {
      const request: FilesTrashRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_TRASH, request);
    },
    duplicate: (path: string) => {
      const request: FilesDuplicateRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_DUPLICATE, request);
    },
    copyPath: (path: string) => {
      const request: FilesCopyPathRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_COPY_PATH, request);
    },
    read: (path: string) => {
      const request: FilesReadRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_READ, request);
    },
    readBinary: (path: string) => {
      const request: FilesReadBinaryRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_READ_BINARY, request);
    },
    write: (path: string, content: string) => {
      const request: FilesWriteRequest = { path, content };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_WRITE, request);
    },
    writeBinary: (path: string, buffer: ArrayBuffer) => {
      const request: FilesWriteBinaryRequest = { path, buffer };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_WRITE_BINARY, request);
    },
    getThumbnails: (paths: string[], size?: number) => {
      const request: FilesGetThumbnailsRequest = { paths, size };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_GET_THUMBNAILS, request);
    },
    create: (type: 'note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie', workspacePath: string) => {
      const request: FilesCreateRequest = { type, workspacePath };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_CREATE, request);
    },
    createFolder: (parentPath: string, name?: string) => {
      const request: FilesCreateFolderRequest = { parentPath, name };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_CREATE_FOLDER, request);
    },
    createBookmark: (url: string, title: string, faviconUrl: string | undefined, destFolder: string) => {
      const request: FilesCreateBookmarkRequest = { url, title, faviconUrl, destFolder };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_CREATE_BOOKMARK, request);
    },
    copyExternal: (sourcePaths: string[], destFolder: string) => {
      const request: FilesCopyExternalRequest = { sourcePaths, destFolder };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_COPY_EXTERNAL, request);
    },
    isDirectory: (path: string) => {
      const request: FilesIsDirectoryRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_IS_DIRECTORY, request);
    },
    getStats: (path: string) => {
      const request: FilesGetStatsRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_GET_STATS, request);
    },
    listDirectory: (path: string) => {
      const request: FilesListDirectoryRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST_DIRECTORY, request);
    },
    startDrag: (filePath: string) => {
      const request: FilesStartDragRequest = { filePath };
      ipcRenderer.send(IPC_CHANNELS.FILES_START_DRAG, request);
    },
    downloadUrl: (url: string, suggestedFilename?: string) => {
      const request: FilesDownloadUrlRequest = { url, suggestedFilename };
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_DOWNLOAD_URL, request);
    },
    saveClipboardImage: (request: FilesSaveClipboardImageRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_SAVE_CLIPBOARD_IMAGE, request),
  },

  projectRunner: {
    start: (projectPath: string) => {
      const request: ProjectRunnerPathRequest = { projectPath };
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_RUNNER_START, request);
    },
    stop: (projectPath: string) => {
      const request: ProjectRunnerPathRequest = { projectPath };
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_RUNNER_STOP, request);
    },
    getStatus: (projectPath: string) => {
      const request: ProjectRunnerPathRequest = { projectPath };
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_RUNNER_GET_STATUS, request);
    },
    onChanged: (callback: (event: ProjectRunnerChangedEvent) => void) => {
      const listener = (_: any, event: ProjectRunnerChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PROJECT_RUNNER_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_RUNNER_CHANGED, listener);
    },
  },

  movie: {
    compileComponents: (request: MovieCompileComponentsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.MOVIE_COMPILE_COMPONENTS, request),
    exportProject: (request: MovieExportRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.MOVIE_EXPORT, request),
    cancelExport: (request: MovieCancelExportRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.MOVIE_EXPORT_CANCEL, request),
    onExportProgress: (callback: (event: MovieExportProgressEvent) => void) => {
      const listener = (_: any, event: MovieExportProgressEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.MOVIE_EXPORT_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MOVIE_EXPORT_PROGRESS, listener);
    },
  },

  // Checkpoint IPC
  checkpoint: {
    get: (messageId: string) => {
      return ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_GET, { messageId });
    },
    restore: (messageId: string, type: 'before' | 'after', paths?: string[]) => {
      return ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE, { messageId, type, paths });
    },
    getSettings: () => {
      return ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_SETTINGS_GET);
    },
    setSettings: (settings: Partial<CheckpointSettings>) => {
      return ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_SETTINGS_SET, { settings });
    },
    onSettingsChanged: (callback: (event: CheckpointSettingsChangedEvent) => void) => {
      const handler = (_event: unknown, data: CheckpointSettingsChangedEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CHECKPOINT_SETTINGS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHECKPOINT_SETTINGS_CHANGED, handler);
    },
    onStatusChanged: (callback: (event: CheckpointStatusEvent) => void) => {
      const handler = (_event: unknown, data: CheckpointStatusEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHECKPOINT_STATUS_CHANGED, handler);
    },
  },

  // Shell IPC
  shell: {
    revealInFinder: (path: string) => {
      const request: ShellRevealInFinderRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_REVEAL_IN_FINDER, request);
    },
    copyFile: (path: string) => {
      const request: ShellCopyFileRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_COPY_FILE, request);
    },
    cutFile: (path: string) => {
      const request: ShellCutFileRequest = { path };
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_CUT_FILE, request);
    },
  },

  // Conversation IPC
  conversations: {
    save: (request: ConversationSaveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SAVE, request),
    load: (request: ConversationLoadRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LOAD, request),
    delete: (request: ConversationDeleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, request),
    list: (request: ConversationListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST, request),
    listWithPreviews: (request: ConversationListWithPreviewsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST_WITH_PREVIEWS, request),
  },

  // OfficeExtension IPC
  officeExtension: {
    convert: (request: OfficeExtensionConvertRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_CONVERT, request),
    download: (request: OfficeExtensionDownloadRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_DOWNLOAD, request),
    status: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_STATUS),
    ensureRunning: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_ENSURE_RUNNING),
    checkInstalled: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_CHECK_INSTALLED),
    install: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_INSTALL),
    uninstall: () =>
      ipcRenderer.invoke(IPC_CHANNELS.OFFICE_EXTENSION_UNINSTALL),
    onInstallProgress: (callback: (event: import('./ipc/registry').OfficeExtensionInstallProgressEvent) => void) => {
      const handler = (_event: any, data: import('./ipc/registry').OfficeExtensionInstallProgressEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.OFFICE_EXTENSION_INSTALL_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.OFFICE_EXTENSION_INSTALL_PROGRESS, handler);
    },
  },

  // VoiceExtension IPC
  voiceExtension: {
    checkInstalled: (request?: VoiceExtensionCheckInstalledRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_EXTENSION_CHECK_INSTALLED, request ?? {}),
    install: (request?: VoiceExtensionInstallRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_EXTENSION_INSTALL, request ?? {}),
    onInstallProgress: (callback: (event: import('./ipc/registry').VoiceExtensionInstallProgressEvent) => void) => {
      const handler = (_event: any, data: import('./ipc/registry').VoiceExtensionInstallProgressEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.VOICE_EXTENSION_INSTALL_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_EXTENSION_INSTALL_PROGRESS, handler);
    },
  },

  // Text-to-Speech IPC
  tts: {
    getSettings: () =>
      ipcRenderer.invoke(IPC_CHANNELS.TTS_GET_SETTINGS),
    setSettings: (request: TtsSetSettingsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.TTS_SET_SETTINGS, request),
    listModels: () =>
      ipcRenderer.invoke(IPC_CHANNELS.TTS_LIST_MODELS),
    installModel: (request: TtsInstallModelRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.TTS_INSTALL_MODEL, request),
    getVoices: (request?: TtsGetVoicesRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.TTS_GET_VOICES, request ?? {}),
    speak: (request: TtsSpeakRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.TTS_SPEAK, request),
    onSettingsChanged: (callback: (event: TtsSettingsChangedEvent) => void) => {
      const handler = (_event: any, data: TtsSettingsChangedEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.TTS_SETTINGS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TTS_SETTINGS_CHANGED, handler);
    },
    onInstallProgress: (callback: (event: TtsInstallProgressEvent) => void) => {
      const handler = (_event: any, data: TtsInstallProgressEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.TTS_INSTALL_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TTS_INSTALL_PROGRESS, handler);
    },
    onPlaybackRequested: (callback: (event: TtsPlaybackRequestedEvent) => void) => {
      const handler = (_event: any, data: TtsPlaybackRequestedEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.TTS_PLAYBACK_REQUESTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TTS_PLAYBACK_REQUESTED, handler);
    },
  },

  // Speech-to-Text IPC
  stt: {
    getSettings: () =>
      ipcRenderer.invoke(IPC_CHANNELS.STT_GET_SETTINGS),
    setSettings: (request: SttSetSettingsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.STT_SET_SETTINGS, request),
    onSettingsChanged: (callback: (event: SttSettingsChangedEvent) => void) => {
      const handler = (_event: any, data: SttSettingsChangedEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.STT_SETTINGS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.STT_SETTINGS_CHANGED, handler);
    },
  },

  // Browser IPC
  browser: {
    create: (id: string, url: string, browserId?: string, faviconUrl?: string) => {
      const request: BrowserCreateRequest = { id, url, browserId, faviconUrl };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREATE, request);
    },
    navigate: (id: string, url: string) => {
      const request: BrowserNavigateRequest = { id, url };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE, request);
    },
    goBack: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GO_BACK, request);
    },
    goForward: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GO_FORWARD, request);
    },
    reload: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RELOAD, request);
    },
    stop: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STOP, request);
    },
    close: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE, request);
    },
    getState: (id: string) => {
      const request: BrowserGetStateRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_STATE, request);
    },
    attach: (id: string, windowId: number) => {
      const request: BrowserAttachRequest = { id, windowId };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ATTACH, request);
    },
    detach: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DETACH, request);
    },
    setBounds: (id: string, bounds: { x: number; y: number; width: number; height: number }) => {
      const request: BrowserSetBoundsRequest = { id, bounds };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_BOUNDS, request);
    },
    focus: (id: string) => {
      const request: BrowserIdRequest = { id };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FOCUS, request);
    },
    onEvent: (callback: (event: BrowserEvent) => void) => {
      const listener = (_: any, event: BrowserEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_EVENT, listener);
    },
    onTabCreated: (callback: (event: BrowserTabCreatedEvent) => void) => {
      const listener = (_: any, event: BrowserTabCreatedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_CREATED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_CREATED, listener);
    },
    onTabClosed: (callback: (event: BrowserTabClosedEvent) => void) => {
      const listener = (_: any, event: BrowserTabClosedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_CLOSED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_CLOSED, listener);
    },
    getPersistedTabs: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_PERSISTED_TABS),
  },

  browserControl: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CONTROL_GET_STATUS),
    getPolicy: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CONTROL_GET_POLICY),
    setPolicy: (policy: BrowserControlSetPolicyRequest['policy']) => {
      const request: BrowserControlSetPolicyRequest = { policy };
      return ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CONTROL_SET_POLICY, request);
    },
    arrangeSplit: (request: BrowserControlArrangeSplitRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CONTROL_ARRANGE_SPLIT, request),
    activateTab: (request: BrowserControlActivateTabRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CONTROL_ACTIVATE_TAB, request),
    onChanged: (callback: (event: BrowserControlChangedEvent) => void) => {
      const listener = (_: any, event: BrowserControlChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BROWSER_CONTROL_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_CONTROL_CHANGED, listener);
    },
  },

  locale: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.LOCALE_GET),
    set: (language: string) => {
      const request: LocaleSetRequest = { language };
      return ipcRenderer.invoke(IPC_CHANNELS.LOCALE_SET, request);
    },
    onChanged: (callback: (event: LocaleChangedEvent) => void) => {
      const listener = (_: any, event: LocaleChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.LOCALE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LOCALE_CHANGED, listener);
    },
  },

  backgroundOpacity: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_OPACITY_GET),
    set: (opacity: number) => {
      const request: BackgroundOpacitySetRequest = { opacity };
      return ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_OPACITY_SET, request);
    },
    onChanged: (callback: (event: BackgroundOpacityChangedEvent) => void) => {
      const listener = (_: any, event: BackgroundOpacityChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.BACKGROUND_OPACITY_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BACKGROUND_OPACITY_CHANGED, listener);
    },
  },

  zoomFactor: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_FACTOR_GET),
    set: (zoomFactor: number) => {
      const request: ZoomFactorSetRequest = { zoomFactor };
      return ipcRenderer.invoke(IPC_CHANNELS.ZOOM_FACTOR_SET, request);
    },
    onChanged: (callback: (event: ZoomFactorChangedEvent) => void) => {
      const listener = (_: any, event: ZoomFactorChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.ZOOM_FACTOR_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ZOOM_FACTOR_CHANGED, listener);
    },
  },

  theme: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_GET),
    set: (theme: 'light' | 'dark' | 'system') => {
      const request: ThemeSetRequest = { theme };
      return ipcRenderer.invoke(IPC_CHANNELS.THEME_SET, request);
    },
    onChanged: (callback: (event: ThemeChangedEvent) => void) => {
      const listener = (_: any, event: ThemeChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.THEME_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.THEME_CHANGED, listener);
    },
  },

  primaryColor: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.PRIMARY_COLOR_GET),
    set: (color: string) => {
      const request: PrimaryColorSetRequest = { color };
      return ipcRenderer.invoke(IPC_CHANNELS.PRIMARY_COLOR_SET, request);
    },
    onChanged: (callback: (event: PrimaryColorChangedEvent) => void) => {
      const listener = (_: any, event: PrimaryColorChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PRIMARY_COLOR_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PRIMARY_COLOR_CHANGED, listener);
    },
  },

  // UI Settings IPC (generated from boolean settings manifest)
  uiSettings: (() => {
    const { BOOLEAN_UI_SETTING_IDS, booleanSettingChannels, booleanSettingMethodNames } = require('../shared/booleanSettings');
    const methods: Record<string, any> = {};
    for (const id of BOOLEAN_UI_SETTING_IDS) {
      const ch = booleanSettingChannels(id);
      const names = booleanSettingMethodNames(id);
      methods[names.get] = () => ipcRenderer.invoke(ch.get);
      methods[names.set] = (enabled: boolean) => ipcRenderer.invoke(ch.set, { enabled });
      methods[names.onChanged] = (callback: (event: { enabled: boolean }) => void) => {
        const listener = (_: any, event: { enabled: boolean }) => callback(event);
        ipcRenderer.on(ch.changed, listener);
        return () => ipcRenderer.removeListener(ch.changed, listener);
      };
    }
    return methods;
  })(),

  // Window IPC
  window: {
    create: (request?: WindowCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CREATE, request),
    detachTab: (request: WindowDetachTabRequest) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_DETACH_TAB, request),
    transferTabOut: (request: WindowTransferTabOutRequest) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TRANSFER_TAB_OUT, request),
    onFullscreenChanged: (callback: (event: WindowFullscreenChangedEvent) => void) => {
      const listener = (_: any, event: WindowFullscreenChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, listener);
    },
  },

  // Tab navigation IPC (menu shortcuts)
  tabs: {
    onClose: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.TAB_CLOSE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_CLOSE, listener);
    },
    onNew: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.TAB_NEW, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_NEW, listener);
    },
    onNext: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.TAB_NEXT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_NEXT, listener);
    },
    onPrevious: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.TAB_PREVIOUS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_PREVIOUS, listener);
    },
    onGoTo: (callback: (index: number) => void) => {
      const listener = (_: any, index: number) => callback(index);
      ipcRenderer.on(IPC_CHANNELS.TAB_GO_TO, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_GO_TO, listener);
    },
  },

  // Quick actions IPC
  quickActions: {
    onQuickOpen: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.QUICK_OPEN, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.QUICK_OPEN, listener);
    },
    onToggleExplorer: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.TOGGLE_EXPLORER, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TOGGLE_EXPLORER, listener);
    },
    onFocusAgent: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.FOCUS_AGENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FOCUS_AGENT, listener);
    },
    onNewAgent: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.TAB_NEW, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_NEW, listener);
    },
    onNewSidebarAgent: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.NEW_SIDEBAR_AGENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NEW_SIDEBAR_AGENT, listener);
    },
    onOpenInbox: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.OPEN_INBOX, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.OPEN_INBOX, listener);
    },
    onOpenSettings: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.OPEN_SETTINGS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.OPEN_SETTINGS, listener);
    },
  },

  // Workstation IPC (main -> renderer control events)
  workstation: {
    onOpenFile: (callback: (event: WorkstationOpenFileEvent) => void) => {
      const listener = (_: any, event: WorkstationOpenFileEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSTATION_OPEN_FILE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSTATION_OPEN_FILE, listener);
    },
    onOpenUrl: (callback: (event: WorkstationOpenUrlEvent) => void) => {
      const listener = (_: any, event: WorkstationOpenUrlEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSTATION_OPEN_URL, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSTATION_OPEN_URL, listener);
    },
    onCloseTab: (callback: (event: WorkstationCloseTabEvent) => void) => {
      const listener = (_: any, event: WorkstationCloseTabEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSTATION_CLOSE_TAB, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSTATION_CLOSE_TAB, listener);
    },
    onFocusTab: (callback: (event: WorkstationFocusTabEvent) => void) => {
      const listener = (_: any, event: WorkstationFocusTabEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSTATION_FOCUS_TAB, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSTATION_FOCUS_TAB, listener);
    },
    onToggleSidebar: (callback: (event: WorkstationToggleSidebarEvent) => void) => {
      const listener = (_: any, event: WorkstationToggleSidebarEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.WORKSTATION_TOGGLE_SIDEBAR, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WORKSTATION_TOGGLE_SIDEBAR, listener);
    },
  },

  appUpdate: {
    onReady: (callback: (event: AppUpdateReadyEvent) => void) => {
      const listener = (_: any, event: AppUpdateReadyEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_READY, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_READY, listener);
    },
    onChecking: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_CHECKING, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_CHECKING, listener);
    },
    onUpToDate: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_UP_TO_DATE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_UP_TO_DATE, listener);
    },
    onError: (callback: (event: AppUpdateErrorEvent) => void) => {
      const listener = (_: any, event: AppUpdateErrorEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_ERROR, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_ERROR, listener);
    },
    install: () => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_INSTALL),
    checkNow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_CHECK_NOW),
  },

  // Tool Servers IPC
  toolServers: {
    getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_SERVERS_GET_SNAPSHOT),
    onChanged: (callback: (event: ToolServersChangedEvent) => void) => {
      const listener = (_: any, event: ToolServersChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.TOOL_SERVERS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TOOL_SERVERS_CHANGED, listener);
    },
  },

  // Subagent Tool IPC
  subagentTools: {
    onToolCall: (callback: (event: SubagentToolCallEvent) => void) => {
      const handler = (_: any, event: SubagentToolCallEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.SUBAGENT_TOOL_CALL, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SUBAGENT_TOOL_CALL, handler);
    },
  },

  // Agent Notifications IPC
  agentNotifications: {
    onNotification: (callback: (event: AgentNotificationEvent) => void) => {
      const handler = (_: any, event: AgentNotificationEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.AGENT_NOTIFICATION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_NOTIFICATION, handler);
    },
  },

  appToasts: {
    onShow: (callback: (event: AppToastEvent) => void) => {
      const handler = (_: any, event: AppToastEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.APP_TOAST_SHOW, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_TOAST_SHOW, handler);
    },
  },

  // Programmatic Tasks IPC
  programmaticTasks: {
    startHeaded: async (request: ProgrammaticTaskStartHeadedRequest) => {
      const response = await ipcRenderer.invoke(IPC_CHANNELS.PROGRAMMATIC_TASK_START_HEADED, request) as ProgrammaticTaskStartHeadedResponse;
      if (response.success && response.result?.requestId) {
        await replayPendingAgentTabCreateRequest(response.result.requestId);
      }
      return response;
    },
    onStarted: (callback: (event: ProgrammaticTaskStartedEvent) => void) => {
      const handler = (_: any, event: ProgrammaticTaskStartedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.PROGRAMMATIC_TASK_STARTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROGRAMMATIC_TASK_STARTED, handler);
    },
  },

  // Feedback IPC
  feedback: {
    submit: (request: FeedbackSubmitRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_SUBMIT, request),
  },

  // Global Tools IPC
  globalTools: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.GLOBAL_TOOLS_LIST),
    get: (serverId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GLOBAL_TOOLS_GET, { serverId }),
    set: (serverId: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.GLOBAL_TOOLS_SET, { serverId, enabled }),
    onChanged: (callback: (event: GlobalToolsChangedEvent) => void) => {
      const listener = (_: any, event: GlobalToolsChangedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.GLOBAL_TOOLS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.GLOBAL_TOOLS_CHANGED, listener);
    },
  },

  auth: {
    onDeepLink: (callback: (event: AuthDeepLinkEvent) => void) => {
      const listener = (_: any, event: AuthDeepLinkEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.AUTH_DEEP_LINK, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTH_DEEP_LINK, listener);
    },
  },

  // Terminal IPC
  terminal: {
    create: (cwd?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, { cwd }),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, { sessionId, cols, rows }),
    close: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CLOSE, { sessionId }),
    onData: (callback: (event: TerminalDataEvent) => void) => {
      const listener = (_: any, event: TerminalDataEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, listener);
    },
    onExit: (callback: (event: TerminalExitEvent) => void) => {
      const listener = (_: any, event: TerminalExitEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, listener);
    },
  },

  // Codex Server IPC
  codex: {
    request: (method: string, params: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.CODEX_REQUEST, method, params),
    save_thread: (thread_id: string, items: unknown[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.CODEX_SAVE_THREAD, thread_id, items),
    load_thread: (thread_id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CODEX_LOAD_THREAD, thread_id),
    list_threads: () =>
      ipcRenderer.invoke(IPC_CHANNELS.CODEX_LIST_THREADS),
    on_event: (callback: (event: CodexEvent) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: CodexEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.CODEX_EVENT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CODEX_EVENT, handler);
    },
  },
  // Skills IPC
  skills: {
    list: (request?: SkillsListRequest) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST, request),
    delete: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DELETE, dirPath),
    reveal: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_REVEAL, dirPath),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.SKILLS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SKILLS_CHANGED, listener);
    },
  },
  // Desktop Notification IPC
  desktopNotification: {
    show: (request: DesktopNotificationShowRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_NOTIFICATION_SHOW, request),
    onClicked: (callback: (event: DesktopNotificationClickedEvent) => void) => {
      const listener = (_: any, event: DesktopNotificationClickedEvent) => callback(event);
      ipcRenderer.on(IPC_CHANNELS.DESKTOP_NOTIFICATION_CLICKED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.DESKTOP_NOTIFICATION_CLICKED, listener);
    },
  },
} as unknown as ElectronAPI);

console.log('[Preload] Electron API exposed to window.electron');

// NOTE: Console capture for the renderer page happens in src/main.tsx, not here.
// With contextIsolation: true, overriding console here only affects the preload
// context, not the page context where React runs. The page uses window.electron.log()
// (exposed above) to forward console output to the main process log file.
