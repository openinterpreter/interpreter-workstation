import type {
  App,
  BrowserWindow,
  Certificate,
  Details as ChildProcessGoneDetails,
  Event as ElectronEvent,
  RenderProcessGoneDetails,
  Session,
  WebContents,
  WebFrameMain,
} from 'electron';

type BreadcrumbLevel = 'info' | 'warning' | 'error';

type AppEventLike = Pick<App, 'getName' | 'getVersion' | 'isPackaged' | 'isReady' | 'on' | 'quit'>;

type WebContentsLike = Pick<WebContents, 'id'>
  & Partial<Pick<WebContents, 'getOSProcessId' | 'getTitle' | 'getType' | 'getURL' | 'isDestroyed' | 'mainFrame'>>;

type WebFrameMainLike = Partial<
  Pick<
    WebFrameMain,
    'detached'
    | 'frameToken'
    | 'frameTreeNodeId'
    | 'name'
    | 'origin'
    | 'osProcessId'
    | 'processId'
    | 'routingId'
    | 'url'
    | 'visibilityState'
  >
>;

type BrowserWindowLike = Pick<BrowserWindow, 'id' | 'isDestroyed'>
  & Partial<Pick<BrowserWindow, 'getBounds' | 'getTitle' | 'isFocused' | 'isMinimized' | 'isVisible' | 'webContents'>>;

type CertificateLike = Partial<
  Pick<Certificate, 'fingerprint' | 'issuerName' | 'serialNumber' | 'subjectName' | 'validExpiry' | 'validStart'>
>;

type SessionLike = { partition?: string } & Partial<Pick<Session, 'getStoragePath'>>;

type EventLike = Partial<Pick<ElectronEvent, 'defaultPrevented' | 'preventDefault'>>;

type Breadcrumb = {
  category: 'app.lifecycle';
  data?: Record<string, unknown>;
  level: BreadcrumbLevel;
  message: string;
};

type LoggerLike = Pick<Console, 'error' | 'log' | 'warn'>;

type QuitState = {
  appReady: boolean;
  isQuitting: boolean;
  isUpdating: boolean;
};

type Fn = (...args: any[]) => any;
type AssertNever<T extends never> = T;

type OverloadUnion<T> =
  T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
    (...args: infer A4): infer R4;
    (...args: infer A5): infer R5;
    (...args: infer A6): infer R6;
    (...args: infer A7): infer R7;
    (...args: infer A8): infer R8;
    (...args: infer A9): infer R9;
    (...args: infer A10): infer R10;
    (...args: infer A11): infer R11;
    (...args: infer A12): infer R12;
    (...args: infer A13): infer R13;
    (...args: infer A14): infer R14;
    (...args: infer A15): infer R15;
    (...args: infer A16): infer R16;
    (...args: infer A17): infer R17;
    (...args: infer A18): infer R18;
    (...args: infer A19): infer R19;
    (...args: infer A20): infer R20;
    (...args: infer A21): infer R21;
    (...args: infer A22): infer R22;
    (...args: infer A23): infer R23;
    (...args: infer A24): infer R24;
    (...args: infer A25): infer R25;
    (...args: infer A26): infer R26;
    (...args: infer A27): infer R27;
    (...args: infer A28): infer R28;
    (...args: infer A29): infer R29;
    (...args: infer A30): infer R30;
  }
    ? ((...args: A1) => R1)
    | ((...args: A2) => R2)
    | ((...args: A3) => R3)
    | ((...args: A4) => R4)
    | ((...args: A5) => R5)
    | ((...args: A6) => R6)
    | ((...args: A7) => R7)
    | ((...args: A8) => R8)
    | ((...args: A9) => R9)
    | ((...args: A10) => R10)
    | ((...args: A11) => R11)
    | ((...args: A12) => R12)
    | ((...args: A13) => R13)
    | ((...args: A14) => R14)
    | ((...args: A15) => R15)
    | ((...args: A16) => R16)
    | ((...args: A17) => R17)
    | ((...args: A18) => R18)
    | ((...args: A19) => R19)
    | ((...args: A20) => R20)
    | ((...args: A21) => R21)
    | ((...args: A22) => R22)
    | ((...args: A23) => R23)
    | ((...args: A24) => R24)
    | ((...args: A25) => R25)
    | ((...args: A26) => R26)
    | ((...args: A27) => R27)
    | ((...args: A28) => R28)
    | ((...args: A29) => R29)
    | ((...args: A30) => R30)
    : T extends Fn
      ? T
      : never;

