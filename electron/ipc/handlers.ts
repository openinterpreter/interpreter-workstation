/**
 * IPC Handlers
 *
 * Centralized IPC handler registration for the main process.
 * All ipcMain.handle and ipcMain.on registrations should be here.
 */

import { ipcMain, dialog, shell, BrowserWindow, systemPreferences, clipboard, WebContents, app, Notification, desktopCapturer, screen, type IpcMainInvokeEvent } from 'electron';
import { BOOLEAN_UI_SETTING_IDS, BOOLEAN_UI_SETTINGS, booleanSettingChannels, type BooleanSettingGetResponse, type BooleanSettingSetResult } from '../../shared/booleanSettings';
import { getInterpreterFeedbackUrl } from '../../shared/hostedApi';

// Type extension for WebContents.getOwnerBrowserWindow (exists at runtime but missing from types)
type WebContentsWithOwner = WebContents & { getOwnerBrowserWindow(): BrowserWindow | null };
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from './registry';
import { assertTrustedFileIpcFrame } from './trustedRenderer';
import type {
  ApiRequestParams,
  ApiRequestResponse,
  ApprovalGetRequest,
  ApprovalGetResponse,
  ApprovalActionRequest,
  ApprovalActionResponse,
  ApprovalRespondRequest,
  ApprovalRespondResponse,
  AgentTabCreatedRequest,
  AgentTabCreatedResponse,
  AgentTabCompletedRequest,
  AgentTabCompletedResponse,
  AgentTabConsumeStartupRequest,
  AgentTabConsumeStartupResponse,
  AgentTabDisposeBindingRequest,
  AgentTabDisposeBindingResponse,
  AgentTabGetPendingResponse,
  AgentTabRegisterThreadRequest,
  AgentTabRegisterThreadResponse,
  ProgrammaticTaskStartHeadedRequest,
  ProgrammaticTaskStartHeadedResponse,
  ShutdownResponse,
  OpenFolderDialogResponse,
  OpenPathDialogOptions,
  OpenPathDialogResponse,
  OpenPathResponse,
  SavePathDialogOptions,
  SavePathDialogResponse,
  ClipboardWriteTextRequest,
  ClipboardWriteTextResponse,
  ShowItemsInFolderRequest,
  DesktopSourceListRequest,
  DesktopSourceListResponse,
  GenericContextMenuItem,
  GenericContextMenuRequest,
  GenericContextMenuResponse,
  SelectRequest,
  SelectResponse,
  PdfUpdateFormDataRequest,
  PdfUpdateFormDataResponse,
  CheckpointGetRequest,
  CheckpointGetResponse,
  CheckpointRestoreRequest,
  CheckpointRestoreResponse,
  CheckpointSettingsGetResponse,
  CheckpointSettingsSetRequest,
  CheckpointSettingsSetResponse,
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
  FilesCreateFolderRequest,
  FilesCreateFolderResponse,
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
  FilesStartDragResponse,
  FilesSaveClipboardImageRequest,
  MovieCompileComponentsRequest,
  MovieCompileComponentsResponse,
  MovieCancelExportRequest,
  MovieCancelExportResponse,
  MovieExportRequest,
  MovieExportResponse,
  MovieExportProgressEvent,
  FilesDownloadUrlRequest,
  FilesDownloadUrlResponse,
  ProjectRunnerPathRequest,
  ProjectRunnerStartResponse,
  ProjectRunnerStopResponse,
  ProjectRunnerGetStatusResponse,
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
  ConversationWithPreview,
  ConversationDeleteRequest,
  ConversationDeleteResponse,
  SavedConversation,
  ConversationMetadata,
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
  BrowserGetPersistedTabsResponse,
  BrowserControlActivateTabRequest,
  BrowserControlActivateTabResponse,
  BrowserControlArrangeSplitRequest,
  BrowserControlArrangeSplitResponse,
  BrowserControlGetPolicyResponse,
  BrowserControlSetPolicyRequest,
  BrowserControlSetPolicyResponse,
  InterpreterOverlayStartWindowVoiceRequest,
  InterpreterOverlayStartWindowVoiceResponse,
  LocaleGetResponse,
  LocaleSetRequest,
  LocaleSetResponse,
  BackgroundOpacityGetResponse,
  BackgroundOpacitySetRequest,
  BackgroundOpacitySetResponse,
  ZoomFactorGetResponse,
  ZoomFactorSetRequest,
  ZoomFactorSetResponse,
  ThemeGetResponse,
  ThemeSetRequest,
  ThemeSetResponse,
  PrimaryColorGetResponse,
  PrimaryColorSetRequest,
  PrimaryColorSetResponse,
  CachedFileTree,
  WindowCreateRequest,
  WindowCreateResponse,
  WindowDetachTabRequest,
  WindowDetachTabResponse,
  FeedbackSubmitRequest,
  FeedbackSubmitResponse,
  GlobalToolsListResponse,
  GlobalToolsGetRequest,
  GlobalToolsGetResponse,
  GlobalToolsSetRequest,
  GlobalToolsSetResponse,
  AppUpdateInstallResponse,
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
  SttGetSettingsResponse,
  SttSetSettingsRequest,
  SttSetSettingsResponse,
} from './registry';

const TRANSIENT_SKILLS_LIST_ERROR_PATTERNS = [
  'codex app-server exited',
  'codex runtime disconnected',
] as const;
const TRANSIENT_SKILLS_LIST_LOG_INTERVAL_MS = 10_000;
let lastTransientSkillsListLogAt = 0;

function isTransientSkillsListError(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return TRANSIENT_SKILLS_LIST_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern));
}

import * as globalToolsHandlers from '../../server/handlers/globalTools';
import {
  ensureOfficeExtensionRunning,
  isOfficeExtensionRunning,
  convertFile as officeExtensionConvertFile,
  downloadFile as officeExtensionDownloadFile,
  getOfficeExtensionPort,
} from '../services/office-extension';
import { browserService } from '../services/browser';
import { workstationService } from '../services/workstation';
import { setElectronBroadcaster, type BroadcastScope } from '../../server/handlers/broadcast';
import * as settingsHandlers from '../../server/handlers/settings';
import * as approvalsHandlers from '../../server/handlers/approvals';
import * as agentTabsHandlers from '../../server/handlers/agentTabs';
import * as profilesHandlers from '../../server/handlers/profiles';
import * as toolServersHandlers from '../../server/handlers/toolServers';
import { checkpointManager } from '../../server/utils/checkpointManager';
import { DEFAULT_TTS_SETTINGS } from '../../shared/types/tts';
import { DEFAULT_STT_SETTINGS } from '../../shared/types/stt';
import { getCurrentWorkspace, runWithWorkspaceOverride } from '../../server/utils/workspace';
import { resolvePathWithWorkspace } from '../../server/utils/permissions';
import { getSandboxDir } from '../../server/utils/sandboxManager';
import { redactFeedbackMetadata } from '../utils/feedbackMetadata';
import { buildFeedbackLogAttachment } from '../utils/feedbackLogAttachment';
import { resolveDefaultLogDir } from '../utils/defaultLogPath';
import { getCurrentRuntimeLogFilePath } from '../utils/runtimeLogFile';
import { measureAsync, isPerfEnabled } from '../utils/perf';
import { sendToWindow } from '../utils/safeIpcSend';
import { installDownloadedUpdate, checkForUpdatesManually } from '../autoUpdater';
import { emitWorkspaceFilesChanged } from './events';
import { getBroadcastWindowIds as getScopedBroadcastWindowIds } from './broadcastWindowIds';
// Import manager instances (not types - they're classes with instances exported)
import type { approvalManager } from '../../server/approvalManager';

function normalizeRelativeDisplayPath(value: string): string {
  return path.sep === '/' ? value : value.split(path.sep).join('/');
}

