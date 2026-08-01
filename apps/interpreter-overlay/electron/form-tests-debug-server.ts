import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrentServerAccessTokenUserIdSync } from '../../../server/lib/authTokens';
import { OVERLAY_AGENT_ALLOWED_TOOL_NAMES } from './overlay-agent-tools.js';
import type { AgentThreadBinding, PendingAgentTabRequest } from '../../../server/agentTabManager';
import type { OverlaySessionDebugSnapshot } from '../../../server/overlaySessionManager';
import type { WindowSessionRecord } from '../../../server/utils/windowSessions';
import type {
  InterpreterOverlayCapturedContext,
  InterpreterOverlayDebugStatus,
  InterpreterOverlayService,
  InterpreterOverlayWorkspaceAgentLaunchDebug,
} from './service.js';
import type { OverlayFileContextItem, OverlayVisualProbe } from '../shared/ipc.js';
import type { InterpreterOverlaySettings } from '../shared/settings.js';
import type { CuaAccessPolicy } from '../../../shared/cuaAccessPolicy.js';

interface FormTestsDebugServerOptions {
  port: number;
  overlayService: InterpreterOverlayService;
  debugAuthToken: string;
}

interface CommandRequest {
  command: string;
  params?: Record<string, unknown>;
}

interface OverlayStatePayload {
  success: true;
  overlayState: ReturnType<InterpreterOverlayService['getOverlayState']>;
}

interface TextControllerContextPromptPayload {
  success: true;
  textControllerContext: Awaited<ReturnType<InterpreterOverlayService['getTextControllerContextPromptForDebug']>>;
}

interface DebugStatusPayload {
  success: true;
  debugStatus: InterpreterOverlayDebugStatus;
}

interface AgentDebugContextPayload {
  success: true;
  agentDebugContext: ReturnType<InterpreterOverlayService['getAgentDebugContext']>;
}

interface OverlaySettingsPayload {
  success: true;
  settings: InterpreterOverlaySettings;
}

interface RuntimeApprovalPolicyPayload {
  success: true;
  previousPolicy: string;
  policy: string;
}

interface CuaAccessPolicyPayload {
  success: true;
  previousPolicy?: CuaAccessPolicy;
  policy: CuaAccessPolicy;
}

interface TrayStatePayload {
  success: true;
  trayState: ReturnType<InterpreterOverlayService['getTrayState']>;
}

interface WorkspaceAgentLaunchDiagnosticsPayload {
  success: true;
  diagnostics: {
    lastWorkspaceAgentLaunch: InterpreterOverlayWorkspaceAgentLaunchDebug | null;
    overlaySession: OverlaySessionDebugSnapshot | null;
    agentBinding: AgentThreadBinding | null;
    pendingAgentRequests: Array<Omit<PendingAgentTabRequest, 'resolve' | 'reject'>>;
    windowSessions: WindowSessionRecord[];
    targetWindowState: {
      windowId: number;
      exists: boolean;
      visible: boolean;
      focused: boolean;
      minimized: boolean;
      title: string;
      bounds: Electron.Rectangle | null;
    } | null;
  };
}

interface AttachedOverlayCliSessionPayload {
  success: true;
  agentId: string;
  callerToken: string;
  session: {
    id: string;
    agentId: string;
    callerToken: string;
    workspacePath: string | null;
    windowSessionKey: string | null;
    displayId: string;
    scopeBoundsDIP: Electron.Rectangle | null;
    createdAt: number;
    updatedAt: number;
    status: 'active' | 'detached' | 'completed';
  };
  interpreterCliPath: string;
  interpreterCliServerConnection: string;
}

interface ShowWorkstationWindowsPayload {
  success: true;
  shown: number;
}

interface CompleteOnboardingPayload {
  success: true;
  reloaded: number;
}

interface WorkstationRendererDiagnosticsPayload {
  success: true;
  diagnostics: Array<{
    session: WindowSessionRecord;
    window: {
      visible: boolean;
      focused: boolean;
      bounds: Electron.Rectangle;
    };
    renderer: unknown;
  }>;
}

function getCurrentOverlayAccountUserId(): string | null {
  return getCurrentServerAccessTokenUserIdSync();
}