type ElectronAppLifecycleEventName = Parameters<OverloadUnion<App['on']>>[0];
type ElectronAppLifecycleOnOverload = OverloadUnion<App['on']>;
type ElectronAppLifecycleEventListener<E extends ElectronAppLifecycleEventName> =
  Extract<ElectronAppLifecycleOnOverload, (event: E, listener: any) => any> extends (
    event: E,
    listener: infer L,
  ) => any
    ? L
    : never;

export const APP_LIFECYCLE_EVENT_NAMES = [
  'accessibility-support-changed',
  'activate',
  'activity-was-continued',
  'before-quit',
  'browser-window-blur',
  'browser-window-created',
  'browser-window-focus',
  'certificate-error',
  'child-process-gone',
  'continue-activity',
  'continue-activity-error',
  'did-become-active',
  'did-resign-active',
  'gpu-info-update',
  'login',
  'new-window-for-tab',
  'open-file',
  'open-url',
  'quit',
  'ready',
  'render-process-gone',
  'second-instance',
  'select-client-certificate',
  'session-created',
  'update-activity-state',
  'web-contents-created',
  'will-continue-activity',
  'will-finish-launching',
  'will-quit',
  'window-all-closed',
] as const satisfies readonly ElectronAppLifecycleEventName[];

type AppLifecycleEventName = typeof APP_LIFECYCLE_EVENT_NAMES[number];
type MissingAppLifecycleEventNames = Exclude<ElectronAppLifecycleEventName, AppLifecycleEventName>;
type _AssertNoMissingAppLifecycleEventNames = AssertNever<MissingAppLifecycleEventNames>;
type AppLifecycleEventHandlerMap = {
  [K in AppLifecycleEventName]: ElectronAppLifecycleEventListener<K>;
};

type ExternalOpenTarget = {
  kind: string;
  path: string;
};

export type ElectronAppLifecycleDependencies = {
  app: AppEventLike;
  addBreadcrumb: (breadcrumb: Breadcrumb) => void;
  canHandleActivate: () => boolean;
  cleanup: () => Promise<void>;
  createWindow: () => Promise<unknown> | unknown;
  customProtocol: string;
  findExternalAskTargetsInArgv: (argv: string[]) => string[];
  findExternalOpenTargetInArgv: (argv: string[]) => ExternalOpenTarget | null;
  getAllWindows: () => BrowserWindowLike[];
  getFocusedWindow: () => BrowserWindowLike | null;
  getMainWindow: () => BrowserWindowLike | null;
  getMainWindowLaunchState: () => Record<string, unknown> | null;
  getQuitState: () => QuitState;
  getUserSuppliedArgv: (argv: string[]) => string[];
  handleDeepLink: (url: string) => void;
  handleExternalAskPaths: (paths: string[]) => Promise<void> | void;
  handleExternalOpenPath: (path: string) => Promise<void> | void;
  isOverlayVisible: () => boolean;
  logger: LoggerLike;
  noteAppChildProcessGone: () => void;
  noteMainWindowRendererGone: () => Promise<void> | void;
  noteSecondInstanceHandoff: () => void;
  shouldQuitWhenAllWindowsClosed: () => boolean;
  shouldTrackOoEditorsMainRendererGone: (options: {
    reason: RenderProcessGoneDetails['reason'];
    rendererUrl: string;
  }) => boolean;
  showMainWindow: () => void;
};

type EventHandler = (...args: unknown[]) => unknown;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_ENTRIES = 12;
const MAX_STRING_LENGTH = 240;

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : value;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function asEvent(value: unknown): EventLike | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as EventLike;
}

function getEventDefaultPrevented(value: unknown): boolean | null {
  const event = asEvent(value);
  return typeof event?.defaultPrevented === 'boolean' ? event.defaultPrevented : null;
}