function buildReferenceUpdateConfirmationEvent(options: {
  workspacePath: string;
  sourcePath: string;
  preparedRename: import('../../server/utils/vaultIndex').PreparedVaultRename;
  includeSourcePath?: boolean;
}): import('./registry').WorkspaceConfirmationRequestedEvent {
  const affectedPaths = Array.from(
    new Set([
      ...(options.includeSourcePath ? [options.sourcePath] : []),
      ...options.preparedRename.referringPaths,
    ]),
  );
  const detailItems = affectedPaths
    .map((filePath) => normalizeRelativeDisplayPath(path.relative(options.workspacePath, filePath)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const noteName = path.basename(options.sourcePath, path.extname(options.sourcePath));

  return {
    requestId: randomUUID(),
    workspacePath: options.workspacePath,
    title: 'Update Note References',
    message: `“${noteName}” is referenced elsewhere in this workspace. Should Interpreter update those references after the rename or move?`,
    permissionNote: 'Interpreter can rewrite markdown note references in these workspace files:',
    backupNote: 'This is limited to markdown files inside the current workspace. The rename or move still happens either way.',
    confirmLabel: 'Update References',
    cancelLabel: 'Leave References',
    detailItemsLabel: detailItems.length === 1 ? 'File to update' : 'Files to update',
    detailItems,
  };
}
import type { agentTabManager } from '../../server/agentTabManager';
import type { globalFileAccessResolver } from '../../server/globalFileAccessResolver';
import {
  getCurrentWindowSessionKey,
  getWindowSessionByKey,
  getWindowSessionKeyForWindowId,
  getWindowSessionWorkspace,
  listWindowSessions,
  runWithWindowSessionOverride,
  updateWindowSessionWorkspace,
} from '../../server/utils/windowSessions';
import type { LayoutState, Tab } from '../../shared/types/layout';

function stringifyRendererLogObject(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatRendererLogArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }
  if (
    arg === null
    || typeof arg === 'number'
    || typeof arg === 'boolean'
    || typeof arg === 'bigint'
    || typeof arg === 'symbol'
    || typeof arg === 'undefined'
  ) {
    return String(arg);
  }
  if (Array.isArray(arg)) {
    return stringifyRendererLogObject(arg);
  }
  if (typeof arg === 'object') {
    const record = arg as {
      __interpreterLogType?: unknown;
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      cause?: unknown;
    };
    if (record.__interpreterLogType === 'Error') {
      const name = typeof record.name === 'string' ? record.name : 'Error';
      const message = typeof record.message === 'string' ? record.message : '';
      const stack = typeof record.stack === 'string' ? record.stack : null;
      const cause = record.cause === undefined ? null : formatRendererLogArg(record.cause);
      const rendered = stack && stack.trim().length > 0
        ? stack
        : `${name}: ${message}`;
      return cause ? `${rendered}\nCaused by: ${cause}` : rendered;
    }
    return stringifyRendererLogObject(arg);
  }
  return String(arg);
}

const APP_SERVER_HOST = '127.0.0.1';

type FeedbackConfigDumpSection = {
  path: string | null;
  config: unknown;
  error?: string;
};

function feedbackDumpErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getFeedbackMetadataDump(): Promise<{
  interpreterConfigJson: FeedbackConfigDumpSection;
  codexUserConfigToml: FeedbackConfigDumpSection;
}> {
  const [{ loadConfig }, { resolveInterpreterConfigFile }, { getCodexClient }] = await Promise.all([
    import('../../server/configStore'),
    import('../../shared/interpreterConfigPaths'),
    import('../../server/utils/codexServiceBridge'),
  ]);

  const interpreterConfigPath = resolveInterpreterConfigFile();
  const [interpreterConfigResult, codexConfigResult] = await Promise.allSettled([
    loadConfig(),
    getCodexClient().configRead({ includeLayers: true }),
  ]);

  const interpreterConfigJson: FeedbackConfigDumpSection = interpreterConfigResult.status === 'fulfilled'
    ? {
        path: interpreterConfigPath,
        config: redactFeedbackMetadata(interpreterConfigResult.value),
      }
    : {
        path: interpreterConfigPath,
        config: null,
        error: feedbackDumpErrorMessage(interpreterConfigResult.reason),
      };

  let codexUserConfigToml: FeedbackConfigDumpSection;
  if (codexConfigResult.status === 'fulfilled') {
    const userLayer = codexConfigResult.value.layers?.find((layer) => layer.name.type === 'user');
    codexUserConfigToml = userLayer && 'file' in userLayer.name
      ? {
          path: userLayer.name.file,
          config: redactFeedbackMetadata(userLayer.config),
        }
      : {
          path: null,
          config: null,
          error: 'Codex user config layer unavailable',
        };
  } else {
    codexUserConfigToml = {
      path: null,
      config: null,
      error: feedbackDumpErrorMessage(codexConfigResult.reason),
    };
  }

  return {
    interpreterConfigJson,
    codexUserConfigToml,
  };
}

interface HandlerDependencies {
  serverPort: number;
  approvalManager: typeof approvalManager;
  agentTabManager: typeof agentTabManager;
  globalFileAccessResolver: typeof globalFileAccessResolver;
  cleanup: () => Promise<void>;
  cachedFileTree: CachedFileTree | null;
  getInterpreterOverlayService: () => {
    startWindowVoiceMode: (request?: InterpreterOverlayStartWindowVoiceRequest) => Promise<InterpreterOverlayStartWindowVoiceResponse>;
  } | null;
  createWorkstationWindow: (options?: {
    sourceWindowId?: number | null;
    workspacePath?: string | null;
    bootstrapLayout?: LayoutState | null;
    background?: boolean;
  }) => Promise<{ success: true; windowId: number; sessionKey: string } | { success: false; error: string }>;
}

async function showItemsInFolder(paths: string[]): Promise<void> {
  const normalizedPaths = Array.from(new Set(
    paths
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
      .map((candidate) => path.normalize(candidate)),
  ));

  if (normalizedPaths.length === 0) {
    return;
  }

  if (process.platform !== 'darwin') {
    shell.showItemInFolder(normalizedPaths[0]);
    return;
  }

  const pathsByDirectory = new Map<string, string[]>();
  for (const filePath of normalizedPaths) {
    const directoryPath = path.dirname(filePath);
    const existingPaths = pathsByDirectory.get(directoryPath);
    if (existingPaths) {
      existingPaths.push(filePath);
    } else {
      pathsByDirectory.set(directoryPath, [filePath]);
    }
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  for (const groupedPaths of pathsByDirectory.values()) {
    if (groupedPaths.length === 1) {
      shell.showItemInFolder(groupedPaths[0]);
      continue;
    }

    const targetItems = groupedPaths
      .map((filePath) => `POSIX file ${JSON.stringify(filePath)}`)
      .join(', ');

    await execFileAsync('osascript', [
      '-e', `set targetItems to {${targetItems}}`,
      '-e', 'tell application "Finder"',
      '-e', 'activate',
      '-e', 'reveal targetItems',
      '-e', 'set selection to targetItems',
      '-e', 'end tell',
    ]);
  }
}

/**
 * Set up all IPC handlers
 * Call this once during app initialization
 */
export function setupIpcHandlers(deps: HandlerDependencies): void {
  const {
    serverPort,
    approvalManager,
    agentTabManager,
    globalFileAccessResolver,
    cleanup,
    cachedFileTree,
    getInterpreterOverlayService,
    createWorkstationWindow,
  } = deps;

  function assertTrustedFileIpcSender(event: IpcMainInvokeEvent): void {
    const senderFrame = event.senderFrame;
    const frameUrl = senderFrame?.url ?? '';
    const isMainFrame = senderFrame === senderFrame?.top;
    assertTrustedFileIpcFrame(frameUrl, isMainFrame);
  }

  function getEventWindowId(event: IpcMainInvokeEvent): number | null {
    return BrowserWindow.fromWebContents(event.sender)?.id ?? null;
  }

  async function runWithSenderWindowContext<T>(
    event: IpcMainInvokeEvent,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const windowId = getEventWindowId(event);
    const sessionKey = getWindowSessionKeyForWindowId(windowId);
    const workspacePath = getWindowSessionWorkspace({ windowId });

    return await runWithWindowSessionOverride(sessionKey, async () => {
      return await runWithWorkspaceOverride(workspacePath, async () => {
        return await fn();
      });
    });
  }

  function registerHandle<TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
  ): void {
    ipcMain.handle(channel, async (event, ...args: TArgs): Promise<TResult> => {
      return await runWithSenderWindowContext(event, async () => {
        return await handler(event, ...args);
      });
    });
  }

  function getBroadcastWindowIds(scope?: BroadcastScope): number[] {
    return getScopedBroadcastWindowIds(
      scope,
      listWindowSessions(),
      BrowserWindow.getAllWindows(),
    );
  }

  function buildDetachedWindowLayout(tab: Tab): LayoutState {
    return {
      version: 6,
      tree: {
        kind: 'pane',
        id: 'detached-root',
        tabIds: [tab.id],
        activeTabId: tab.id,
      },
      tabs: {
        [tab.id]: tab,
      },
      activePaneId: 'detached-root',
      activeTabRegion: 'main',
      sidebarPane: null,
      sidebarWidth: 320,
      sidebarOpen: false,
      leftSidebar: {
        isOpen: false,
        width: 320,
        activeTab: 'explorer',
      },
      rightSidebar: {
        isOpen: false,
        width: 320,
      },
    };
  }

  function getCurrentBroadcastScope(): BroadcastScope | undefined {
    const currentWindowSessionKey = getCurrentWindowSessionKey();
    if (currentWindowSessionKey) {
      return { windowSessionKey: currentWindowSessionKey };
    }

    const currentWorkspacePath = getCurrentWorkspace();
    if (currentWorkspacePath !== null) {
      return { workspacePath: currentWorkspacePath };
    }

    return undefined;
  }

  function emitWorkspaceFilesChangedForCurrentContext(
    eventType: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change',
    changedPath?: string,
    mtime?: number,
  ): void {
    const scope = getCurrentBroadcastScope();
    const payload = { eventType, path: changedPath, mtime };
    const targetWindowIds = getBroadcastWindowIds(scope);
    targetWindowIds.forEach((windowId) => {
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) {
        emitWorkspaceFilesChanged(win, eventType, changedPath, mtime);
      }
    });
  }

  // ============================================================================
  // Register Electron Broadcaster (for unified event broadcasting)
  // ============================================================================
  setElectronBroadcaster((channel: string, data: unknown, scope?: BroadcastScope) => {
    // Update macOS dock badge when approval count changes
    if (channel === IPC_CHANNELS.APPROVAL_LIST_CHANGED && process.platform === 'darwin' && app.dock) {
      const { count } = data as { count: number };
      try {
        app.dock.setBadge(count > 0 ? String(count) : '');
      } catch {}
    }

    const targetWindowIds = getBroadcastWindowIds(scope);
    targetWindowIds.forEach((windowId) => {
      workstationService.sendToWindowWhenReady(windowId, channel, data);
    });
  });

  // ============================================================================
  // General Handlers
  // ============================================================================

  /**
   * Get the server port
   */
  registerHandle(IPC_CHANNELS.GET_SERVER_PORT, (): number => {
    return serverPort;
  });

  ipcMain.on(IPC_CHANNELS.RENDERER_READY, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow) {
      workstationService.markRendererReady(senderWindow.id);
    }
  });

  /**
   * Get the window ID of the sender's window
   */
  registerHandle(IPC_CHANNELS.GET_WINDOW_ID, (event): number => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.id ?? 1;
  });

  /**
   * Generic API request handler - forwards HTTP-like requests to Express server
   */
  registerHandle(
    IPC_CHANNELS.API_REQUEST,
    async (event, params: ApiRequestParams): Promise<ApiRequestResponse> => {
      return new Promise((resolve, reject) => {
        const url = `http://${APP_SERVER_HOST}:${serverPort}${params.path}`;
        const senderWindowId = getEventWindowId(event);
        const senderSessionKey = getWindowSessionKeyForWindowId(senderWindowId);

        const options: any = {
          method: params.method,
          headers: {
            'Content-Type': 'application/json',
            ...(senderSessionKey ? { 'x-interpreter-window-session': senderSessionKey } : {}),
          },
        };

        const req = http.request(url, options, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const response: ApiRequestResponse = {
                ok: res.statusCode! >= 200 && res.statusCode! < 300,
                status: res.statusCode!,
                data: data ? JSON.parse(data) : null,
              };
              resolve(response);
            } catch (err) {
              reject(err);
            }
          });
        });

        req.on('error', (err) => {
          resolve({
            ok: false,
            status: 503,
            data: { error: 'Server is starting up, please wait...' },
          });
        });

        if (params.body) {
          req.write(JSON.stringify(params.body));
        }
        req.end();
      });
    }
  );

  /**
   * Shutdown handler for tests
   */
  registerHandle(IPC_CHANNELS.SHUTDOWN, async (): Promise<ShutdownResponse> => {
    console.log('Received shutdown request via IPC');
    await cleanup();
    return { success: true };
  });

  registerHandle(IPC_CHANNELS.APP_UPDATE_INSTALL, (): AppUpdateInstallResponse => {
    const success = installDownloadedUpdate();
    return { success };
  });

  registerHandle(IPC_CHANNELS.APP_UPDATE_CHECK_NOW, async () => {
    const success = await checkForUpdatesManually();
    return { success };
  });

  /**
   * Get cached file tree for instant loading
   * Returns the file tree cached from previous session (if available)
   */
  registerHandle(IPC_CHANNELS.GET_INITIAL_FILE_TREE, (): CachedFileTree | null => {
    return cachedFileTree;
  });

  registerHandle(
    IPC_CHANNELS.WINDOW_CREATE,
    async (event, request?: WindowCreateRequest): Promise<WindowCreateResponse> => {
      const senderWindowId = getEventWindowId(event);
      const senderWorkspace = getWindowSessionWorkspace({ windowId: senderWindowId });
      const result = await createWorkstationWindow({
        sourceWindowId: senderWindowId,
        workspacePath: request?.workspacePath ?? senderWorkspace,
        background: request?.background === true,
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        windowId: result.windowId,
        sessionKey: result.sessionKey,
      };
    },
  );

  registerHandle(
    IPC_CHANNELS.WINDOW_DETACH_TAB,
    async (event, request: WindowDetachTabRequest): Promise<WindowDetachTabResponse> => {
      const senderWindowId = getEventWindowId(event);
      const result = await createWorkstationWindow({
        sourceWindowId: senderWindowId,
        workspacePath: request.workspacePath,
        bootstrapLayout: buildDetachedWindowLayout(request.tab),
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        windowId: result.windowId,
        sessionKey: result.sessionKey,
      };
    },
  );

  registerHandle(
    IPC_CHANNELS.WINDOW_TRANSFER_TAB_OUT,
    async (_event, request: import('./registry').WindowTransferTabOutRequest): Promise<import('./registry').WindowTransferTabOutResponse> => {
      const sourceWindowId = getWindowSessionByKey(request.sourceSessionKey)?.windowId ?? null;
      const sourceWindow = sourceWindowId ? BrowserWindow.fromId(sourceWindowId) : null;
      if (!sourceWindow || sourceWindow.isDestroyed()) {
        return { success: false, error: 'Source window not found.' };
      }

      try {
        const transferred = await sourceWindow.webContents.executeJavaScript(
          `window.__layoutContext?.transferTabOut?.(${JSON.stringify(request.tabId)}) ?? false`,
          true,
        );
        if (!transferred) {
          return { success: false, error: 'Source tab could not be transferred out.' };
        }
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Window transfer tab out error:', error);
        return { success: false, error: error.message };
      }
    },
  );

  /**
   * Get current workspace
   */
  registerHandle(
    IPC_CHANNELS.WORKSPACE_GET,
    async (): Promise<{ workspace: string | null }> => {
      const { getWorkspace } = await import('../../server/handlers/workspace');
      return getWorkspace();
    }
  );

  registerHandle(
    IPC_CHANNELS.WORKSPACE_CREATE_SAMPLE,
    async (): Promise<import('./registry').WorkspaceCreateSampleResponse> => {
      const { createSampleWorkspace } = await import('../../server/handlers/workspace');
      return createSampleWorkspace();
    }
  );

  /**
   * Set workspace and emit change event
   * Uses shared function that handles the renderer confirmation flow
   */
  registerHandle(
    IPC_CHANNELS.WORKSPACE_SET,
    async (event, request: { workspacePath: string }): Promise<{ success: boolean }> => {
      const { setWorkspaceWithConfirmation } = await import('./workspaceConfirmation');
      const confirmed = await setWorkspaceWithConfirmation(request.workspacePath, {
        windowId: getEventWindowId(event),
      });
      return { success: confirmed };
    }
  );

  registerHandle(
    IPC_CHANNELS.WORKSPACE_CONFIRMATION_RESPOND,
    async (
      _event,
      request: { requestId: string; approved: boolean }
    ): Promise<{ success: boolean }> => {
      const { respondToWorkspaceConfirmation } = await import('./workspaceConfirmation');
      return {
        success: respondToWorkspaceConfirmation(request.requestId, request.approved),
      };
    }
  );

  /**
   * Rename workspace folder
   */
  registerHandle(
    IPC_CHANNELS.WORKSPACE_RENAME,
    async (
      event,
      request: { oldPath: string; newName: string }
    ): Promise<{ success: boolean; newPath?: string; error?: string }> => {
      const { renameWorkspace, saveLastWorkspace } = await import('../../server/workspacePersistence');
      const { setCurrentWorkspace } = await import('../../server/utils/workspace');
      const { bindWindowSessionWorkspace } = await import('../../server/workspaceWatchRegistry');
      const { broadcastEvent } = await import('../../server/handlers/broadcast');

      const newPath = await renameWorkspace(request.oldPath, request.newName);
      if (newPath) {
        setCurrentWorkspace(newPath);
        await saveLastWorkspace(newPath);
        const matchingSessions = listWindowSessions().filter((record) => record.workspacePath === request.oldPath);
        await Promise.all(matchingSessions.map(async (record) => {
          updateWindowSessionWorkspace(record.sessionKey, newPath);
          await bindWindowSessionWorkspace(record.sessionKey, newPath);
        }));

        const senderWindowId = getEventWindowId(event);
        const senderSessionKey = getWindowSessionKeyForWindowId(senderWindowId);
        broadcastEvent(
          IPC_CHANNELS.WORKSPACE_CHANGED,
          { workspacePath: newPath },
          matchingSessions.length > 0
            ? { workspacePath: newPath }
            : senderSessionKey
              ? { windowSessionKey: senderSessionKey }
              : undefined,
        );

        console.log('[IPC] Workspace renamed to:', newPath);
        return { success: true, newPath };
      }
      return { success: false, error: 'Failed to rename workspace' };
    }
  );

  /**
   * Add folder to file watcher (when expanded in explorer)
   */
  registerHandle(
    IPC_CHANNELS.WORKSPACE_ADD_WATCH,
    async (_event, folderPath: string): Promise<{ success: boolean }> => {
      const { addWatch } = await import('../../server/handlers/workspace');
      return addWatch(folderPath);
    }
  );

  /**
   * Remove folder from file watcher (when collapsed in explorer)
   */
  registerHandle(
    IPC_CHANNELS.WORKSPACE_REMOVE_WATCH,
    async (_event, folderPath: string): Promise<{ success: boolean }> => {
      const { removeWatch } = await import('../../server/handlers/workspace');
      return removeWatch(folderPath);
    }
  );

  // ============================================================================
  // Tool Server Handlers
  // ============================================================================

  registerHandle(IPC_CHANNELS.TOOL_SERVERS_GET_SNAPSHOT, async () => {
    return toolServersHandlers.getToolServersSnapshot();
  });

  registerHandle(IPC_CHANNELS.SERVERS_LIST, async () => {
    const startedAt = Date.now();
    console.log('[ipc:servers] list start');
    try {
      const result = await toolServersHandlers.listToolServers();
      console.log(`[ipc:servers] list done durationMs=${Date.now() - startedAt} count=${result.servers.length}`);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ipc:servers] list failed durationMs=${Date.now() - startedAt} error=${message}`, error);
      throw error;
    }
  });

  registerHandle(IPC_CHANNELS.SERVERS_GET, async (_event, serverId: string) => {
    return toolServersHandlers.getToolServer(serverId);
  });

  registerHandle(IPC_CHANNELS.SERVERS_ADD, async (_event, config: any) => {
    const startedAt = Date.now();
    console.log(`[ipc:servers] add start name=${config?.name ?? 'unknown'}`);
    try {
      const result = await toolServersHandlers.addToolServer(config);
      console.log(
        `[ipc:servers] add done durationMs=${Date.now() - startedAt} name=${config?.name ?? 'unknown'} serverId=${result.serverId}`,
      );
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ipc:servers] add failed durationMs=${Date.now() - startedAt} name=${config?.name ?? 'unknown'} error=${message}`,
        error,
      );
      throw error;
    }
  });

  registerHandle(IPC_CHANNELS.SERVERS_START_OAUTH, async (_event, serverId: string, scopes?: string[]) => {
    const startedAt = Date.now();
    console.log(`[ipc:servers] oauth start serverId=${serverId} scopes=${scopes?.length ?? 0}`);
    try {
      const result = await toolServersHandlers.startToolServerOAuth(serverId, scopes);
      console.log(`[ipc:servers] oauth done durationMs=${Date.now() - startedAt} serverId=${serverId}`);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ipc:servers] oauth failed durationMs=${Date.now() - startedAt} serverId=${serverId} error=${message}`,
        error,
      );
      throw error;
    }
  });

  registerHandle(IPC_CHANNELS.SERVERS_UPDATE, async (_event, serverId: string, updates: any) => {
    return toolServersHandlers.updateToolServer(serverId, updates);
  });

  registerHandle(IPC_CHANNELS.SERVERS_DELETE, async (_event, serverId: string) => {
    const startedAt = Date.now();
    console.log(`[ipc:servers] delete start serverId=${serverId}`);
    try {
      const result = await toolServersHandlers.deleteToolServer(serverId);
      console.log(`[ipc:servers] delete done durationMs=${Date.now() - startedAt} serverId=${serverId}`);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ipc:servers] delete failed durationMs=${Date.now() - startedAt} serverId=${serverId} error=${message}`,
        error,
      );
      throw error;
    }
  });

  registerHandle(IPC_CHANNELS.SERVERS_TOGGLE, async (_event, serverId: string, enabled: boolean) => {
    const startedAt = Date.now();
    console.log(`[ipc:servers] toggle start serverId=${serverId} enabled=${enabled}`);
    try {
      const result = await toolServersHandlers.toggleToolServer(serverId, enabled);
      console.log(`[ipc:servers] toggle done durationMs=${Date.now() - startedAt} serverId=${serverId} enabled=${enabled}`);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ipc:servers] toggle failed durationMs=${Date.now() - startedAt} serverId=${serverId} enabled=${enabled} error=${message}`,
        error,
      );
      throw error;
    }
  });

  registerHandle(
    IPC_CHANNELS.SERVERS_CALL_TOOL,
    async (
      event,
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
      saveToDisk?: boolean,
      toolContext?: {
        profileId?: string;
        callerTabId?: string;
        workspace?: string;
        modelConfig?: import('../../shared/types/model').AgentModelConfig;
      },
    ) => {
      assertTrustedFileIpcSender(event);
      return toolServersHandlers.callTool(serverId, toolName, args, saveToDisk, toolContext);
    }
  );

  /**
   * Renderer log handler
   * Forwards renderer console logs to main process
   */
  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, level: string, ...args: any[]) => {
    // Format message with [RENDERER] prefix
    const message = args
      .map((arg) => formatRendererLogArg(arg))
      .join(' ');

    // Route to appropriate console method (which is overridden by logger)
    switch (level.toUpperCase()) {
      case 'ERROR':
        console.error(`[RENDERER] ${message}`);
        break;
      case 'WARN':
        console.warn(`[RENDERER] ${message}`);
        break;
      case 'INFO':
        console.info(`[RENDERER] ${message}`);
        break;
      case 'DEBUG':
        console.log(`[RENDERER:DEBUG] ${message}`);
        break;
      case 'LOG':
      default:
        console.log(`[RENDERER] ${message}`);
        break;
    }
  });

  /**
   * Open folder dialog
   */
  registerHandle(
    IPC_CHANNELS.OPEN_FOLDER_DIALOG,
    async (): Promise<OpenFolderDialogResponse> => {
      const properties: Electron.OpenDialogOptions['properties'] = ['openDirectory'];
      if (process.platform === 'darwin') {
        properties.push('createDirectory');
      }

      const result = await dialog.showOpenDialog({
        properties,
      });
      return result;
    }
  );

  registerHandle(
    IPC_CHANNELS.OPEN_PATH_DIALOG,
    async (_event, options?: OpenPathDialogOptions): Promise<OpenPathDialogResponse> => {
      const properties: Electron.OpenDialogOptions['properties'] = [];
      if (options?.type === 'folder') {
        properties.push('openDirectory');
      } else if (options?.type === 'both') {
        properties.push('openFile', 'openDirectory');
      } else {
        properties.push('openFile');
      }
      if (process.platform === 'darwin' && properties.includes('openDirectory')) {
        properties.push('createDirectory');
      }
      const result = await dialog.showOpenDialog({
        properties,
        defaultPath: options?.defaultPath,
        title: options?.title,
      });
      return result;
    }
  );

  registerHandle(
    IPC_CHANNELS.SAVE_PATH_DIALOG,
    async (_event, options?: SavePathDialogOptions): Promise<SavePathDialogResponse> => {
      const result = await dialog.showSaveDialog({
        defaultPath: options?.defaultPath,
        title: options?.title,
        buttonLabel: options?.buttonLabel,
        filters: options?.filters,
      });

      return {
        canceled: result.canceled,
        filePath: result.filePath,
      };
    },
  );

  registerHandle(
    IPC_CHANNELS.DESKTOP_SOURCES_LIST,
    async (event, request?: DesktopSourceListRequest): Promise<DesktopSourceListResponse> => {
      assertTrustedFileIpcSender(event);
      const sources = await desktopCapturer.getSources({
        types: request?.types ?? ['screen'],
        thumbnailSize: request?.thumbnailSize ?? { width: 480, height: 270 },
      });

      return {
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          kind: 'screen',
          displayId: source.display_id,
          thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
        })),
      };
    },
  );

  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_GET, async () => {
    return settingsHandlers.getInterpreterOverlaySettings();
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_SET, async (_event, settings: import('../../apps/interpreter-overlay/shared/settings').InterpreterOverlaySettings) => {
    return settingsHandlers.setInterpreterOverlaySettings(settings);
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_GET_ACCESS_STATE, async (_event, options?: { forceRefresh?: boolean }) => {
    return settingsHandlers.getInterpreterOverlaySettingsAccessState(options);
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_GET_PERMISSION_STATUS, async () => {
    return settingsHandlers.getInterpreterOverlayPermissionStatus();
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_REQUEST_ACCESSIBILITY_PERMISSION, async () => {
    return settingsHandlers.requestInterpreterOverlayAccessibilityPermission();
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_REQUEST_SCREEN_RECORDING_PERMISSION, async () => {
    return settingsHandlers.requestInterpreterOverlayScreenRecordingPermission();
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_OPEN_ACCESSIBILITY_SETTINGS, async () => {
    return settingsHandlers.openInterpreterOverlayAccessibilitySettings();
  });
  registerHandle(IPC_CHANNELS.OVERLAY_SETTINGS_OPEN_SCREEN_RECORDING_SETTINGS, async () => {
    return settingsHandlers.openInterpreterOverlayScreenRecordingSettings();
  });
  registerHandle(
    IPC_CHANNELS.INTERPRETER_OVERLAY_START_WINDOW_VOICE,
    async (
      _event,
      request?: InterpreterOverlayStartWindowVoiceRequest,
    ): Promise<InterpreterOverlayStartWindowVoiceResponse> => {
      const service = getInterpreterOverlayService();
      if (!service) {
        return { success: false, error: 'Interpreter Overlay is not ready.' };
      }
      return service.startWindowVoiceMode(request);
    },
  );

  /**
   * Open external URL
   */
  registerHandle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url: string): Promise<void> => {
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_PATH, async (_event, filePath: string): Promise<OpenPathResponse> => {
    const error = await shell.openPath(filePath);
    return { error: error || null };
  });

  /**
   * Write text to the system clipboard
   */
  registerHandle(
    IPC_CHANNELS.CLIPBOARD_WRITE_TEXT,
    async (_event, request: ClipboardWriteTextRequest): Promise<ClipboardWriteTextResponse> => {
      try {
        clipboard.writeText(request.text);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error writing text to clipboard:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Show item in Finder/File Explorer
   */
  registerHandle(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, async (_event, fullPath: string): Promise<void> => {
    shell.showItemInFolder(fullPath);
  });

  registerHandle(
    IPC_CHANNELS.SHOW_ITEMS_IN_FOLDER,
    async (_event, request: ShowItemsInFolderRequest): Promise<void> => {
      await showItemsInFolder(request.paths);
    },
  );

  /**
   * Show generic context menu - unified API for all context menus
   * Takes menu items and returns the action string of the clicked item (or null if dismissed)
   */
  registerHandle(
    IPC_CHANNELS.SHOW_CONTEXT_MENU,
    async (event, request: GenericContextMenuRequest): Promise<GenericContextMenuResponse> => {
      const { Menu } = await import('electron');

      return new Promise((resolve) => {
        let resolved = false;

        const toMenuTemplate = (items: GenericContextMenuItem[]): Electron.MenuItemConstructorOptions[] => {
          return items.map((item) => {
            if (item.separator) {
              return { type: 'separator' as const };
            }

            if (item.submenu && item.submenu.length > 0) {
              return {
                label: item.label,
                accelerator: item.accelerator,
                enabled: !item.disabled,
                submenu: toMenuTemplate(item.submenu),
              };
            }

            return {
              label: item.label,
              accelerator: item.accelerator,
              enabled: !item.disabled,
              click: () => {
                if (!resolved) {
                  resolved = true;
                  resolve({ action: item.action });
                }
              },
            };
          });
        };

        const template = toMenuTemplate(request.items);

        const menu = Menu.buildFromTemplate(template);
        const win = (event.sender as WebContentsWithOwner).getOwnerBrowserWindow();

        menu.popup({
          window: win || undefined,
          callback: () => {
            // Menu was closed without selection
            if (!resolved) {
              resolved = true;
              resolve({ action: null });
            }
          },
        });
      });
    }
  );

  /**
   * Show native select dropdown - unified API for select menus
   * Uses native Electron menu positioned at the provided coordinates
   */
  registerHandle(
    IPC_CHANNELS.SHOW_SELECT,
    async (event, request: SelectRequest): Promise<SelectResponse> => {
      const { Menu } = await import('electron');

      return new Promise((resolve) => {
        let resolved = false;

        const template: Electron.MenuItemConstructorOptions[] = request.items.map((item) => ({
          label: item.label,
          type: 'checkbox' as const,
          checked: item.value === request.currentValue,
          enabled: !item.disabled,
          click: () => {
            if (!resolved) {
              resolved = true;
              resolve({ value: item.value });
            }
          },
        }));

        const menu = Menu.buildFromTemplate(template);
        const win = (event.sender as WebContentsWithOwner).getOwnerBrowserWindow();

        menu.popup({
          window: win || undefined,
          x: Math.round(request.x),
          y: Math.round(request.y),
          callback: () => {
            // Menu was closed without selection
            if (!resolved) {
              resolved = true;
              resolve({ value: null });
            }
          },
        });
      });
    }
  );

  /**
   * macOS title bar double-click handler
   * Respects system preference for double-click action (minimize or maximize)
   */
  ipcMain.on(IPC_CHANNELS.MAC_TITLEBAR_CLICKED, (event) => {
    if (process.platform !== 'darwin') {
      return;
    }

    const doubleClickAction = systemPreferences.getUserDefault(
      'AppleActionOnDoubleClick',
      'string'
    );

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (doubleClickAction === 'Minimize') {
        win.minimize();
      } else if (doubleClickAction === 'Maximize') {
        if (!win.isMaximized()) {
          win.maximize();
        } else {
          win.unmaximize();
        }
      }
    }
  });

  // ============================================================================
  // Approval Handlers
  // ============================================================================

  /**
   * Get pending approvals
   * Delegates to server/handlers/approvals.ts
   */
  registerHandle(
    IPC_CHANNELS.APPROVAL_GET,
    async (_event, request: ApprovalGetRequest): Promise<ApprovalGetResponse> => {
      try {
        const result = await approvalsHandlers.getApprovals(request?.toolCallId);
        return { approvals: result.approvals };
      } catch (error: any) {
        console.error('[IPC] Error getting approvals:', error);
        throw error;
      }
    }
  );

  /**
   * Approve an approval request
   * Delegates to server/handlers/approvals.ts
   */
  registerHandle(
    IPC_CHANNELS.APPROVAL_APPROVE,
    async (_event, request: ApprovalActionRequest): Promise<ApprovalActionResponse> => {
      try {
        const { id } = request;

        if (!approvalManager.hasApproval(id)) {
          return { success: false, error: 'Approval not found' };
        }

        await approvalsHandlers.approve(id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error approving:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Deny an approval request
   * Delegates to server/handlers/approvals.ts
   */
  registerHandle(
    IPC_CHANNELS.APPROVAL_DENY,
    async (_event, request: ApprovalActionRequest): Promise<ApprovalActionResponse> => {
      try {
        const { id } = request;

        if (!approvalManager.hasApproval(id)) {
          return { success: false, error: 'Approval not found' };
        }

        await approvalsHandlers.deny(id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error denying:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Respond to a question/approval with full result
   * Supports complex questions with multiple answers, skip, and timeout
   */
  registerHandle(
    IPC_CHANNELS.APPROVAL_RESPOND,
    async (_event, request: ApprovalRespondRequest): Promise<ApprovalRespondResponse> => {
      try {
        const { id, result } = request;
        return await approvalsHandlers.respond(id, result);
      } catch (error: any) {
        console.error('[IPC] Error responding:', error);
        return { success: false, error: error.message };
      }
    }
  );

  // ============================================================================
  // Agent Tab Handlers
  // ============================================================================

  /**
   * UI confirms tab was created
   * Delegates to server/handlers/agentTabs.ts
   */
  registerHandle(
    IPC_CHANNELS.AGENT_TAB_CREATED,
    async (_event, data: AgentTabCreatedRequest): Promise<AgentTabCreatedResponse> => {
      try {
        console.log('[IPC] agent-tab:created received:', data);
        await agentTabsHandlers.onTabCreated(data.requestId, data.agentId);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error handling tab created:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * UI reports agent execution completed
   * Delegates to server/handlers/agentTabs.ts
   */
  registerHandle(
    IPC_CHANNELS.AGENT_TAB_COMPLETED,
    async (_event, data: AgentTabCompletedRequest): Promise<AgentTabCompletedResponse> => {
      try {
        console.log('[IPC] agent-tab:completed received:', {
          requestId: data.requestId,
          threadId: data.threadId,
          messageCount: data.messages?.length,
          error: data.error,
        });
        await agentTabsHandlers.onTabCompleted(data.requestId, data.messages, data.error, data.threadId);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error handling tab completed:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get pending agent tab requests
   * Delegates to server/handlers/agentTabs.ts
   */
  registerHandle(
    IPC_CHANNELS.AGENT_TAB_GET_PENDING,
    async (): Promise<AgentTabGetPendingResponse> => {
      try {
        return await agentTabsHandlers.getPendingRequests();
      } catch (error: any) {
        console.error('[IPC] Error getting pending requests:', error);
        throw error;
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.AGENT_TAB_CONSUME_STARTUP,
    async (_event, data: AgentTabConsumeStartupRequest): Promise<AgentTabConsumeStartupResponse> => {
      try {
        return await agentTabsHandlers.consumeStartup(data.startupId, data.agentId);
      } catch (error: any) {
        return {
          success: false,
          startup: null,
          error: error.message,
        };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_TAB_REGISTER_THREAD,
    async (_event, data: AgentTabRegisterThreadRequest): Promise<AgentTabRegisterThreadResponse> => {
      try {
        await agentTabsHandlers.bindThread(data.agentId, data.threadId, data.callerToken, {
          workspacePath: data.workspacePath,
          allowedToolNames: data.allowedToolNames,
          modelConfig: data.modelConfig,
          toolProfileId: data.toolProfileId,
        });
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error registering agent thread:', error);
        return { success: false, error: error.message };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.AGENT_TAB_REPORT_ACTIVITY,
    async (_event, data: import('./registry').AgentTabReportActivityRequest): Promise<import('./registry').AgentTabReportActivityResponse> => {
      try {
        await agentTabsHandlers.reportActivity(data.agentId, data.activity);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error reporting agent activity:', error);
        return { success: false, error: error.message };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_THREADS_DELETE,
    async (_event, request: { threadId: string }): Promise<import('./registry').AgentThreadsDeleteResponse> => {
      try {
        const { deleteThread } = await import('../../server/handlers/agentThreads');
        return await deleteThread(request.threadId);
      } catch (error: any) {
        console.error('[IPC] Error deleting agent thread:', error);
        return { success: false, error: error?.message ?? 'Failed to delete thread.' };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_TAB_DISPOSE_BINDING,
    async (_event, data: AgentTabDisposeBindingRequest): Promise<AgentTabDisposeBindingResponse> => {
      try {
        await agentTabsHandlers.disposeBinding(data.callerToken);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error disposing agent binding:', error);
        return { success: false, error: error.message };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_THREADS_DELETE_ALL,
    async (): Promise<import('./registry').AgentThreadsDeleteAllResponse> => {
      try {
        const { deleteAllThreads } = await import('../../server/handlers/agentThreads');
        return await deleteAllThreads();
      } catch (error: any) {
        console.error('[IPC] Error deleting all agent threads:', error);
        return { success: false, error: error?.message ?? 'Failed to delete all threads.' };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_THREADS_RENAME,
    async (_event, request: { threadId: string; name: string }): Promise<import('./registry').AgentThreadsRenameResponse> => {
      try {
        const { renameThread } = await import('../../server/handlers/agentThreads');
        return await renameThread(request.threadId, request.name);
      } catch (error: any) {
        console.error('[IPC] Error renaming agent thread:', error);
        return { success: false, error: error?.message ?? 'Failed to rename thread.' };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_THREADS_ARCHIVE,
    async (_event, request: { threadId: string }): Promise<import('./registry').AgentThreadsArchiveResponse> => {
      try {
        const { archiveThreadForHistory } = await import('../../server/handlers/agentThreads');
        return await archiveThreadForHistory(request.threadId);
      } catch (error: any) {
        console.error('[IPC] Error archiving agent thread:', error);
        return { success: false, error: error?.message ?? 'Failed to archive thread.' };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.AGENT_THREADS_UNARCHIVE,
    async (_event, request: { threadId: string }): Promise<import('./registry').AgentThreadsUnarchiveResponse> => {
      try {
        const { unarchiveThreadForHistory } = await import('../../server/handlers/agentThreads');
        return await unarchiveThreadForHistory(request.threadId);
      } catch (error: any) {
        console.error('[IPC] Error unarchiving agent thread:', error);
        return { success: false, error: error?.message ?? 'Failed to unarchive thread.' };
      }
    },
  );


  // ============================================================================
  // PDF Handlers
  // ============================================================================

  /**
   * Update PDF form data
   */
  registerHandle(
    IPC_CHANNELS.PDF_UPDATE_FORM_DATA,
    async (_event, request: PdfUpdateFormDataRequest): Promise<PdfUpdateFormDataResponse> => {
      try {
        // Store form data updates - could be persisted if needed
        console.log('[IPC] PDF form data updated:', request.filePath, request.formData.fields.length, 'fields');
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error updating PDF form data:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Read PDF structure (form fields, annotations, text with bounding boxes)
   * Used by PDFViewer for diff-based refresh instead of going through callTool.
   */
  registerHandle(
    IPC_CHANNELS.PDF_READ_STRUCTURE,
    async (_event, request: import('./registry').PdfReadStructureRequest) => {
      try {
        const workspace = getCurrentWorkspace();
        const resolvedPath = resolvePathWithWorkspace(request.filePath, workspace);
        const realPath = await fs.realpath(resolvedPath);

        if (workspace) {
          const realWorkspace = await fs.realpath(workspace);
          if (realPath !== realWorkspace && !realPath.startsWith(realWorkspace + path.sep)) {
            throw new Error('Access denied: path outside workspace');
          }
        }

        const { readPdfStructure } = await import('../../server/utils/pdfStructure');
        return await readPdfStructure(realPath, request.page);
      } catch (error: any) {
        console.error('[IPC] Error reading PDF structure:', error);
        return null;
      }
    }
  );

  // ============================================================================
  // Checkpoint Handlers
  // ============================================================================

  /**
   * Get checkpoint metadata for a messageId
   */
  registerHandle(
    IPC_CHANNELS.CHECKPOINT_GET,
    async (_event, request: CheckpointGetRequest): Promise<CheckpointGetResponse> => {
      try {
        const checkpoint = await checkpointManager.getCheckpoint(request.messageId);
        if (checkpoint) {
          return { success: true, checkpoint };
        }
        return { success: true, checkpoint: undefined };
      } catch (error: any) {
        console.error('[IPC] Error getting checkpoint:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Restore files from a checkpoint
   */
  registerHandle(
    IPC_CHANNELS.CHECKPOINT_RESTORE,
    async (_event, request: CheckpointRestoreRequest): Promise<CheckpointRestoreResponse> => {
      try {
        const result = await checkpointManager.restore(request.messageId, request.type, request.paths);
        return result;
      } catch (error: any) {
        console.error('[IPC] Error restoring checkpoint:', error);
        return { success: false, restored: [], error: error.message };
      }
    }
  );

  /**
   * Get checkpoint settings
   */
  registerHandle(
    IPC_CHANNELS.CHECKPOINT_SETTINGS_GET,
    async (): Promise<CheckpointSettingsGetResponse> => {
      const settings = checkpointManager.getSettings();
      return { settings };
    }
  );

  /**
   * Update checkpoint settings
   */
  registerHandle(
    IPC_CHANNELS.CHECKPOINT_SETTINGS_SET,
    async (_event, request: CheckpointSettingsSetRequest): Promise<CheckpointSettingsSetResponse> => {
      try {
        const settings = await checkpointManager.setSettings(request.settings);
        return { success: true, settings };
      } catch (error: any) {
        console.error('[IPC] Error setting checkpoint settings:', error);
        return { success: false, settings: checkpointManager.getSettings(), error: error.message };
      }
    }
  );

  // ============================================================================
  // File Operation Handlers
  // ============================================================================

  /**
   * Move file/folder to new location
   * Delegates to server/handlers/files.ts
   */
  registerHandle(
    IPC_CHANNELS.FILES_MOVE,
    async (event, request: FilesMoveRequest): Promise<FilesMoveResponse> => {
      const { moveFile } = await import('../../server/handlers/files');
      const { prepareVaultRename } = await import('../../server/utils/vaultIndex');
      const { requestWorkspaceScopedConfirmation } = await import('./workspaceConfirmation');
      const workspacePath = getCurrentWorkspace();
      let updateReferences = true;
      let preparedRename: import('../../server/utils/vaultIndex').PreparedVaultRename | null = null;

      if (workspacePath) {
        preparedRename = await prepareVaultRename(request.sourcePath, workspacePath);
        const includeSourcePath = Boolean(
          preparedRename
          && (
            preparedRename.rewriteDestinationPath
            || path.dirname(preparedRename.sourcePath) !== path.dirname(request.destPath)
          ),
        );
        const hasReferenceUpdates = Boolean(
          preparedRename
          && (
            preparedRename.referringPaths.length > 0
            || includeSourcePath
          ),
        );

        if (preparedRename && hasReferenceUpdates) {
          const confirmed = await requestWorkspaceScopedConfirmation(
            buildReferenceUpdateConfirmationEvent({
              workspacePath,
              sourcePath: request.sourcePath,
              preparedRename,
              includeSourcePath,
            }),
            { windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null },
          );
          updateReferences = confirmed;
        }
      }

      const result = await moveFile(request.sourcePath, request.destPath, {
        updateReferences,
        preparedRename,
      });

      if (result.success) {
        emitWorkspaceFilesChangedForCurrentContext('unlink', request.sourcePath);
        emitWorkspaceFilesChangedForCurrentContext('add', request.destPath);
      }

      return result;
    }
  );

  /**
   * Start native drag operation for external app drops (browser, Finder, etc.)
   * Uses fire-and-forget pattern (on/send) because startDrag() blocks until drop completes
   */
  ipcMain.on(
    IPC_CHANNELS.FILES_START_DRAG,
    async (event, request: FilesStartDragRequest) => {
      try {
        const { filePath } = request;
        const icon = await app.getFileIcon(filePath, { size: 'normal' });
        event.sender.startDrag({
          file: filePath,
          icon: icon,
        });
      } catch (error: any) {
        console.error('[IPC] Error starting native drag:', error);
      }
    }
  );

  /**
   * Download URL to temp file (for browser image drops)
   */
  registerHandle(
    IPC_CHANNELS.FILES_DOWNLOAD_URL,
    async (_event, request: FilesDownloadUrlRequest): Promise<FilesDownloadUrlResponse> => {
      try {
        const { url, suggestedFilename } = request;

        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return { success: false, error: 'Only HTTP/HTTPS URLs supported' };
        }

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/*,*/*',
          }
        });

        if (!response.ok) {
          return { success: false, error: `HTTP ${response.status}` };
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        const contentType = response.headers.get('content-type') || '';
        const extMap: Record<string, string> = {
          'image/png': '.png',
          'image/jpeg': '.jpg',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/svg+xml': '.svg',
          'image/bmp': '.bmp',
        };
        let ext = extMap[contentType.split(';')[0]] || path.extname(parsedUrl.pathname) || '.png';

        const dropsDir = path.join(getSandboxDir(), 'iworkstation-drops');
        await fs.mkdir(dropsDir, { recursive: true });
        const filename = suggestedFilename || `drop-${randomBytes(4).toString('hex')}${ext}`;
        const filePath = path.join(dropsDir, filename);

        await fs.writeFile(filePath, buffer);

        return { success: true, filePath };
      } catch (error: any) {
        console.error('[IPC] Error downloading URL:', error);
        return { success: false, error: error.message || 'Unknown error' };
      }
    }
  );

  /**
   * Save clipboard image to sandbox file (for paste support)
   */
  registerHandle(
    IPC_CHANNELS.FILES_SAVE_CLIPBOARD_IMAGE,
    async (_event, request: FilesSaveClipboardImageRequest): Promise<FilesDownloadUrlResponse> => {
      try {
        const { imageData, mimeType } = request;
        if (!imageData) {
          return { success: false, error: 'Missing clipboard image bytes' };
        }

        let buffer: Buffer;
        try {
          if (ArrayBuffer.isView(imageData)) {
            buffer = Buffer.from(imageData.buffer, imageData.byteOffset, imageData.byteLength);
          } else {
            buffer = Buffer.from(imageData);
          }
        } catch {
          return { success: false, error: 'Invalid clipboard image bytes' };
        }
        if (buffer.byteLength === 0) {
          return { success: false, error: 'Missing clipboard image bytes' };
        }

        const extMap: Record<string, string> = {
          'image/png': '.png',
          'image/jpeg': '.jpg',
          'image/jpg': '.jpg',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/svg+xml': '.svg',
          'image/bmp': '.bmp',
          'image/tiff': '.tiff',
          'image/heic': '.heic',
          'image/heif': '.heif',
        };
        const normalizedMimeType = mimeType.split(';')[0].trim().toLowerCase();
        const extFromMime = extMap[normalizedMimeType] || '.png';

        const dropsDir = path.join(getSandboxDir(), 'iworkstation-drops');
        await fs.mkdir(dropsDir, { recursive: true });

        const ext = extFromMime;
        const filename = `paste-${randomBytes(4).toString('hex')}${ext}`;
        const filePath = path.join(dropsDir, filename);

        await fs.writeFile(filePath, buffer);
        return { success: true, filePath };
      } catch (error: any) {
        console.error('[IPC] Error saving clipboard image:', error);
        return { success: false, error: error.message || 'Unknown error' };
      }
    }
  );

  /**
   * Copy external files into workspace (from Finder/Desktop drop)
   */
  registerHandle(
    IPC_CHANNELS.FILES_COPY_EXTERNAL,
    async (_event, request: FilesCopyExternalRequest): Promise<FilesCopyExternalResponse> => {
      try {
        const { sourcePaths, destFolder } = request;
        console.log('[IPC] Copying external files:', sourcePaths, '->', destFolder);

        const copiedPaths: string[] = [];

        for (const sourcePath of sourcePaths) {
          const fileName = path.basename(sourcePath);
          const destPath = path.join(destFolder, fileName);

          // Skip if destination already exists (name conflict = do nothing)
          try {
            await fs.access(destPath);
            console.log('[IPC] Skipping copy - file exists:', destPath);
            continue;
          } catch {
            // File doesn't exist, proceed with copy
          }

          await fs.access(sourcePath);

          const stat = await fs.stat(sourcePath);
          if (stat.isDirectory()) {
            await fs.cp(sourcePath, destPath, { recursive: true });
          } else {
            await fs.copyFile(sourcePath, destPath);
          }

          copiedPaths.push(destPath);
          emitWorkspaceFilesChangedForCurrentContext('add', destPath);
        }

        return { success: true, copiedPaths };
      } catch (error: any) {
        console.error('[IPC] Error copying external files:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Check whether a path points to a directory.
   */
  ipcMain.handle(
    IPC_CHANNELS.FILES_IS_DIRECTORY,
    async (event, request: FilesIsDirectoryRequest): Promise<FilesIsDirectoryResponse> => {
      assertTrustedFileIpcSender(event);
      const { isDirectory } = await import('../../server/handlers/files');
      return { isDirectory: await isDirectory(request.path) };
    }
  );

  /**
   * Get file stats (size, line count for text files)
   */
  registerHandle(
    IPC_CHANNELS.FILES_GET_STATS,
    async (_event, request: FilesGetStatsRequest): Promise<FilesGetStatsResponse> => {
      const { getFileStats } = await import('../../server/handlers/files');
      return getFileStats(request.path);
    }
  );

  /**
   * List directory contents for the center-pane folder explorer.
   * This stays Electron-only because it can browse outside the workspace.
   */
  registerHandle(
    IPC_CHANNELS.FILES_LIST_DIRECTORY,
    async (
      _event,
      request: FilesListDirectoryRequest,
    ): Promise<FilesListDirectoryResponse> => {
      const { listDirectory } = await import('../../server/handlers/files');
      return listDirectory(request.path);
    }
  );

  /**
   * Start, stop, and inspect managed local Node web apps.
   * This stays Electron-only because it launches local processes and opens app tabs.
   */
  registerHandle(
    IPC_CHANNELS.PROJECT_RUNNER_START,
    async (
      event,
      request: ProjectRunnerPathRequest,
    ): Promise<ProjectRunnerStartResponse> => {
      assertTrustedFileIpcSender(event);
      try {
        const { startProject } = await import('../../server/handlers/projectRunner');
        return await startProject(request.projectPath);
      } catch (error: any) {
        return {
          success: false,
          state: {
            projectPath: request.projectPath,
            status: 'error',
            error: error.message,
          },
          error: error.message,
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.PROJECT_RUNNER_STOP,
    async (
      event,
      request: ProjectRunnerPathRequest,
    ): Promise<ProjectRunnerStopResponse> => {
      assertTrustedFileIpcSender(event);
      try {
        const { stopProject } = await import('../../server/handlers/projectRunner');
        return await stopProject(request.projectPath);
      } catch (error: any) {
        return {
          success: false,
          state: {
            projectPath: request.projectPath,
            status: 'error',
            error: error.message,
          },
          error: error.message,
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.PROJECT_RUNNER_GET_STATUS,
    async (
      event,
      request: ProjectRunnerPathRequest,
    ): Promise<ProjectRunnerGetStatusResponse> => {
      assertTrustedFileIpcSender(event);
      const { getProjectStatus } = await import('../../server/handlers/projectRunner');
      return await getProjectStatus(request.projectPath);
    }
  );

  /**
   * Rename file/folder
   * Delegates to server/handlers/files.ts
   */
  registerHandle(
    IPC_CHANNELS.FILES_RENAME,
    async (event, request: FilesRenameRequest): Promise<FilesRenameResponse> => {
      const { renameFile } = await import('../../server/handlers/files');
      const { prepareVaultRename } = await import('../../server/utils/vaultIndex');
      const { requestWorkspaceScopedConfirmation } = await import('./workspaceConfirmation');
      const workspacePath = getCurrentWorkspace();
      let updateReferences = true;
      let preparedRename: import('../../server/utils/vaultIndex').PreparedVaultRename | null = null;

      if (workspacePath) {
        preparedRename = await prepareVaultRename(request.path, workspacePath);
        const includeSourcePath = Boolean(
          preparedRename
          && preparedRename.rewriteDestinationPath,
        );
        const hasReferenceUpdates = Boolean(
          preparedRename
          && (
            preparedRename.referringPaths.length > 0
            || includeSourcePath
          ),
        );

        if (preparedRename && hasReferenceUpdates) {
          const confirmed = await requestWorkspaceScopedConfirmation(
            buildReferenceUpdateConfirmationEvent({
              workspacePath,
              sourcePath: request.path,
              preparedRename,
              includeSourcePath,
            }),
            { windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null },
          );
          updateReferences = confirmed;
        }
      }

      const result = await renameFile(request.path, request.newName, {
        updateReferences,
        preparedRename,
      });

      if (result.success && result.newPath) {
        emitWorkspaceFilesChangedForCurrentContext('change', result.newPath);
      }

      return result;
    }
  );

  /**
   * Delete file/folder (move to trash)
   */
  registerHandle(
    IPC_CHANNELS.FILES_DELETE,
    async (_event, request: FilesDeleteRequest): Promise<FilesDeleteResponse> => {
      try {
        const { path: filePath } = request;
        if (!filePath || typeof filePath !== 'string') {
          return { success: false, error: 'Invalid path' };
        }
        const normalizedPath = path.normalize(filePath);
        console.log('[IPC] Deleting file:', filePath);

        // Move to trash instead of permanent delete
        await shell.trashItem(normalizedPath);

        emitWorkspaceFilesChangedForCurrentContext('unlink', normalizedPath);

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error deleting file:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Move file/folder to trash
   */
  registerHandle(
    IPC_CHANNELS.FILES_TRASH,
    async (_event, request: FilesTrashRequest): Promise<FilesTrashResponse> => {
      try {
        const { path: filePath } = request;
        if (!filePath || typeof filePath !== 'string') {
          return { success: false, error: 'Invalid path' };
        }
        const normalizedPath = path.normalize(filePath);
        console.log('[IPC] Moving to trash:', filePath);

        await shell.trashItem(normalizedPath);

        emitWorkspaceFilesChangedForCurrentContext('unlink', normalizedPath);

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error moving to trash:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Duplicate file/folder
   */
  registerHandle(
    IPC_CHANNELS.FILES_DUPLICATE,
    async (_event, request: FilesDuplicateRequest): Promise<FilesDuplicateResponse> => {
      try {
        const { path: filePath } = request;
        console.log('[IPC] Duplicating:', filePath);

        const { duplicateFile } = await import('../../server/handlers/files');
        const result = await duplicateFile(filePath);

        if (result.success && result.newPath) {
          emitWorkspaceFilesChangedForCurrentContext('add', result.newPath);
        }

        return result;
      } catch (error: any) {
        console.error('[IPC] Error duplicating:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Create a new folder
   */
  registerHandle(
    IPC_CHANNELS.FILES_CREATE_FOLDER,
    async (_event, request: FilesCreateFolderRequest): Promise<FilesCreateFolderResponse> => {
      try {
        const { parentPath, name } = request;
        console.log('[IPC] Creating folder in:', parentPath);

        const { createFolder } = await import('../../server/handlers/files');
        const result = await createFolder(parentPath, name);

        if (result.success && result.path) {
          emitWorkspaceFilesChangedForCurrentContext('addDir', result.path);
        }

        return result;
      } catch (error: any) {
        console.error('[IPC] Error creating folder:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Copy file path to clipboard
   */
  registerHandle(
    IPC_CHANNELS.FILES_COPY_PATH,
    async (_event, request: FilesCopyPathRequest): Promise<FilesCopyPathResponse> => {
      try {
        const { path: filePath } = request;
        console.log('[IPC] Copying path to clipboard:', filePath);

        clipboard.writeText(filePath);

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error copying path:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Read text file content for user-initiated file tabs.
   * SECURITY: This is a privileged Electron-renderer path, not an agent path.
   * It intentionally bypasses workspace-only HTTP guards so the user can open
   * explicit files outside the workspace in the desktop UI. Do not expose this
   * handler via HTTP or reuse it for untrusted/remote callers.
   */
  registerHandle(
    IPC_CHANNELS.FILES_READ,
    async (event, request: FilesReadRequest): Promise<FilesReadResponse> => {
      assertTrustedFileIpcSender(event);
      const { readTextFile } = await import('../../server/handlers/files');
      return readTextFile(request.path);
    }
  );

  registerHandle(
    IPC_CHANNELS.FILES_READ_BINARY,
    async (event, request: FilesReadBinaryRequest): Promise<FilesReadBinaryResponse> => {
      assertTrustedFileIpcSender(event);
      const { readBinaryFile } = await import('../../server/handlers/files');
      return readBinaryFile(request.path);
    }
  );

  /**
   * Write text file content for user-initiated editors.
   * SECURITY: Same trust boundary as FILES_READ above. This is only acceptable
   * because Electron renderer code is already privileged; any renderer compromise
   * is effectively local-code-execution severity and must be treated that way.
   */
  registerHandle(
    IPC_CHANNELS.FILES_WRITE,
    async (event, request: FilesWriteRequest): Promise<FilesWriteResponse> => {
      assertTrustedFileIpcSender(event);
      const { writeTextFile } = await import('../../server/handlers/files');
      return writeTextFile(request.path, request.content);
    }
  );

  /**
   * Write binary file content for user-initiated media editors.
   * SECURITY: Same trust boundary as FILES_WRITE above.
   */
  registerHandle(
    IPC_CHANNELS.FILES_WRITE_BINARY,
    async (event, request: FilesWriteBinaryRequest): Promise<FilesWriteBinaryResponse> => {
      assertTrustedFileIpcSender(event);
      const existed = await fs.access(request.path).then(() => true).catch(() => false);
      const { writeBinaryFile } = await import('../../server/handlers/files');
      const buffer = ArrayBuffer.isView(request.buffer)
        ? new Uint8Array(request.buffer.buffer, request.buffer.byteOffset, request.buffer.byteLength)
        : new Uint8Array(request.buffer);

      const result = await writeBinaryFile(request.path, buffer);
      const stat = await fs.stat(request.path);
      emitWorkspaceFilesChangedForCurrentContext(existed ? 'change' : 'add', request.path, stat.mtimeMs);
      return result;
    }
  );

  /**
   * Get file thumbnails for arbitrary user-selected files.
   * SECURITY: Keep this renderer-only. HTTP thumbnail requests remain separately
   * constrained by their own route/origin rules.
   */
  registerHandle(
    IPC_CHANNELS.FILES_GET_THUMBNAILS,
    async (event, request: FilesGetThumbnailsRequest): Promise<FilesGetThumbnailsResponse> => {
      assertTrustedFileIpcSender(event);
      const { getFileThumbnails } = await import('../../server/handlers/files');
      return getFileThumbnails(request.paths, request.size ?? 64);
    }
  );

  registerHandle(
    IPC_CHANNELS.MOVIE_COMPILE_COMPONENTS,
    async (event, request: MovieCompileComponentsRequest): Promise<MovieCompileComponentsResponse> => {
      assertTrustedFileIpcSender(event);
      const { compileMovieComponentsModule } = await import('../../server/handlers/movie');
      return compileMovieComponentsModule(request);
    },
  );

  registerHandle(
    IPC_CHANNELS.MOVIE_EXPORT,
    async (event, request: MovieExportRequest): Promise<MovieExportResponse> => {
      assertTrustedFileIpcSender(event);
      const sendProgress = (update: MovieExportProgressEvent) => {
        event.sender.send(IPC_CHANNELS.MOVIE_EXPORT_PROGRESS, update);
      };

      const { exportMovieProject } = await import('../../server/handlers/movie');
      return exportMovieProject(request, sendProgress);
    },
  );

  registerHandle(
    IPC_CHANNELS.MOVIE_EXPORT_CANCEL,
    async (event, request: MovieCancelExportRequest): Promise<MovieCancelExportResponse> => {
      assertTrustedFileIpcSender(event);
      const { cancelMovieExport } = await import('../../server/handlers/movie');
      return cancelMovieExport(request);
    },
  );

  /**
   * Get the path to a template file, handling both dev and packaged environments
   */
  function getTemplatePath(filename: string): string {
    if (process.resourcesPath) {
      const prodPath = path.join(process.resourcesPath, 'templates', filename);
      if (require('fs').existsSync(prodPath)) return prodPath;
    }
    return path.join(process.cwd(), 'resources', 'templates', filename);
  }

  /**
   * Create a new file (note, document, spreadsheet, or slides)
   */
  registerHandle(
    IPC_CHANNELS.FILES_CREATE,
    async (_event, request: FilesCreateRequest): Promise<FilesCreateResponse> => {
      // Use shared handler for consistent naming (Note.md, Note (1).md, etc.)
      const { createFile } = await import('../../server/handlers/files');
      const result = await createFile(request.type, request.workspacePath);

      if (result.success && result.path) {
        emitWorkspaceFilesChangedForCurrentContext('add', result.path);
      }

      return result;
    }
  );

  /**
   * Create a bookmark file from a browser tab drop
   * Delegates to server/handlers/files.ts
   */
  registerHandle(
    IPC_CHANNELS.FILES_CREATE_BOOKMARK,
    async (_event, request: FilesCreateBookmarkRequest): Promise<FilesCreateBookmarkResponse> => {
      const { createBookmark } = await import('../../server/handlers/files');
      const result = await createBookmark(request.url, request.title, request.faviconUrl, request.destFolder);

      if (result.success && result.path) {
        emitWorkspaceFilesChangedForCurrentContext('add', result.path);
      }

      return result;
    }
  );

  // ============================================================================
  // Shell Operation Handlers
  // ============================================================================

  /**
   * Reveal file in Finder/Explorer
   */
  registerHandle(
    IPC_CHANNELS.SHELL_REVEAL_IN_FINDER,
    async (_event, request: ShellRevealInFinderRequest): Promise<ShellRevealInFinderResponse> => {
      try {
        const { path: filePath } = request;
        console.log('[IPC] Revealing in Finder:', filePath);

        shell.showItemInFolder(filePath);

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error revealing in Finder:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Copy file to system clipboard
   */
  registerHandle(
    IPC_CHANNELS.SHELL_COPY_FILE,
    async (_event, request: ShellCopyFileRequest): Promise<ShellCopyFileResponse> => {
      try {
        const { path: filePath } = request;
        console.log('[IPC] Copying file to clipboard:', filePath);

        // For now, just copy the path
        // Full file copy would require reading the file and storing in clipboard
        clipboard.writeText(filePath);

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error copying file:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Cut file to system clipboard
   */
  registerHandle(
    IPC_CHANNELS.SHELL_CUT_FILE,
    async (_event, request: ShellCutFileRequest): Promise<ShellCutFileResponse> => {
      try {
        const { path: filePath } = request;
        console.log('[IPC] Cutting file to clipboard:', filePath);

        // For now, just copy the path
        // Full cut would require tracking cut state and clearing source on paste
        clipboard.writeText(filePath);

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Error cutting file:', error);
        return { success: false, error: error.message };
      }
    }
  );

  // ============================================================================
  // Conversation Handlers (workspace-local storage)
  // ============================================================================

  /**
   * Save conversation to global storage
   * Delegates to server/handlers/conversations.ts
   */
  registerHandle(
    IPC_CHANNELS.CONVERSATION_SAVE,
    async (_event, request: ConversationSaveRequest): Promise<ConversationSaveResponse> => {
      return measureAsync('conversation:save', async () => {
        const { saveConversation } = await import('../../server/handlers/conversations');
        return saveConversation(request.workspace, request.conversation);
      });
    }
  );

  /**
   * Load conversation from global storage
   * Delegates to server/handlers/conversations.ts
   */
  registerHandle(
    IPC_CHANNELS.CONVERSATION_LOAD,
    async (_event, request: ConversationLoadRequest): Promise<ConversationLoadResponse> => {
      return measureAsync('conversation:load', async () => {
        const { loadConversation } = await import('../../server/handlers/conversations');
        return loadConversation(request.workspace, request.conversationId);
      });
    }
  );

  /**
   * List conversations (global storage)
   * Delegates to server/handlers/conversations.ts
   */
  registerHandle(
    IPC_CHANNELS.CONVERSATION_LIST,
    async (_event, _request: ConversationListRequest): Promise<ConversationListResponse> => {
      return measureAsync('conversation:list', async () => {
        const { listConversations } = await import('../../server/handlers/conversations');
        return listConversations(_request?.workspace);
      });
    }
  );

  /**
   * List conversations with message previews (for email-like UI)
   * Delegates to server/handlers/conversations.ts
   */
  registerHandle(
    IPC_CHANNELS.CONVERSATION_LIST_WITH_PREVIEWS,
    async (_event, _request: ConversationListWithPreviewsRequest): Promise<ConversationListWithPreviewsResponse> => {
      return measureAsync('conversation:listWithPreviews', async () => {
        const { listConversationsWithPreviews } = await import('../../server/handlers/conversations');
        return listConversationsWithPreviews(_request?.workspace);
      });
    }
  );

  /**
   * Delete conversation from global storage
   * Delegates to server/handlers/conversations.ts
   */
  registerHandle(
    IPC_CHANNELS.CONVERSATION_DELETE,
    async (_event, request: ConversationDeleteRequest): Promise<ConversationDeleteResponse> => {
      return measureAsync('conversation:delete', async () => {
        const { deleteConversation } = await import('../../server/handlers/conversations');
        return deleteConversation(request.workspace, request.conversationId);
      });
    }
  );

  // ============================================================================
  // OfficeExtension Handlers
  // ============================================================================

  /**
   * Convert file using OfficeExtension
   */
  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_CONVERT,
    async (_event, request: OfficeExtensionConvertRequest): Promise<OfficeExtensionConvertResponse> => {
      try {
        await ensureOfficeExtensionRunning();
        const result = await officeExtensionConvertFile(request, request.outputPath);
        return {
          success: true,
          url: result.url,
          outputPath: result.outputPath,
        };
      } catch (error: any) {
        console.error('[IPC] OfficeExtension convert error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Download file from OfficeExtension conversion result
   */
  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_DOWNLOAD,
    async (_event, request: OfficeExtensionDownloadRequest): Promise<OfficeExtensionDownloadResponse> => {
      try {
        const buffer = await officeExtensionDownloadFile(request.url);
        return {
          success: true,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
        };
      } catch (error: any) {
        console.error('[IPC] OfficeExtension download error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get OfficeExtension status
   */
  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_STATUS,
    async (): Promise<OfficeExtensionStatusResponse> => {
      const running = await isOfficeExtensionRunning();
      return {
        running,
        port: getOfficeExtensionPort(),
      };
    }
  );

  /**
   * Ensure OfficeExtension is running
   */
  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_ENSURE_RUNNING,
    async (): Promise<OfficeExtensionEnsureRunningResponse> => {
      try {
        await ensureOfficeExtensionRunning();
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] OfficeExtension ensure running error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_CHECK_INSTALLED,
    async (): Promise<import('./registry').OfficeExtensionCheckInstalledResponse> => {
      const { isOoEditorsInstalled } = await import('../services/office-extension');
      return { installed: isOoEditorsInstalled() };
    }
  );

  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_INSTALL,
    async (): Promise<import('./registry').OfficeExtensionInstallResponse> => {
      try {
        const { installOoEditors } = await import('../services/office-extension');
        await installOoEditors();
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] OfficeExtension install error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.OFFICE_EXTENSION_UNINSTALL,
    async (): Promise<import('./registry').OfficeExtensionUninstallResponse> => {
      try {
        const { uninstallOoEditors } = await import('../services/office-extension');
        await uninstallOoEditors();
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] OfficeExtension uninstall error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.VOICE_EXTENSION_CHECK_INSTALLED,
    async (
      _event,
      request?: import('./registry').VoiceExtensionCheckInstalledRequest,
    ): Promise<import('./registry').VoiceExtensionCheckInstalledResponse> => {
      try {
        const { isVoiceExtensionInstalled, getVoiceExtensionInstallRoot } = await import('../services/voice-extension');
        const backend = request?.backend;
        return {
          installed: await isVoiceExtensionInstalled(backend),
          installPath: getVoiceExtensionInstallRoot(backend),
        };
      } catch (error: any) {
        console.error('[IPC] VoiceExtension check installed error:', error);
        return {
          installed: false,
          error: error?.message || String(error),
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.VOICE_EXTENSION_INSTALL,
    async (
      _event,
      request?: import('./registry').VoiceExtensionInstallRequest,
    ): Promise<import('./registry').VoiceExtensionInstallResponse> => {
      try {
        const { installVoiceExtension } = await import('../services/voice-extension');
        await installVoiceExtension(request?.backend);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] VoiceExtension install error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  // ============================================================================
  // Text-to-Speech Handlers
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.TTS_GET_SETTINGS,
    async (): Promise<TtsGetSettingsResponse> => {
      try {
        const ttsHandlers = await import('../../server/handlers/tts');
        return await ttsHandlers.getSettings();
      } catch (error: any) {
        console.error('[IPC] TTS get settings error:', error);
        return {
          settings: DEFAULT_TTS_SETTINGS,
          installRoot: '',
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.TTS_SET_SETTINGS,
    async (_event, request: TtsSetSettingsRequest): Promise<TtsSetSettingsResponse> => {
      try {
        const ttsHandlers = await import('../../server/handlers/tts');
        return await ttsHandlers.setSettings(request.settings);
      } catch (error: any) {
        console.error('[IPC] TTS set settings error:', error);
        return {
          success: false,
          settings: DEFAULT_TTS_SETTINGS,
          error: error.message,
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.TTS_LIST_MODELS,
    async (): Promise<TtsListModelsResponse> => {
      try {
        const ttsHandlers = await import('../../server/handlers/tts');
        return await ttsHandlers.listModels();
      } catch (error: any) {
        console.error('[IPC] TTS list models error:', error);
        return { models: [], installRoot: '' };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.TTS_INSTALL_MODEL,
    async (_event, request: TtsInstallModelRequest): Promise<TtsInstallModelResponse> => {
      try {
        const ttsHandlers = await import('../../server/handlers/tts');
        return await ttsHandlers.installModel(request.modelId);
      } catch (error: any) {
        console.error('[IPC] TTS install model error:', error);
        return {
          success: false,
          modelId: request.modelId,
          error: error.message,
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.TTS_GET_VOICES,
    async (_event, request?: TtsGetVoicesRequest): Promise<TtsGetVoicesResponse> => {
      try {
        const ttsHandlers = await import('../../server/handlers/tts');
        return await ttsHandlers.getVoices(request?.modelId);
      } catch (error: any) {
        console.error('[IPC] TTS get voices error:', error);
        return {
          modelId: DEFAULT_TTS_SETTINGS.modelId,
          installed: false,
          voices: [],
          error: error.message,
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.TTS_SPEAK,
    async (_event, request: TtsSpeakRequest): Promise<TtsSpeakResponse> => {
      try {
        const ttsHandlers = await import('../../server/handlers/tts');
        return await ttsHandlers.speakText(request);
      } catch (error: any) {
        console.error('[IPC] TTS speak error:', error);
        return {
          success: false,
          error: error.message,
        };
      }
    }
  );

  // ============================================================================
  // Speech-to-Text Handlers
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.STT_GET_SETTINGS,
    async (): Promise<SttGetSettingsResponse> => {
      try {
        const sttHandlers = await import('../../server/handlers/stt');
        return await sttHandlers.getSettings();
      } catch (error: any) {
        console.error('[IPC] STT get settings error:', error);
        const fallbackSettings = process.platform === 'win32'
          ? { ...DEFAULT_STT_SETTINGS, backend: 'moonshine' as const }
          : DEFAULT_STT_SETTINGS;
        return {
          settings: fallbackSettings,
        };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.STT_SET_SETTINGS,
    async (_event, request: SttSetSettingsRequest): Promise<SttSetSettingsResponse> => {
      try {
        const sttHandlers = await import('../../server/handlers/stt');
        return await sttHandlers.setSettings(request.settings);
      } catch (error: any) {
        console.error('[IPC] STT set settings error:', error);
        const fallbackSettings = process.platform === 'win32'
          ? { ...DEFAULT_STT_SETTINGS, backend: 'moonshine' as const }
          : DEFAULT_STT_SETTINGS;
        return {
          success: false,
          settings: fallbackSettings,
          error: error.message,
        };
      }
    }
  );

  // ============================================================================
  // Browser Handlers
  // ============================================================================

  /**
   * Create browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_CREATE,
    async (_event, request: BrowserCreateRequest): Promise<BrowserCreateResponse> => {
      try {
        browserService.create(request.id, request.url, request.browserId, request.faviconUrl);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser create error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Navigate browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_NAVIGATE,
    async (_event, request: BrowserNavigateRequest): Promise<BrowserNavigateResponse> => {
      try {
        await browserService.navigate(request.id, request.url);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser navigate error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Go back in browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_GO_BACK,
    async (_event, request: BrowserIdRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.goBack(request.id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser go back error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Go forward in browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_GO_FORWARD,
    async (_event, request: BrowserIdRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.goForward(request.id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser go forward error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Reload browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_RELOAD,
    async (_event, request: BrowserIdRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.reload(request.id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser reload error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Stop loading browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_STOP,
    async (_event, request: BrowserIdRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.stop(request.id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser stop error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Close browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_CLOSE,
    async (_event, request: BrowserIdRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.close(request.id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser close error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get browser view state
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_GET_STATE,
    async (_event, request: BrowserGetStateRequest): Promise<BrowserGetStateResponse> => {
      try {
        const state = browserService.getState(request.id);
        if (state) {
          return { success: true, state };
        }
        return { success: false, error: 'Browser view not found' };
      } catch (error: any) {
        console.error('[IPC] Browser get state error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Attach browser view to window
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_ATTACH,
    async (_event, request: BrowserAttachRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.attach(request.id, request.windowId);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser attach error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Detach browser view from window
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_DETACH,
    async (event, request: import('./registry').BrowserDetachRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.detach(request.id, getEventWindowId(event) ?? undefined);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser detach error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Set browser view bounds
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_SET_BOUNDS,
    async (_event, request: BrowserSetBoundsRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.setBounds(request.id, request.bounds);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser set bounds error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Focus browser view
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_FOCUS,
    async (_event, request: BrowserIdRequest): Promise<BrowserActionResponse> => {
      try {
        browserService.focus(request.id);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser focus error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get persisted browser tabs for restoration on app startup
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_GET_PERSISTED_TABS,
    async (): Promise<BrowserGetPersistedTabsResponse> => {
      try {
        const tabs = await browserService.getPersistedTabs();
        return { success: true, tabs };
      } catch (error: any) {
        console.error('[IPC] Browser get persisted tabs error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Set up browser event forwarding to renderer
   */
  browserService.onEvent((event) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      sendToWindow(win, IPC_CHANNELS.BROWSER_EVENT, event);
    });
  });

  // ============================================================================
  // Background Opacity Handlers
  // ============================================================================

  /**
   * Get the background opacity setting
   */
  registerHandle(
    IPC_CHANNELS.BROWSER_CONTROL_GET_STATUS,
    async () => {
      try {
        const browserControlHandlers = await import('../../server/handlers/browserControl');
        return await browserControlHandlers.getBrowserControlStatus();
      } catch (error: any) {
        console.error('[IPC] Browser control status error:', error);
        throw error;
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.BROWSER_CONTROL_GET_POLICY,
    async (): Promise<BrowserControlGetPolicyResponse> => {
      try {
        const browserControlHandlers = await import('../../server/handlers/browserControl');
        return await browserControlHandlers.getBrowserControlPolicy();
      } catch (error: any) {
        console.error('[IPC] Browser control policy get error:', error);
        throw error;
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.BROWSER_CONTROL_SET_POLICY,
    async (_event, request: BrowserControlSetPolicyRequest): Promise<BrowserControlSetPolicyResponse> => {
      try {
        const browserControlHandlers = await import('../../server/handlers/browserControl');
        return await browserControlHandlers.setBrowserControlPolicy(request.policy);
      } catch (error: any) {
        console.error('[IPC] Browser control policy set error:', error);
        return {
          success: false,
          policy: request.policy,
          error: error.message,
        };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.BROWSER_CONTROL_ARRANGE_SPLIT,
    async (event, request: BrowserControlArrangeSplitRequest): Promise<BrowserControlArrangeSplitResponse> => {
      try {
        const appWindow = BrowserWindow.fromWebContents(event.sender);
        if (!appWindow) {
          return { success: false, error: 'Interpreter window is unavailable.' };
        }

        if (appWindow.isFullScreen()) {
          appWindow.setFullScreen(false);
        }
        if (appWindow.isMaximized()) {
          appWindow.unmaximize();
        }

        const display = screen.getDisplayMatching(appWindow.getBounds());
        const { x, y, width, height } = display.workArea;
        const browserWidth = Math.max(1, Math.floor(width * 0.8));
        const interpreterWidth = Math.max(1, width - browserWidth);
        const browserBounds = {
          left: x,
          top: y,
          width: browserWidth,
          height,
        };

        const browserControlHandlers = await import('../../server/handlers/browserControl');
        const browserResult = await browserControlHandlers.arrangeBrowserControlWindow({
          extensionId: request.extensionId,
          targetId: request.targetId,
          bounds: browserBounds,
        });
        if (!browserResult.success) {
          return browserResult;
        }

        appWindow.setBounds({
          x: x + browserWidth,
          y,
          width: interpreterWidth,
          height,
        });
        appWindow.focus();

        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Browser control arrange split error:', error);
        return {
          success: false,
          error: error?.message || String(error),
        };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.BROWSER_CONTROL_ACTIVATE_TAB,
    async (_event, request: BrowserControlActivateTabRequest): Promise<BrowserControlActivateTabResponse> => {
      try {
        const browserControlHandlers = await import('../../server/handlers/browserControl');
        return await browserControlHandlers.activateBrowserControlTabForReview(request);
      } catch (error: any) {
        console.error('[IPC] Browser control activate tab error:', error);
        return {
          success: false,
          error: error?.message || String(error),
        };
      }
    },
  );

  registerHandle(
    IPC_CHANNELS.BACKGROUND_OPACITY_GET,
    async (): Promise<BackgroundOpacityGetResponse> => {
      try {
        return await settingsHandlers.getBackgroundOpacity();
      } catch (error: any) {
        console.error('[IPC] Background opacity get error:', error);
        return { opacity: 0.0 };
      }
    }
  );

  /**
   * Set the background opacity setting
   */
  registerHandle(
    IPC_CHANNELS.BACKGROUND_OPACITY_SET,
    async (_event, request: BackgroundOpacitySetRequest): Promise<BackgroundOpacitySetResponse> => {
      try {
        return await settingsHandlers.setBackgroundOpacity(request.opacity);
      } catch (error: any) {
        console.error('[IPC] Background opacity set error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get the interface zoom factor
   */
  registerHandle(
    IPC_CHANNELS.ZOOM_FACTOR_GET,
    async (): Promise<ZoomFactorGetResponse> => {
      try {
        return await settingsHandlers.getZoomFactor();
      } catch (error: any) {
        console.error('[IPC] Zoom factor get error:', error);
        return { zoomFactor: 1 };
      }
    }
  );

  /**
   * Set the interface zoom factor
   */
  registerHandle(
    IPC_CHANNELS.ZOOM_FACTOR_SET,
    async (_event, request: ZoomFactorSetRequest): Promise<ZoomFactorSetResponse> => {
      try {
        return await settingsHandlers.setZoomFactor(request.zoomFactor);
      } catch (error: any) {
        console.error('[IPC] Zoom factor set error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get the locale setting
   */
  registerHandle(
    IPC_CHANNELS.LOCALE_GET,
    async (): Promise<LocaleGetResponse> => {
      try {
        return await settingsHandlers.getLanguage();
      } catch (error: any) {
        console.error('[IPC] Locale get error:', error);
        return { language: 'en' };
      }
    }
  );

  /**
   * Set the locale setting
   */
  registerHandle(
    IPC_CHANNELS.LOCALE_SET,
    async (_event, request: LocaleSetRequest): Promise<LocaleSetResponse> => {
      try {
        return await settingsHandlers.setLanguage(request.language);
      } catch (error: any) {
        console.error('[IPC] Locale set error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get the theme setting
   */
  registerHandle(
    IPC_CHANNELS.THEME_GET,
    async (): Promise<ThemeGetResponse> => {
      try {
        return await settingsHandlers.getTheme();
      } catch (error: any) {
        console.error('[IPC] Theme get error:', error);
        return { theme: 'system' };
      }
    }
  );

  /**
   * Set the theme setting
   */
  registerHandle(
    IPC_CHANNELS.THEME_SET,
    async (_event, request: ThemeSetRequest): Promise<ThemeSetResponse> => {
      try {
        const result = await settingsHandlers.setTheme(request.theme);
        return result;
      } catch (error: any) {
        console.error('[IPC] Theme set error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  /**
   * Get the primary color setting
   */
  registerHandle(
    IPC_CHANNELS.PRIMARY_COLOR_GET,
    async (): Promise<PrimaryColorGetResponse> => {
      try {
        return await settingsHandlers.getPrimaryColor();
      } catch (error: any) {
        console.error('[IPC] Primary color get error:', error);
        return { color: 'gray' };
      }
    }
  );

  /**
   * Set the primary color setting
   */
  registerHandle(
    IPC_CHANNELS.PRIMARY_COLOR_SET,
    async (_event, request: PrimaryColorSetRequest): Promise<PrimaryColorSetResponse> => {
      try {
        return await settingsHandlers.setPrimaryColor(request.color);
      } catch (error: any) {
        console.error('[IPC] Primary color set error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  // ============================================================================
  // UI Settings Handlers
  // ============================================================================

  // Boolean UI settings (generic loop)
  for (const id of BOOLEAN_UI_SETTING_IDS) {
    const ch = booleanSettingChannels(id);

    registerHandle(
      ch.get,
      async (): Promise<BooleanSettingGetResponse> => {
        try {
          return await settingsHandlers.getBooleanUISetting(id);
        } catch (error: any) {
          console.error(`[IPC] UI settings get ${id} error:`, error);
          return { enabled: BOOLEAN_UI_SETTINGS[id].default };
        }
      }
    );

    registerHandle(
      ch.set,
      async (_event, request: { enabled: boolean }): Promise<BooleanSettingSetResult> => {
        try {
          return await settingsHandlers.setBooleanUISetting(id, request.enabled);
        } catch (error: any) {
          console.error(`[IPC] UI settings set ${id} error:`, error);
          return { success: false, error: error.message };
        }
      }
    );
  }

  // ============================================================================
  // Profile Handlers
  // ============================================================================

  registerHandle(IPC_CHANNELS.PROFILES_LIST, async () => {
    return profilesHandlers.listProfiles();
  });

  registerHandle(IPC_CHANNELS.PROFILES_GET, async (_event, profileId: string) => {
    return profilesHandlers.getProfile(profileId);
  });

  registerHandle(IPC_CHANNELS.PROFILES_CREATE, async (_event, profile: any) => {
    return profilesHandlers.createProfile(profile);
  });

  registerHandle(IPC_CHANNELS.PROFILES_UPDATE, async (_event, profileId: string, updates: any) => {
    return profilesHandlers.updateProfile(profileId, updates);
  });

  registerHandle(IPC_CHANNELS.PROFILES_DELETE, async (_event, profileId: string) => {
    return profilesHandlers.deleteProfile(profileId);
  });

  registerHandle(IPC_CHANNELS.PROFILES_SET_DEFAULT, async (_event, profileId: string) => {
    return profilesHandlers.setDefaultProfile(profileId);
  });

  registerHandle(IPC_CHANNELS.PROFILES_SET_FAST, async (_event, profileId: string) => {
    return profilesHandlers.setFastProfile(profileId);
  });

  registerHandle(IPC_CHANNELS.PROFILES_RESET, async (_event, profileId: string) => {
    return profilesHandlers.resetProfile(profileId);
  });

  // ============================================================================
  // Feedback Handler
  // ============================================================================

  const FEEDBACK_URL = getInterpreterFeedbackUrl();
  const FEEDBACK_EXTRA_LOG_FILES = [
    {
      fileName: 'browser-extension-relay.log',
      label: 'browser_extension_relay_log',
    },
    {
      fileName: 'browser-extension-relay-cdp.jsonl',
      label: 'browser_extension_relay_cdp_log',
    },
  ] as const;

  /**
   * Submit user feedback to the API
   */
  registerHandle(
    IPC_CHANNELS.FEEDBACK_SUBMIT,
    async (_event, request: FeedbackSubmitRequest): Promise<FeedbackSubmitResponse> => {
      try {
        const formData = new FormData();

        formData.append('email', request.email);
        formData.append('message', request.message);
        formData.append('version', app.getVersion());
        formData.append('platform', process.platform);
        formData.append('arch', process.arch);

        if (request.includeLogs) {
          const feedbackMetadata = await getFeedbackMetadataDump();
          const logsDir = resolveDefaultLogDir({
            devDirname: __dirname,
            getPackagedLogDir: () => {
              app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
              return app.getPath('logs');
            },
            isPackaged: app.isPackaged,
          });
          try {
            const feedbackLogAttachment = await buildFeedbackLogAttachment({
              logFilePath: getCurrentRuntimeLogFilePath(),
              logsDir,
              metadata: feedbackMetadata,
              extraLogFiles: FEEDBACK_EXTRA_LOG_FILES.map((file) => ({
                filePath: path.join(logsDir, file.fileName),
                label: file.label,
              })),
            });
            if (feedbackLogAttachment) {
              formData.append(
                'logs',
                new Blob([feedbackLogAttachment.content], { type: 'text/plain' }),
                feedbackLogAttachment.filename
              );
            }
          } catch {
            // Logs not available
          }
        }

        if (request.images) {
          for (const image of request.images) {
            const imageBuffer = Buffer.from(image.data, 'base64');
            const ext = image.name.split('.').pop()?.toLowerCase() || 'png';
            const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
            formData.append('images', new Blob([imageBuffer], { type: contentType }), image.name);
          }
        }

        const response = await fetch(FEEDBACK_URL, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
        }

        const responseText = await response.text();
        let result: { success?: boolean; id?: string; error?: string; detail?: unknown };
        try {
          result = JSON.parse(responseText);
        } catch {
          return { success: false, error: `Invalid JSON response: ${responseText.slice(0, 100)}` };
        }

        if (!result.success) {
          let errorMsg = 'Unknown error';
          if (typeof result.error === 'string') {
            errorMsg = result.error;
          } else if (result.detail) {
            errorMsg = typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail);
          }
          return { success: false, error: errorMsg };
        }

        console.log('[FEEDBACK] Submitted successfully:', result.id);
        return { success: true, id: result.id };
      } catch (error: any) {
        const errorMsg = error.message || 'Unknown network error';
        console.error('[FEEDBACK] Submit error:', errorMsg);
        console.error('[FEEDBACK] Full error:', error.stack || error);
        return { success: false, error: errorMsg };
      }
    }
  );

  // ============================================================================
  // Global Tools Handlers
  // ============================================================================

  /**
   * List all global tool enabled states
   */
  registerHandle(
    IPC_CHANNELS.GLOBAL_TOOLS_LIST,
    async (): Promise<GlobalToolsListResponse> => {
      const tools = await globalToolsHandlers.listGlobalTools();
      return { tools };
    }
  );

  /**
   * Get the enabled state for a specific tool
   */
  registerHandle(
    IPC_CHANNELS.GLOBAL_TOOLS_GET,
    async (_event, request: GlobalToolsGetRequest): Promise<GlobalToolsGetResponse> => {
      const enabled = await globalToolsHandlers.getGlobalToolEnabled(request.serverId);
      return { enabled };
    }
  );

  /**
   * Set the enabled state for a tool
   */
  registerHandle(
    IPC_CHANNELS.GLOBAL_TOOLS_SET,
    async (_event, request: GlobalToolsSetRequest): Promise<GlobalToolsSetResponse> => {
      try {
        await globalToolsHandlers.setGlobalToolEnabled(request.serverId, request.enabled);
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Global tools set error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  // ============================================================================
  // Terminal Handlers
  // ============================================================================

  /**
   * Create a new terminal session
   */
  registerHandle(
    IPC_CHANNELS.TERMINAL_CREATE,
    async (_event, request: { cwd?: string }): Promise<{ sessionId: string }> => {
      const { createSession } = await import('../../server/handlers/terminal');
      return createSession(request?.cwd);
    }
  );

  /**
   * Write data to a terminal session
   */
  registerHandle(
    IPC_CHANNELS.TERMINAL_WRITE,
    async (_event, request: { sessionId: string; data: string }): Promise<{ success: boolean; error?: string }> => {
      const { writeSession } = await import('../../server/handlers/terminal');
      return writeSession(request.sessionId, request.data);
    }
  );

  /**
   * Resize a terminal session
   */
  registerHandle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (_event, request: { sessionId: string; cols: number; rows: number }): Promise<{ success: boolean; error?: string }> => {
      const { resizeSession } = await import('../../server/handlers/terminal');
      return resizeSession(request.sessionId, request.cols, request.rows);
    }
  );

  /**
   * Close a terminal session
   */
  registerHandle(
    IPC_CHANNELS.TERMINAL_CLOSE,
    async (_event, request: { sessionId: string }): Promise<{ success: boolean; error?: string }> => {
      const { closeSession } = await import('../../server/handlers/terminal');
      return closeSession(request.sessionId);
    }
  );

  // ============================================================================
  // Codex Server Handlers
  // ============================================================================

  /**
   * Send a request to Codex server
   */
  registerHandle(
    IPC_CHANNELS.CODEX_REQUEST,
    async (_event, method: string, params: unknown): Promise<unknown> => {
      const { send_request } = await import('../../server/handlers/codexServer');
      return send_request(method, params);
    }
  );

  /**
   * Save thread items to disk
   */
  registerHandle(
    IPC_CHANNELS.CODEX_SAVE_THREAD,
    async (_event, thread_id: string, items: unknown[]): Promise<{ ok: boolean }> => {
      const { save_thread } = await import('../../server/handlers/codexServer');
      save_thread(thread_id, items);
      return { ok: true };
    }
  );

  /**
   * Load thread items from disk
   */
  registerHandle(
    IPC_CHANNELS.CODEX_LOAD_THREAD,
    async (_event, thread_id: string): Promise<{ items: unknown[] | null }> => {
      const { load_thread } = await import('../../server/handlers/codexServer');
      return { items: load_thread(thread_id) };
    }
  );

  /**
   * List saved Codex threads from disk
   */
  registerHandle(
    IPC_CHANNELS.CODEX_LIST_THREADS,
    async (): Promise<{ threads: { id: string; name: string; updated_at: number }[] }> => {
      const { list_saved_threads } = await import('../../server/handlers/codexServer');
      return { threads: list_saved_threads() };
    }
  );

  // ============================================================================
  // Skills Handlers
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.PROGRAMMATIC_TASK_START_HEADED,
    async (
      _event,
      request: ProgrammaticTaskStartHeadedRequest,
    ): Promise<ProgrammaticTaskStartHeadedResponse> => {
      try {
        const { startAgentTask } = await import('../../server/agentTaskService');
        const result = await startAgentTask({
          mode: 'headed',
          message: request.message,
          system: request.system,
          timeoutMs: request.timeoutMs,
          workspace: request.workspace,
          threadId: request.threadId,
          notifyStarted: true,
        });
        return {
          success: true,
          result: {
            mode: 'headed',
            opened: result.completed,
            timestamp: result.timestamp,
            messageCount: result.messageCount,
            messages: result.messages,
            error: result.error,
            agentId: result.agentId,
            requestId: result.requestId,
            threadId: result.threadId,
          },
        };
      } catch (error: any) {
        console.error('[IPC] Programmatic headed task start error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.SKILLS_LIST,
    async (
      _event,
      request?: import('./registry').SkillsListRequest,
    ): Promise<import('./registry').SkillsListResponse> => {
      try {
        const { getSkills } = await import('../../server/handlers/skills');
        const data = await getSkills(request?.workspacePath);
        return { success: true, data };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTransientSkillsListError(message)) {
          const now = Date.now();
          if (now - lastTransientSkillsListLogAt >= TRANSIENT_SKILLS_LIST_LOG_INTERVAL_MS) {
            lastTransientSkillsListLogAt = now;
            console.warn('[IPC] Skills list unavailable during transient runtime bootstrap:', message);
          }
        } else {
          console.error('[IPC] Skills list error:', message);
        }
        return { success: false, error: message };
      }
    }
  );

  registerHandle(
    IPC_CHANNELS.SKILLS_DELETE,
    async (_event, dirPath: string): Promise<{ success: boolean; error?: string }> => {
      const { deleteSkillDir } = await import('../../server/handlers/skills');
      const result = await deleteSkillDir(dirPath);
      if (result.success) {
        // Broadcast to all windows
        for (const win of BrowserWindow.getAllWindows()) {
          sendToWindow(win, IPC_CHANNELS.SKILLS_CHANGED);
        }
      }
      return result;
    }
  );

  registerHandle(
    IPC_CHANNELS.SKILLS_REVEAL,
    async (_event, dirPath: string): Promise<void> => {
      const { shell } = await import('electron');
      shell.showItemInFolder(dirPath);
    }
  );

  // ============================================================================
  // Desktop Notification Handler
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.DESKTOP_NOTIFICATION_SHOW,
    async (_event, request: import('./registry').DesktopNotificationShowRequest): Promise<import('./registry').DesktopNotificationShowResponse> => {
      try {
        const notification = new Notification({
          title: request.title,
          body: request.body,
          silent: false,
        });

        notification.on('click', () => {
          const win = workstationService.getMainWindow()
            ?? BrowserWindow.getFocusedWindow()
            ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
            ?? null;
          if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
          }
          // Notify renderer about the click
          const windows = BrowserWindow.getAllWindows();
          windows.forEach((w) => {
            sendToWindow(w, IPC_CHANNELS.DESKTOP_NOTIFICATION_CLICKED, {
              agentId: request.agentId,
              approvalId: request.approvalId,
            });
          });
        });

        notification.show();
        return { success: true };
      } catch (error: any) {
        console.error('[IPC] Desktop notification error:', error);
        return { success: false };
      }
    }
  );

  // ============================================================================
  // User Email Handlers
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.USER_EMAIL_GET,
    async (): Promise<import('./registry').UserEmailGetResponse> => {
      const { getUserEmail } = await import('../../server/configStore');
      const email = await getUserEmail();
      return { email };
    }
  );

  registerHandle(
    IPC_CHANNELS.USER_EMAIL_SET,
    async (_event, request: import('./registry').UserEmailSetRequest): Promise<import('./registry').UserEmailSetResponse> => {
      const { setUserEmail } = await import('../../server/configStore');
      await setUserEmail(request.email);
      return { success: true, email: request.email };
    }
  );

  // ============================================================================
  // Onboarding Persona Handlers
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.ONBOARDING_PERSONA_GET,
    async (): Promise<import('./registry').OnboardingPersonaGetResponse> => {
      const { getOnboardingPersona } = await import('../../server/configStore');
      const persona = await getOnboardingPersona();
      return { persona };
    }
  );

  registerHandle(
    IPC_CHANNELS.ONBOARDING_PERSONA_SET,
    async (_event, request: import('./registry').OnboardingPersonaSetRequest): Promise<import('./registry').OnboardingPersonaSetResponse> => {
      const { setOnboardingPersona } = await import('../../server/configStore');
      await setOnboardingPersona(request);
      return { success: true };
    }
  );

  // ============================================================================
  // Onboarding Permissions Handlers
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.ONBOARDING_PERMISSIONS_GET,
    async (): Promise<import('./registry').OnboardingPermissionsGetResponse> => {
      const { getPermissions } = await import('../../server/configStore');
      const permissions = await getPermissions();
      return { permissions };
    }
  );

  registerHandle(
    IPC_CHANNELS.ONBOARDING_PERMISSIONS_SET,
    async (_event, request: import('./registry').OnboardingPermissionsSetRequest): Promise<import('./registry').OnboardingPermissionsSetResponse> => {
      const { setPermissions } = await import('../../server/configStore');
      await setPermissions(request);
      return { success: true };
    }
  );

  // ============================================================================
  // Environment Detection Handler
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.ENVIRONMENT_DETECTION_DETECT,
    async (): Promise<import('./registry').EnvironmentDetectionResponse> => {
      const { detectEnvironment } = await import('../../server/environmentDetection');
      const { derivePersona } = await import('../../server/derivePersona');
      const signals = await detectEnvironment();
      const persona = derivePersona(signals);
      return { signals, persona };
    }
  );

  // ============================================================================
  // Newsletter Handler
  // ============================================================================

  registerHandle(
    IPC_CHANNELS.NEWSLETTER_SUBSCRIBE,
    async (_event, request: import('./registry').NewsletterSubscribeRequest): Promise<import('./registry').NewsletterSubscribeResponse> => {
      const { distributionProductConfig } = await import('../../shared/productConfig');
      const apiUrl = distributionProductConfig.newsletterUrl;
      if (!apiUrl) {
        throw new Error('Newsletter subscription is not configured for this distribution.');
      }
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: request.email }),
      });
      if (!response.ok) {
        throw new Error(`Newsletter subscription failed (${response.status})`);
      }
      return { success: true };
    }
  );

  console.log('[IPC] All handlers registered successfully');
}