export class FormTestsDebugServer {
  private static readonly AUTH_HEADER = 'x-interpreter-debug-token';
  private readonly port: number;
  private readonly overlayService: InterpreterOverlayService;
  private readonly debugAuthToken: string;
  private server: http.Server | null = null;

  constructor(options: FormTestsDebugServerOptions) {
    if (!options.debugAuthToken.trim()) {
      throw new Error('FormTestsDebugServer requires a non-empty debugAuthToken');
    }
    this.port = options.port;
    this.overlayService = options.overlayService;
    this.debugAuthToken = options.debugAuthToken;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...this.overlayService.getDebugStatus() }));
        return;
      }

      if (req.method === 'POST' && req.url === '/command') {
        if (!this.isAuthorizedRequest(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
          return;
        }

        try {
          const request = await this.readJsonBody(req);
          const payload = await this.handleCommand(request);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: message }));
        }
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        console.log(`[FormTestsDebugServer] Listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<CommandRequest> {
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }

    return JSON.parse(body) as CommandRequest;
  }

  private isAuthorizedRequest(req: http.IncomingMessage): boolean {
    const headerValue = req.headers[FormTestsDebugServer.AUTH_HEADER];
    if (typeof headerValue === 'string') {
      return headerValue === this.debugAuthToken;
    }
    if (Array.isArray(headerValue)) {
      return headerValue.includes(this.debugAuthToken);
    }
    return false;
  }

  private async handleCommand(
    request: CommandRequest,
  ): Promise<
    { success: true }
    | ({ success: true } & InterpreterOverlayCapturedContext)
    | OverlayStatePayload
    | TextControllerContextPromptPayload
    | DebugStatusPayload
    | AgentDebugContextPayload
    | TrayStatePayload
    | OverlaySettingsPayload
    | RuntimeApprovalPolicyPayload
    | CuaAccessPolicyPayload
    | WorkspaceAgentLaunchDiagnosticsPayload
    | AttachedOverlayCliSessionPayload
    | ShowWorkstationWindowsPayload
    | CompleteOnboardingPayload
    | WorkstationRendererDiagnosticsPayload
  > {
    switch (request.command) {
      case 'executeAgent': {
        const prompt = String(request.params?.prompt ?? '').trim();
        const systemAddendum = typeof request.params?.systemAddendum === 'string'
          ? request.params.systemAddendum.trim()
          : '';
        if (!prompt) {
          throw new Error('Missing prompt');
        }

        await this.overlayService.startProgrammaticRun(prompt, {
          ...(systemAddendum ? { systemAddendum } : {}),
        });
        return { success: true };
      }
      case 'setNextRunSystemAddendum': {
        const systemAddendum = typeof request.params?.systemAddendum === 'string'
          ? request.params.systemAddendum
          : null;
        this.overlayService.setNextRunSystemAddendum(systemAddendum);
        return { success: true };
      }
      case 'captureContext': {
        const context = await this.overlayService.captureContext();
        return { success: true, ...context };
      }
      case 'captureDebugSnapshot': {
        const snapshot = await this.overlayService.captureContext();
        return { success: true, ...snapshot };
      }
      case 'getOverlayState': {
        return {
          success: true,
          overlayState: this.overlayService.getOverlayState(),
        };
      }
      case 'getTextControllerContextPrompt': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('getTextControllerContextPrompt is only available in form tests mode');
        }
        const params = request.params ?? {};
        return {
          success: true,
          textControllerContext: await this.overlayService.getTextControllerContextPromptForDebug({
            text: typeof params.text === 'string' ? params.text : undefined,
            workspacePath: typeof params.workspacePath === 'string' ? params.workspacePath : null,
            targetWindowSessionKey: typeof params.targetWindowSessionKey === 'string'
              ? params.targetWindowSessionKey
              : null,
            profileId: typeof params.profileId === 'string' ? params.profileId : undefined,
          }),
        };
      }
      case 'getDebugStatus': {
        return {
          success: true,
          debugStatus: this.overlayService.getDebugStatus(),
        };
      }
      case 'getTrayState': {
        return {
          success: true,
          trayState: this.overlayService.getTrayState(),
        };
      }
      case 'setVisualProbe': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('setVisualProbe is only available in form tests mode');
        }
        const probe = request.params?.probe ?? null;
        this.overlayService.setDebugVisualProbe(probe as OverlayVisualProbe | null);
        return { success: true };
      }
      case 'getAgentDebugContext': {
        return {
          success: true,
          agentDebugContext: this.overlayService.getAgentDebugContext(),
        };
      }
      case 'getWorkspaceAgentLaunchDiagnostics': {
        const debugStatus = this.overlayService.getDebugStatus();
        const requestedAgentId = typeof request.params?.agentId === 'string'
          ? request.params.agentId.trim()
          : debugStatus.lastWorkspaceAgentLaunch?.agentId ?? '';
        const requestedCallerToken = typeof request.params?.callerToken === 'string'
          ? request.params.callerToken.trim()
          : debugStatus.lastWorkspaceAgentLaunch?.callerToken ?? '';
        const requestedTargetWindowId = typeof request.params?.targetWindowId === 'number'
          ? request.params.targetWindowId
          : debugStatus.lastWorkspaceAgentLaunch?.targetWindowId ?? null;
        const { overlaySessionManager } = await import('../../../server/overlaySessionManager');
        const { agentTabManager } = await import('../../../server/agentTabManager');
        const { listWindowSessions } = await import('../../../server/utils/windowSessions');
        const electron = await import('electron');
        const browserWindowApi = 'BrowserWindow' in electron
          ? electron.BrowserWindow
          : null;
        const targetWindow = requestedTargetWindowId
          ? browserWindowApi?.fromId(requestedTargetWindowId) ?? null
          : null;
        return {
          success: true,
          diagnostics: {
            lastWorkspaceAgentLaunch: debugStatus.lastWorkspaceAgentLaunch,
            overlaySession: requestedAgentId
              ? overlaySessionManager.getDebugSnapshotForAgent(requestedAgentId)
              : null,
            agentBinding: requestedCallerToken
              ? agentTabManager.getBindingForCallerToken(requestedCallerToken) ?? null
              : null,
            pendingAgentRequests: agentTabManager.getPendingRequests(),
            windowSessions: listWindowSessions(),
            targetWindowState: requestedTargetWindowId
              ? {
                  windowId: requestedTargetWindowId,
                  exists: Boolean(targetWindow && !targetWindow.isDestroyed()),
                  visible: targetWindow?.isVisible() ?? false,
                  focused: targetWindow?.isFocused() ?? false,
                  minimized: targetWindow?.isMinimized() ?? false,
                  title: targetWindow?.getTitle() ?? '',
                  bounds: targetWindow ? targetWindow.getBounds() : null,
                }
              : null,
          },
        };
      }
      case 'showWorkstationWindowsForDebug': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('showWorkstationWindowsForDebug is only available in form tests mode');
        }
        process.env.SHOW_WINDOW = '1';
        const { listWindowSessions } = await import('../../../server/utils/windowSessions');
        const electron = await import('electron');
        const browserWindowApi = 'BrowserWindow' in electron
          ? electron.BrowserWindow
          : null;
        const screenApi = 'screen' in electron ? electron.screen : null;
        const workArea = screenApi?.getPrimaryDisplay().workArea ?? { x: 0, y: 40, width: 1400, height: 900 };
        let shown = 0;
        for (const session of listWindowSessions()) {
          const window = browserWindowApi?.fromId(session.windowId) ?? null;
          if (!window || window.isDestroyed()) {
            continue;
          }
          const bounds = window.getBounds();
          if (bounds.x < workArea.x - 1000 || bounds.y < workArea.y - 1000) {
            window.setBounds({
              x: Math.round(workArea.x + Math.max(24, workArea.width - bounds.width - 24)),
              y: Math.round(workArea.y + 24),
              width: bounds.width,
              height: bounds.height,
            });
          }
          window.setSkipTaskbar(false);
          window.showInactive();
          shown += 1;
        }
        return { success: true, shown };
      }
      case 'completeOnboardingForDebug': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('completeOnboardingForDebug is only available in form tests mode');
        }
        const { setOnboardingState } = await import('../../../server/configStore');
        const { createDefaultOnboardingState } = await import('../../../shared/types/onboardingState');
        const { listWindowSessions } = await import('../../../server/utils/windowSessions');
        const electron = await import('electron');
        const browserWindowApi = 'BrowserWindow' in electron
          ? electron.BrowserWindow
          : null;
        await setOnboardingState({
          ...createDefaultOnboardingState(),
          completed: true,
        });
        let reloaded = 0;
        for (const session of listWindowSessions()) {
          const window = browserWindowApi?.fromId(session.windowId) ?? null;
          if (!window || window.isDestroyed()) {
            continue;
          }
          window.webContents.reload();
          reloaded += 1;
        }
        return { success: true, reloaded };
      }
      case 'setOnboardingAiSetupForDebug': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('setOnboardingAiSetupForDebug is only available in form tests mode');
        }
        const { setOnboardingState } = await import('../../../server/configStore');
        const { createDefaultOnboardingState } = await import('../../../shared/types/onboardingState');
        const { listWindowSessions } = await import('../../../server/utils/windowSessions');
        const electron = await import('electron');
        const browserWindowApi = 'BrowserWindow' in electron
          ? electron.BrowserWindow
          : null;
        await setOnboardingState({
          ...createDefaultOnboardingState(),
          completed: false,
          completedStepIds: [
            'name',
            'privacy',
            'bucket',
            'feature-1',
            'feature-2',
            'feature-3',
            'overlay-first-use',
            'overlay-permissions',
            'tool-addons',
          ],
        });
        let reloaded = 0;
        for (const session of listWindowSessions()) {
          const window = browserWindowApi?.fromId(session.windowId) ?? null;
          if (!window || window.isDestroyed()) {
            continue;
          }
          window.webContents.reload();
          reloaded += 1;
        }
        return { success: true, reloaded };
      }
      case 'getWorkstationRendererDiagnostics': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('getWorkstationRendererDiagnostics is only available in form tests mode');
        }
        const { listWindowSessions } = await import('../../../server/utils/windowSessions');
        const electron = await import('electron');
        const browserWindowApi = 'BrowserWindow' in electron
          ? electron.BrowserWindow
          : null;
        const diagnostics = [];
        for (const session of listWindowSessions()) {
          const window = browserWindowApi?.fromId(session.windowId) ?? null;
          if (!window || window.isDestroyed()) {
            continue;
          }
          const renderer = await window.webContents.executeJavaScript(`
            (() => {
              const persistentTabs = Array.from(document.querySelectorAll('[data-persistent-tab]')).map((element) => ({
                tabId: element.getAttribute('data-persistent-tab'),
                paneId: element.getAttribute('data-persistent-pane'),
                visible: element.getAttribute('data-persistent-visible') || null,
                display: getComputedStyle(element).display,
                visibility: getComputedStyle(element).visibility,
                text: (element.textContent || '').slice(0, 160),
              }));
              return {
                readyState: document.readyState,
                url: location.href,
                title: document.title,
                hasPersistentLayer: Boolean(document.querySelector('[data-testid="persistent-layer"]')),
                persistentTabs,
                agentThreadCount: document.querySelectorAll('[data-agent-id]').length,
                bodyText: (document.body?.innerText || '').slice(0, 500),
              };
            })()
          `, true).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
          diagnostics.push({
            session,
            window: {
              visible: window.isVisible(),
              focused: window.isFocused(),
              bounds: window.getBounds(),
            },
            renderer,
          });
        }
        return { success: true, diagnostics };
      }
      case 'createAttachedOverlayCliSession': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('createAttachedOverlayCliSession is only available in form tests mode');
        }
        const agentId = typeof request.params?.agentId === 'string' && request.params.agentId.trim()
          ? request.params.agentId.trim()
          : `debug-overlay-agent-${Date.now()}`;
        const callerToken = typeof request.params?.callerToken === 'string' && request.params.callerToken.trim()
          ? request.params.callerToken.trim()
          : `agtok_debug_overlay_${Date.now()}`;
        const workspacePath = typeof request.params?.workspacePath === 'string'
          ? request.params.workspacePath
          : process.cwd();
        const windowSessionKey = typeof request.params?.windowSessionKey === 'string'
          ? request.params.windowSessionKey
          : null;
        const { agentTabManager } = await import('../../../server/agentTabManager');
        const { getServerPort } = await import('../../../server/server');
        const {
          buildInterpreterCliServerConnection,
          materializeInterpreterCliLauncher,
        } = await import('../../../server/utils/interpreterCliRuntime');

        const session = await this.overlayService.createAgentToolSession({
          agentId,
          callerToken,
          workspacePath,
          windowSessionKey,
        });
        this.overlayService.dismissInputOverlayForDebug();
        agentTabManager.registerAgentRuntime({
          agentId,
          callerToken,
          workspacePath,
          windowSessionKey,
          allowedToolNames: OVERLAY_AGENT_ALLOWED_TOOL_NAMES,
        });
        return {
          success: true,
          agentId,
          callerToken,
          session,
          interpreterCliPath: materializeInterpreterCliLauncher(process.env, process.platform),
          interpreterCliServerConnection: buildInterpreterCliServerConnection(getServerPort()),
        };
      }
      case 'detachOverlaySession': {
        const debugStatus = this.overlayService.getDebugStatus();
        const agentId = typeof request.params?.agentId === 'string'
          ? request.params.agentId.trim()
          : debugStatus.lastWorkspaceAgentLaunch?.agentId ?? '';
        if (!agentId) {
          throw new Error('Missing agentId');
        }
        const { overlaySessionManager } = await import('../../../server/overlaySessionManager');
        await overlaySessionManager.detach(agentId);
        return { success: true };
      }
      case 'pressEscape': {
        await this.overlayService.simulateEscape();
        return { success: true };
      }
      case 'showInputOverlay': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('showInputOverlay is only available in form tests mode');
        }
        await this.overlayService.showInputOverlayForDebug();
        return { success: true };
      }
      case 'focusInputOverlay': {
        this.overlayService.focusInputOverlay();
        return { success: true };
      }
      case 'pasteClipboardIntoInputOverlay': {
        this.overlayService.pasteClipboardIntoInputOverlay();
        return { success: true };
      }
      case 'replaceInputOverlayWithClipboard': {
        this.overlayService.replaceInputOverlayWithClipboard();
        return { success: true };
      }
      case 'setInputOverlayText': {
        this.overlayService.setInputOverlayText(String(request.params?.text ?? ''));
        return { success: true };
      }
      case 'submitInputOverlay': {
        await this.overlayService.submitInputOverlay();
        return { success: true };
      }
      case 'forceResetOverlay': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('forceResetOverlay is only available in form tests mode');
        }
        const reason = typeof request.params?.reason === 'string'
          ? request.params.reason
          : 'debug_command';
        this.overlayService.forceResetForDebug(reason);
        return { success: true };
      }
      case 'removeInputOverlayContextItem': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('removeInputOverlayContextItem is only available in form tests mode');
        }
        const id = typeof request.params?.id === 'string'
          ? request.params.id.trim()
          : '';
        if (!id) {
          throw new Error('Missing context item id');
        }
        this.overlayService.removeInputOverlayContextItemForDebug(id);
        return { success: true };
      }
      case 'addInputOverlayFileReferences': {
        const rawFiles = Array.isArray(request.params?.files) ? request.params.files : [];
        const files = rawFiles.map((raw, index): OverlayFileContextItem => {
          const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
          const filePath = typeof record.filePath === 'string' ? path.resolve(record.filePath) : '';
          const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : undefined;
          if (!filePath && !dataUrl) {
            throw new Error(`Missing filePath or dataUrl for file reference ${index + 1}`);
          }
          const stat = filePath ? fs.statSync(filePath) : null;
          const dataUrlSize = dataUrl
            ? Buffer.from(dataUrl.split(',')[1] ?? '', 'base64').byteLength
            : 0;
          const explicitSize = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes)
            ? record.sizeBytes
            : null;
          const mimeType = typeof record.mimeType === 'string'
            ? record.mimeType
            : filePath.endsWith('.json')
              ? 'application/json'
              : filePath.endsWith('.csv')
                ? 'text/csv'
                : 'text/plain';
          return {
            id: `debug-file-${Date.now()}-${index}`,
            kind: 'file',
            role: 'reference',
            name: typeof record.name === 'string' ? record.name : path.basename(filePath) || 'Dropped file',
            mimeType,
            filePath: filePath || null,
            dataUrl,
            sizeBytes: explicitSize ?? stat?.size ?? dataUrlSize,
          };
        });
        this.overlayService.addInputOverlayFileReferences(files);
        return { success: true };
      }
      case 'selectInputOverlayTargetScope': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('selectInputOverlayTargetScope is only available in form tests mode');
        }
        const rawBounds = request.params?.bounds;
        const bounds = rawBounds && typeof rawBounds === 'object'
          ? rawBounds as Record<string, unknown>
          : null;
        const parsedBounds = {
          x: Number(bounds?.x),
          y: Number(bounds?.y),
          width: Number(bounds?.width),
          height: Number(bounds?.height),
        };
        if (!Number.isFinite(parsedBounds.x)
          || !Number.isFinite(parsedBounds.y)
          || !Number.isFinite(parsedBounds.width)
          || !Number.isFinite(parsedBounds.height)
        ) {
          throw new Error(`Invalid bounds for selectInputOverlayTargetScope: ${JSON.stringify(rawBounds)}`);
        }
        this.overlayService.selectInputOverlayTargetScopeForDebug(parsedBounds);
        return { success: true };
      }
      case 'setOverlaySettings': {
        const patch = request.params ?? {};
        const { getInterpreterOverlaySettings, setInterpreterOverlaySettings } = await import('../../../server/handlers/settings');
        const current = (await getInterpreterOverlaySettings()).settings;
        const requestedEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
        const accountUserId = requestedEnabled
          ? current.accountUserId ?? getCurrentOverlayAccountUserId()
          : current.accountUserId;
        const nextSettings: InterpreterOverlaySettings = {
          accountUserId,
          enabled: requestedEnabled,
          permissionSetupPending: typeof patch.permissionSetupPending === 'boolean'
            ? patch.permissionSetupPending
            : current.permissionSetupPending,
          hotkey: typeof patch.hotkey === 'string' ? patch.hotkey : current.hotkey,
          preferredWorkspacePath: typeof patch.preferredWorkspacePath === 'string'
            ? patch.preferredWorkspacePath
            : current.preferredWorkspacePath,
          preferredNoWorkspace: typeof patch.preferredNoWorkspace === 'boolean'
            ? patch.preferredNoWorkspace
            : current.preferredNoWorkspace,
          preferredProfileId: typeof patch.preferredProfileId === 'string'
            ? patch.preferredProfileId
            : current.preferredProfileId,
          advancedVoiceEnabled: typeof patch.advancedVoiceEnabled === 'boolean'
            ? patch.advancedVoiceEnabled
            : current.advancedVoiceEnabled,
          advancedVoiceWorkspacePath: typeof patch.advancedVoiceWorkspacePath === 'string'
            ? patch.advancedVoiceWorkspacePath
            : current.advancedVoiceWorkspacePath,
          advancedVoiceModel: typeof patch.advancedVoiceModel === 'string'
            ? patch.advancedVoiceModel
            : current.advancedVoiceModel,
          hiddenAgentModel: typeof patch.hiddenAgentModel === 'string'
            ? patch.hiddenAgentModel
            : current.hiddenAgentModel,
          readToolPromptInjectionGuard: current.readToolPromptInjectionGuard,
        };
        const result = await setInterpreterOverlaySettings(nextSettings);
        await this.overlayService.applySettingsForDebug(result.settings);
        return { success: true, settings: result.settings };
      }
      case 'setRuntimeApprovalPolicy': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('setRuntimeApprovalPolicy is only available in form tests mode');
        }
        const policy = String(request.params?.policy ?? '').trim();
        const { getCodexApprovalPolicy, setCodexApprovalPolicy } = await import('../../../server/configStore');
        const previousPolicy = await getCodexApprovalPolicy();
        if (!['never', 'on-failure', 'on-request', 'untrusted'].includes(policy)) {
          throw new Error(`Invalid runtime approval policy: ${policy}`);
        }
        await setCodexApprovalPolicy(policy as typeof previousPolicy);
        return { success: true, previousPolicy, policy };
      }
      case 'setCuaAccessPolicy': {
        if (process.env.FORM_TESTS_MODE !== 'true') {
          throw new Error('setCuaAccessPolicy is only available in form tests mode');
        }
        const { getCuaAccessPolicy, setCuaAccessPolicy } = await import('../../../server/configStore');
        const previousPolicy = await getCuaAccessPolicy();
        const policy = await setCuaAccessPolicy(request.params?.policy as CuaAccessPolicy);
        return { success: true, previousPolicy, policy };
      }
      default:
        throw new Error(`Unknown command: ${request.command}`);
    }
  }
}