function preventDefault(value: unknown): boolean | null {
  const event = asEvent(value);
  if (!event || typeof event.preventDefault !== 'function') {
    return null;
  }
  event.preventDefault();
  return getEventDefaultPrevented(event);
}

function serializeUrl(value: string): Record<string, unknown> {
  try {
    const parsed = new URL(value);
    return {
      displayUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
      hasHash: parsed.hash.length > 0,
      hasPassword: parsed.password.length > 0,
      hasUsername: parsed.username.length > 0,
      host: parsed.host || null,
      pathname: parsed.pathname || null,
      protocol: parsed.protocol,
      searchKeys: [...parsed.searchParams.keys()],
    };
  } catch {
    return { value: truncateString(value) };
  }
}

function serializeUnknown(value: unknown, depth: number = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value === 'function') {
    return '[Function]';
  }

  if (depth >= 2) {
    return '[MaxDepth]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => serializeUnknown(entry, depth + 1));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const result: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value).slice(0, MAX_OBJECT_ENTRIES)) {
    result[key] = serializeUnknown(nestedValue, depth + 1);
  }
  return result;
}

function serializeArg(value: string): unknown {
  return value.includes('://') ? serializeUrl(value) : truncateString(value);
}

function serializeCertificate(certificate: CertificateLike | undefined): Record<string, unknown> | null {
  if (!certificate) {
    return null;
  }

  return {
    fingerprint: certificate.fingerprint ?? null,
    issuerName: certificate.issuerName ?? null,
    serialNumber: certificate.serialNumber ?? null,
    subjectName: certificate.subjectName ?? null,
    validExpiry: certificate.validExpiry ?? null,
    validStart: certificate.validStart ?? null,
  };
}

function serializeSession(session: SessionLike | undefined): Record<string, unknown> | null {
  if (!session) {
    return null;
  }

  const getStoragePath = session.getStoragePath;

  return {
    partition: session.partition ?? null,
    storagePath: typeof getStoragePath === 'function'
      ? safeCall(() => getStoragePath.call(session) ?? null, null)
      : null,
  };
}

function serializeMainFrame(frame: WebFrameMainLike | undefined): Record<string, unknown> | null {
  if (!frame) {
    return null;
  }

  const url = safeCall(() => frame.url, null);

  return {
    detached: safeCall(() => frame.detached ?? null, null),
    frameToken: safeCall(() => frame.frameToken ?? null, null),
    frameTreeNodeId: safeCall(() => frame.frameTreeNodeId ?? null, null),
    name: safeCall(() => frame.name ?? null, null),
    origin: safeCall(() => frame.origin ?? null, null),
    osProcessId: safeCall(() => frame.osProcessId ?? null, null),
    processId: safeCall(() => frame.processId ?? null, null),
    routingId: safeCall(() => frame.routingId ?? null, null),
    url: typeof url === 'string' ? serializeUrl(url) : null,
    visibilityState: safeCall(() => frame.visibilityState ?? null, null),
  };
}

function serializeWebContents(webContents: WebContentsLike | undefined): Record<string, unknown> | null {
  if (!webContents) {
    return null;
  }

  const isDestroyed = webContents.isDestroyed;
  const getOSProcessId = webContents.getOSProcessId;
  const getTitle = webContents.getTitle;
  const getType = webContents.getType;
  const getURL = webContents.getURL;

  return {
    id: webContents.id,
    isDestroyed: typeof isDestroyed === 'function'
      ? safeCall(() => isDestroyed.call(webContents), false)
      : null,
    mainFrame: safeCall(() => serializeMainFrame(webContents.mainFrame), null),
    osProcessId: typeof getOSProcessId === 'function'
      ? safeCall(() => getOSProcessId.call(webContents), -1)
      : null,
    title: typeof getTitle === 'function'
      ? safeCall(() => getTitle.call(webContents), '')
      : null,
    type: typeof getType === 'function'
      ? safeCall(() => getType.call(webContents), '')
      : null,
    url: typeof getURL === 'function'
      ? serializeUnknown(safeCall(() => getURL.call(webContents), ''))
      : null,
  };
}

function serializeWindow(window: BrowserWindowLike | null | undefined): Record<string, unknown> | null {
  if (!window) {
    return null;
  }

  const getBounds = window.getBounds;
  const isFocused = window.isFocused;
  const isMinimized = window.isMinimized;
  const isVisible = window.isVisible;
  const getTitle = window.getTitle;

  return {
    bounds: typeof getBounds === 'function'
      ? safeCall(() => getBounds.call(window), null)
      : null,
    id: window.id,
    isDestroyed: safeCall(() => window.isDestroyed(), false),
    isFocused: typeof isFocused === 'function'
      ? safeCall(() => isFocused.call(window), false)
      : null,
    isMinimized: typeof isMinimized === 'function'
      ? safeCall(() => isMinimized.call(window), false)
      : null,
    isVisible: typeof isVisible === 'function'
      ? safeCall(() => isVisible.call(window), false)
      : null,
    title: typeof getTitle === 'function'
      ? safeCall(() => getTitle.call(window), '')
      : null,
    webContents: serializeWebContents(window.webContents),
  };
}

function getCommonLifecycleData(deps: ElectronAppLifecycleDependencies): Record<string, unknown> {
  const windows = deps.getAllWindows();
  const focusedWindow = deps.getFocusedWindow();
  const mainWindow = deps.getMainWindow();
  const quitState = deps.getQuitState();

  return {
    appName: safeCall(() => deps.app.getName(), 'unknown'),
    appReady: quitState.appReady,
    appVersion: safeCall(() => deps.app.getVersion(), 'unknown'),
    electronReady: safeCall(() => deps.app.isReady(), false),
    focusedWindowId: focusedWindow?.id ?? null,
    isPackaged: deps.app.isPackaged,
    isQuitting: quitState.isQuitting,
    isUpdating: quitState.isUpdating,
    mainWindowId: mainWindow?.id ?? null,
    pid: process.pid,
    platform: process.platform,
    windowCount: windows.length,
  };
}

function addLifecycleBreadcrumb(
  deps: ElectronAppLifecycleDependencies,
  eventName: string,
  level: BreadcrumbLevel,
  data: Record<string, unknown> = {},
): void {
  deps.addBreadcrumb({
    category: 'app.lifecycle',
    data: {
      ...getCommonLifecycleData(deps),
      ...data,
    },
    level,
    message: eventName,
  });
}

function addAppMethodBreadcrumb(
  deps: ElectronAppLifecycleDependencies,
  method: 'app.quit',
  data: Record<string, unknown>,
): void {
  addLifecycleBreadcrumb(deps, method, 'info', data);
}

async function cleanupAndResumeQuit(
  deps: ElectronAppLifecycleDependencies,
  sourceEvent: 'before-quit' | 'will-quit',
): Promise<void> {
  await deps.cleanup();
  addAppMethodBreadcrumb(deps, 'app.quit', { sourceEvent });
  // NOTE(victor): VS Code resumes normal shutdown with app.quit()
  // after async will-quit work and reserves app.exit() for abnormal kill paths
  // after destroying windows:
  // https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts#L316-L342
  // https://github.com/microsoft/vscode/blob/b4b5c20cbbaa6de0c0c1f5430519ee3f3080c53b/src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts#L480-L555
  // Signal Desktop's normal shutdown path also uses app.quit():
  // https://github.com/signalapp/Signal-Desktop/blob/a8f91c2c20bc21a4c40c0fcca67beeeeee61915b/app/main.main.ts#L959-L966
  deps.app.quit();
}

function runBackgroundTask(
  deps: ElectronAppLifecycleDependencies,
  taskName: string,
  task: () => Promise<unknown> | unknown,
): void {
  try {
    const result = task();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).catch((error) => {
        deps.logger.error(`[AppLifecycle] ${taskName} failed:`, error);
      });
    }
  } catch (error) {
    deps.logger.error(`[AppLifecycle] ${taskName} failed:`, error);
  }
}

function createLifecycleHandlers(
  deps: ElectronAppLifecycleDependencies,
): AppLifecycleEventHandlerMap {
  return {
    'accessibility-support-changed': (event, accessibilitySupportEnabled) => {
      addLifecycleBreadcrumb(deps, 'accessibility-support-changed', 'info', {
        accessibilitySupportEnabled: Boolean(accessibilitySupportEnabled),
        defaultPrevented: getEventDefaultPrevented(event),
      });
    },
    activate: async (event, hasVisibleWindows) => {
      addLifecycleBreadcrumb(deps, 'activate', 'info', {
        canHandleActivate: deps.canHandleActivate(),
        defaultPrevented: getEventDefaultPrevented(event),
        hasVisibleWindows: Boolean(hasVisibleWindows),
      });

      if (!deps.canHandleActivate()) {
        return;
      }

      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        await deps.createWindow();
        return;
      }

      if (deps.isOverlayVisible()) {
        return;
      }

      deps.showMainWindow();
    },
    'activity-was-continued': (event, type, userInfo) => {
      addLifecycleBreadcrumb(deps, 'activity-was-continued', 'info', {
        activityType: serializeUnknown(type),
        defaultPrevented: getEventDefaultPrevented(event),
        userInfo: serializeUnknown(userInfo),
      });
    },
    'before-quit': async (event) => {
      const state = deps.getQuitState();
      const defaultPreventedBefore = getEventDefaultPrevented(event);
      const willInterceptQuit = !state.isUpdating && state.appReady && !state.isQuitting;
      const defaultPreventedAfter = willInterceptQuit ? preventDefault(event) : defaultPreventedBefore;

      deps.logger.log('[AppLifecycle] before-quit', {
        appReady: state.appReady,
        isQuitting: state.isQuitting,
        isUpdating: state.isUpdating,
      });

      addLifecycleBreadcrumb(deps, 'before-quit', 'info', {
        defaultPreventedAfter,
        defaultPreventedBefore,
        willInterceptQuit,
      });

      if (!willInterceptQuit) {
        return;
      }
      await cleanupAndResumeQuit(deps, 'before-quit');
    },
    'browser-window-blur': (event, window) => {
      addLifecycleBreadcrumb(deps, 'browser-window-blur', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
        window: serializeWindow(window),
      });
    },
    'browser-window-created': (event, window) => {
      addLifecycleBreadcrumb(deps, 'browser-window-created', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
        window: serializeWindow(window),
      });
    },
    'browser-window-focus': (event, window) => {
      addLifecycleBreadcrumb(deps, 'browser-window-focus', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
        window: serializeWindow(window),
      });
    },
    'certificate-error': (event, webContents, url, error, certificate, _callback, isMainFrame) => {
      addLifecycleBreadcrumb(deps, 'certificate-error', 'warning', {
        certificate: serializeCertificate(certificate),
        defaultPrevented: getEventDefaultPrevented(event),
        error: serializeUnknown(error),
        isMainFrame: Boolean(isMainFrame),
        url: typeof url === 'string' ? serializeUrl(url) : serializeUnknown(url),
        webContents: serializeWebContents(webContents),
      });
    },
    'child-process-gone': (event, details) => {
      const typedDetails: ChildProcessGoneDetails = details;
      const exitCode = typedDetails.exitCode;
      const reason = typedDetails.reason;

      addLifecycleBreadcrumb(
        deps,
        'child-process-gone',
        reason === 'clean-exit' ? 'info' : 'warning',
        {
          defaultPrevented: getEventDefaultPrevented(event),
          exitCode,
          name: typedDetails.name ?? null,
          reason,
          serviceName: typedDetails.serviceName ?? null,
          type: typedDetails.type ?? null,
        },
      );

      if (reason !== 'clean-exit') {
        deps.logger.error('[AppLifecycle] child-process-gone', {
          exitCode,
          name: typedDetails.name ?? null,
          reason,
          serviceName: typedDetails.serviceName ?? null,
          type: typedDetails.type ?? null,
        });
        deps.noteAppChildProcessGone();
      }
    },
    'continue-activity': (event, type, userInfo, details) => {
      addLifecycleBreadcrumb(deps, 'continue-activity', 'info', {
        activityType: serializeUnknown(type),
        defaultPrevented: getEventDefaultPrevented(event),
        details: serializeUnknown(details),
        userInfo: serializeUnknown(userInfo),
      });
    },
    'continue-activity-error': (event, type, error) => {
      addLifecycleBreadcrumb(deps, 'continue-activity-error', 'warning', {
        activityType: serializeUnknown(type),
        defaultPrevented: getEventDefaultPrevented(event),
        error: serializeUnknown(error),
      });
    },
    'did-become-active': (event) => {
      addLifecycleBreadcrumb(deps, 'did-become-active', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
      });
    },
    'did-resign-active': (event) => {
      addLifecycleBreadcrumb(deps, 'did-resign-active', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
      });
    },
    'gpu-info-update': () => {
      addLifecycleBreadcrumb(deps, 'gpu-info-update', 'info');
    },
    login: (event, webContents, authenticationResponseDetails, authInfo) => {
      addLifecycleBreadcrumb(deps, 'login', 'info', {
        authInfo: serializeUnknown(authInfo),
        authenticationResponseDetails: serializeUnknown(authenticationResponseDetails),
        defaultPrevented: getEventDefaultPrevented(event),
        webContents: serializeWebContents(webContents),
      });
    },
    'new-window-for-tab': (event) => {
      addLifecycleBreadcrumb(deps, 'new-window-for-tab', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
      });
    },
    'open-file': (event, filePath) => {
      const defaultPreventedBefore = getEventDefaultPrevented(event);
      const defaultPreventedAfter = preventDefault(event);
      deps.logger.log('[Main] Received external open (open-file):', filePath);
      addLifecycleBreadcrumb(deps, 'open-file', 'info', {
        defaultPreventedAfter,
        defaultPreventedBefore,
        filePath: serializeUnknown(filePath),
      });
      runBackgroundTask(deps, 'handleExternalOpenPath(open-file)', () => (
        typeof filePath === 'string' ? deps.handleExternalOpenPath(filePath) : undefined
      ));
    },
    'open-url': (event, url) => {
      const defaultPreventedBefore = getEventDefaultPrevented(event);
      const defaultPreventedAfter = preventDefault(event);
      deps.logger.log('[Main] Received deep link (open-url):', url);
      addLifecycleBreadcrumb(deps, 'open-url', 'info', {
        defaultPreventedAfter,
        defaultPreventedBefore,
        url: typeof url === 'string' ? serializeUrl(url) : serializeUnknown(url),
      });

      if (typeof url === 'string') {
        deps.handleDeepLink(url);
      }

      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        deps.showMainWindow();
      }
    },
    quit: (event, exitCode) => {
      addLifecycleBreadcrumb(deps, 'quit', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
        exitCode: typeof exitCode === 'number' ? exitCode : null,
      });
    },
    ready: (event, launchInfo) => {
      addLifecycleBreadcrumb(deps, 'ready', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
        launchInfo: serializeUnknown(launchInfo),
      });
    },
    'render-process-gone': (event, webContents, details) => {
      const typedWebContents: WebContentsLike = webContents;
      const typedDetails: RenderProcessGoneDetails = details;
      const getURL = typedWebContents.getURL;
      const rendererUrl = typeof getURL === 'function'
        ? safeCall(() => getURL.call(typedWebContents), '')
        : '';
      const reason = typedDetails.reason;
      const mainWindow = deps.getMainWindow();
      const isMainWindowProcess = Boolean(
        mainWindow
        && !mainWindow.isDestroyed()
        && mainWindow.webContents
        && typedWebContents.id === mainWindow.webContents.id,
      );
      const mainWindowLaunchState = isMainWindowProcess ? deps.getMainWindowLaunchState() : null;

      deps.logger.error('[AppLifecycle] render-process-gone', {
        exitCode: typedDetails.exitCode ?? null,
        isMainWindowProcess,
        mainWindowLaunchState,
        reason,
        url: rendererUrl || null,
        webContentsId: typedWebContents?.id ?? null,
      });

      addLifecycleBreadcrumb(
        deps,
        'render-process-gone',
        reason === 'clean-exit' ? 'info' : 'warning',
        {
          defaultPrevented: getEventDefaultPrevented(event),
          exitCode: typedDetails.exitCode ?? null,
          isMainWindowProcess,
          mainWindowLaunchState,
          reason,
          url: rendererUrl ? serializeUrl(rendererUrl) : null,
          webContents: serializeWebContents(typedWebContents),
        },
      );

      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      if (!mainWindow.webContents || typedWebContents.id !== mainWindow.webContents.id) {
        return;
      }

      if (!deps.shouldTrackOoEditorsMainRendererGone({ reason, rendererUrl })) {
        return;
      }

      runBackgroundTask(deps, 'noteMainWindowRendererGone', () => deps.noteMainWindowRendererGone());
    },
    'second-instance': (event, argv, workingDirectory, additionalData) => {
      const argvList = Array.isArray(argv) ? argv : [];
      const userSuppliedArgv = deps.getUserSuppliedArgv(argvList);
      const deepLink = userSuppliedArgv.find((value) => value.startsWith(`${deps.customProtocol}://`)) ?? null;
      const externalAskTargets = deps.findExternalAskTargetsInArgv(userSuppliedArgv);
      const externalOpenTarget = externalAskTargets.length > 0
        ? null
        : deps.findExternalOpenTargetInArgv(userSuppliedArgv);

      addLifecycleBreadcrumb(deps, 'second-instance', 'info', {
        additionalData: serializeUnknown(additionalData),
        argv: argvList.map((value) => serializeArg(String(value))),
        argvCount: argvList.length,
        deepLink: deepLink ? serializeUrl(deepLink) : null,
        defaultPrevented: getEventDefaultPrevented(event),
        externalOpenTarget,
        externalAskTargetCount: externalAskTargets.length,
        userSuppliedArgv: userSuppliedArgv.map(serializeArg),
        workingDirectory: serializeUnknown(workingDirectory),
      });

      deps.noteSecondInstanceHandoff();

      if (deepLink) {
        deps.logger.log('[Main] Received deep link (second-instance):', deepLink);
        deps.handleDeepLink(deepLink);
      }

      if (externalOpenTarget) {
        deps.logger.log(
          `[Main] Received ${externalOpenTarget.kind} open (second-instance):`,
          externalOpenTarget.path,
        );
        runBackgroundTask(deps, 'handleExternalOpenPath(second-instance)', () => (
          deps.handleExternalOpenPath(externalOpenTarget.path)
        ));
      }

      if (externalAskTargets.length > 0) {
        deps.logger.log('[Main] Received external ask paths (second-instance):', externalAskTargets.length);
        runBackgroundTask(deps, 'handleExternalAskPaths(second-instance)', () => (
          deps.handleExternalAskPaths(externalAskTargets)
        ));
      }

      if (!externalOpenTarget && externalAskTargets.length === 0 && deps.getMainWindow()) {
        deps.showMainWindow();
      }
    },
    'select-client-certificate': (event, webContents, url, certificateList) => {
      const list = Array.isArray(certificateList)
        ? certificateList.slice(0, MAX_ARRAY_ITEMS).map((certificate) => (
          serializeCertificate(certificate)
        ))
        : [];

      addLifecycleBreadcrumb(deps, 'select-client-certificate', 'info', {
        certificateCount: Array.isArray(certificateList) ? certificateList.length : 0,
        certificates: list,
        defaultPrevented: getEventDefaultPrevented(event),
        url: typeof url === 'string' ? serializeUrl(url) : serializeUnknown(url),
        webContents: serializeWebContents(webContents),
      });
    },
    'session-created': (session) => {
      addLifecycleBreadcrumb(deps, 'session-created', 'info', {
        session: serializeSession(session),
      });
    },
    'update-activity-state': (event, type, userInfo) => {
      addLifecycleBreadcrumb(deps, 'update-activity-state', 'info', {
        activityType: serializeUnknown(type),
        defaultPrevented: getEventDefaultPrevented(event),
        userInfo: serializeUnknown(userInfo),
      });
    },
    'web-contents-created': (event, webContents) => {
      addLifecycleBreadcrumb(deps, 'web-contents-created', 'info', {
        defaultPrevented: getEventDefaultPrevented(event),
        webContents: serializeWebContents(webContents),
      });
    },
    'will-continue-activity': (event, type) => {
      addLifecycleBreadcrumb(deps, 'will-continue-activity', 'info', {
        activityType: serializeUnknown(type),
        defaultPrevented: getEventDefaultPrevented(event),
      });
    },
    'will-finish-launching': () => {
      addLifecycleBreadcrumb(deps, 'will-finish-launching', 'info');
    },
    'will-quit': async (event) => {
      const state = deps.getQuitState();
      const defaultPreventedBefore = getEventDefaultPrevented(event);
      const willInterceptQuit = !state.isUpdating && state.appReady && !state.isQuitting;
      const defaultPreventedAfter = willInterceptQuit ? preventDefault(event) : defaultPreventedBefore;

      deps.logger.log('[AppLifecycle] will-quit', {
        appReady: state.appReady,
        isQuitting: state.isQuitting,
        isUpdating: state.isUpdating,
      });

      addLifecycleBreadcrumb(deps, 'will-quit', 'info', {
        defaultPreventedAfter,
        defaultPreventedBefore,
        willInterceptQuit,
      });

      if (!willInterceptQuit) {
        return;
      }
      await cleanupAndResumeQuit(deps, 'will-quit');
    },
    'window-all-closed': () => {
      const shouldQuit = deps.shouldQuitWhenAllWindowsClosed();
      deps.logger.log('[AppLifecycle] window-all-closed', {
        formTestsMode: process.env.FORM_TESTS_MODE ?? null,
        nodeEnv: process.env.NODE_ENV ?? null,
        shouldQuit,
      });
      addLifecycleBreadcrumb(deps, 'window-all-closed', 'info', {
        shouldQuit,
      });
      if (!shouldQuit) {
        return;
      }

      addAppMethodBreadcrumb(deps, 'app.quit', {
        sourceEvent: 'window-all-closed',
      });
      deps.app.quit();
    },
  };
}

export function registerElectronAppLifecycle(deps: ElectronAppLifecycleDependencies): void {
  const handlers = createLifecycleHandlers(deps);
  deps.app.on('accessibility-support-changed', handlers['accessibility-support-changed']);
  deps.app.on('activate', handlers.activate);
  deps.app.on('activity-was-continued', handlers['activity-was-continued']);
  deps.app.on('before-quit', handlers['before-quit']);
  deps.app.on('browser-window-blur', handlers['browser-window-blur']);
  deps.app.on('browser-window-created', handlers['browser-window-created']);
  deps.app.on('browser-window-focus', handlers['browser-window-focus']);
  deps.app.on('certificate-error', handlers['certificate-error']);
  deps.app.on('child-process-gone', handlers['child-process-gone']);
  deps.app.on('continue-activity', handlers['continue-activity']);
  deps.app.on('continue-activity-error', handlers['continue-activity-error']);
  deps.app.on('did-become-active', handlers['did-become-active']);
  deps.app.on('did-resign-active', handlers['did-resign-active']);
  deps.app.on('gpu-info-update', handlers['gpu-info-update']);
  deps.app.on('login', handlers.login);
  deps.app.on('new-window-for-tab', handlers['new-window-for-tab']);
  deps.app.on('open-file', handlers['open-file']);
  deps.app.on('open-url', handlers['open-url']);
  deps.app.on('quit', handlers.quit);
  deps.app.on('ready', handlers.ready);
  deps.app.on('render-process-gone', handlers['render-process-gone']);
  deps.app.on('second-instance', handlers['second-instance']);
  deps.app.on('select-client-certificate', handlers['select-client-certificate']);
  deps.app.on('session-created', handlers['session-created']);
  deps.app.on('update-activity-state', handlers['update-activity-state']);
  deps.app.on('web-contents-created', handlers['web-contents-created']);
  deps.app.on('will-continue-activity', handlers['will-continue-activity']);
  deps.app.on('will-finish-launching', handlers['will-finish-launching']);
  deps.app.on('will-quit', handlers['will-quit']);
  deps.app.on('window-all-closed', handlers['window-all-closed']);
}
