import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import * as net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { killPortProcessSync } from '../../electron/utils/ports';
import {
  resolveBundledResourceCandidates,
} from './bundledRuntimePaths';
import type {
  BrowserControlBrowserTab,
  BrowserControlBrowserWindow,
  BrowserControlConnection,
  BrowserControlPageElement,
  BrowserControlPageElementFrame,
  BrowserControlPageElementInventory,
  BrowserControlPageElementBounds,
  BrowserControlPageClickResult,
  BrowserControlPageSelectResult,
  BrowserControlPageScrollResult,
  BrowserControlPageTraceResult,
  BrowserControlPageTypeResult,
  BrowserControlStatus,
  BrowserControlTarget,
  BrowserExtensionRelayPhase,
} from '../../shared/types/browserControl';
import type { BrowserAccessPolicy } from '../../shared/browserAccessPolicy';
import { broadcastEvent } from '../handlers/broadcast';
import { getBrowserAccessPolicySync } from '../configStore';
import { getBrowserAccessPolicyWithGrants } from './browserAccessGrants';
import {
  buildBrowserControlProfiles,
  buildBrowserControlProfilesWithLocalMatches,
  discoverLocalBrowserProfiles,
} from './browserProfileDiscovery';

const RELAY_HOST = '127.0.0.1';
const RELAY_PORT = 19988;
const RELAY_HTTP_ENDPOINT = `http://${RELAY_HOST}:${RELAY_PORT}`;
const RELAY_BIND_ENDPOINT = `${RELAY_HOST}:${RELAY_PORT}`;
const DEFAULT_RELAY_READY_TIMEOUT_MS = 30_000;
const RELAY_READY_TIMEOUT_ENV_VAR = 'INTERPRETER_BROWSER_EXTENSION_RELAY_READY_TIMEOUT_MS';
const RELAY_READY_POLL_INTERVAL_MS = 200;
const RELAY_LOG_FILE_NAME = 'browser-extension-relay.log';
const RELAY_CDP_LOG_FILE_NAME = 'browser-extension-relay-cdp.jsonl';
const RELAY_INSTALL_DIR_NAME = 'browser-extension-relay';
const RELAY_RUNTIME_MANIFEST_FILE_NAME = 'runtime-manifest.json';
const RELAY_READY_TIMEOUT_ERROR_FRAGMENT = 'Timed out waiting for relay readiness after';
const RELAY_REQUIRED_RUNTIME_PATHS = [
  'package.json',
  RELAY_RUNTIME_MANIFEST_FILE_NAME,
  path.join('dist', 'start-relay-server.js'),
  path.join('dist', 'extension', 'manifest.json'),
  path.join('node_modules', 'hono', 'package.json'),
] as const;

export function resolveRelayReadyTimeoutMs(value: string | undefined): number {
  if (!value) {
    return DEFAULT_RELAY_READY_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RELAY_READY_TIMEOUT_MS;
  }

  return parsed;
}

const RELAY_READY_TIMEOUT_MS = resolveRelayReadyTimeoutMs(process.env[RELAY_READY_TIMEOUT_ENV_VAR]);

export interface BrowserExtensionRelayStatus {
  phase: BrowserExtensionRelayPhase;
  version: string | null;
  runtimeDir: string | null;
  relayLogPath: string | null;
  relayCdpLogPath: string | null;
  ownsRelayProcess: boolean;
  lastError: string | null;
}

export type BrowserExtensionRelayLifecycleLevel = 'info' | 'warning' | 'error';

export interface BrowserExtensionRelayLifecycleEvent {
  message: string;
  level: BrowserExtensionRelayLifecycleLevel;
  data?: Record<string, unknown>;
}

type BrowserExtensionRelayLifecycleListener = (event: BrowserExtensionRelayLifecycleEvent) => void;

type RelayRuntimeLogger = {
  log: (...args: unknown[]) => Promise<void>;
  error: (...args: unknown[]) => Promise<void>;
  logFilePath: string;
};

type RelayRuntimeCdpLogger = {
  log: (entry: unknown) => void;
  logFilePath: string;
};

export type RelayRuntimeServer = {
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type RelayListenAddressInUseError = Error & NodeJS.ErrnoException & {
  code: 'EADDRINUSE';
  address: typeof RELAY_HOST;
  port: typeof RELAY_PORT;
};

export type RelayAddressConflictRetryResult =
  | { status: 'started'; server: RelayRuntimeServer }
  | { status: 'blocked' };

export type RelayListenAddressAvailabilityResult =
  | { status: 'available' }
  | { status: 'blocked' };

export interface RelayAddressConflictRetryOptions {
  startRelayServer: () => Promise<RelayRuntimeServer>;
  handleInitialAddressConflict: (error: RelayListenAddressInUseError) => Promise<void>;
  handleRetryAddressConflict: (error: RelayListenAddressInUseError) => Promise<void>;
}

export interface RelayListenAddressAvailabilityOptions {
  checkRelayListenAddressAvailable: () => Promise<boolean>;
  handleInitialAddressConflict: (error: RelayListenAddressInUseError) => Promise<void>;
  handleRetryAddressConflict: (error: RelayListenAddressInUseError) => Promise<void>;
}

type RelayRuntimeModules = {
  createFileLogger: (options?: { logFilePath?: string }) => RelayRuntimeLogger;
  createCdpLogger: (options?: { logFilePath?: string; maxStringLength?: number }) => RelayRuntimeCdpLogger;
  startPlayWriterCDPRelayServer: (options?: {
    port?: number;
    host?: string;
    token?: string;
    logger?: RelayRuntimeLogger;
    cdpLogger?: RelayRuntimeCdpLogger;
    enableCliRoutes?: boolean;
    sanitizeBufferInspect?: boolean;
    getAccessPolicy?: () => BrowserAccessPolicy;
  }) => Promise<RelayRuntimeServer>;
};

type RelayRuntimeIntegritySummary = {
  fileCount: number;
  totalBytes: number;
  treeSha256: string;
};

let relayServer: RelayRuntimeServer | null = null;
let relayStateChangeListener: (() => void) | null = null;
let relayStateChangeBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let relayRuntimeModulesPromise: Promise<RelayRuntimeModules> | null = null;
let relayRuntimeModulesDir: string | null = null;
let relayOwnedProcessEnvSnapshot: { playwriterAutoEnable: string | null } | null = null;
let startupPromise: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;
let appOwnsRelayProcess = false;
let lifecycleListener: BrowserExtensionRelayLifecycleListener | null = null;
const relayStatus: BrowserExtensionRelayStatus = {
  phase: 'idle',
  version: null,
  runtimeDir: null,
  relayLogPath: null,
  relayCdpLogPath: null,
  ownsRelayProcess: false,
  lastError: null,
};

const BROWSER_CONTROL_CHANGED_CHANNEL = 'browserControl:changed';
const BROWSER_CONTROL_STATUS_BROADCAST_DEBOUNCE_MS = 150;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRelayListenAddressInUseError(error: unknown): error is RelayListenAddressInUseError {
  if (!(error instanceof Error)) {
    return false;
  }

  const systemError = error as NodeJS.ErrnoException & {
    address?: unknown;
    port?: unknown;
  };
  return (
    systemError.code === 'EADDRINUSE'
    && systemError.address === RELAY_HOST
    && systemError.port === RELAY_PORT
  );
}

function createRelayListenAddressInUseError(): RelayListenAddressInUseError {
  const error = new Error(
    `listen EADDRINUSE: address already in use ${RELAY_BIND_ENDPOINT}`,
  ) as RelayListenAddressInUseError;
  error.code = 'EADDRINUSE';
  error.address = RELAY_HOST;
  error.port = RELAY_PORT;
  return error;
}

function closeRelayServerAfterStartupError(server: RelayRuntimeServer | null): void {
  if (!server) {
    return;
  }

  try {
    server.close();
  } catch (closeError) {
    console.warn('[BrowserExtensionRelay] Failed to close relay server after startup error:', closeError);
    emitRelayLifecycleEvent('failed to close relay server after startup error', 'warning', {
      error: getErrorMessage(closeError),
    });
  }
}

function isRelayListenAddressAvailable(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    const cleanup = () => {
      server.off('error', handleError);
      server.off('listening', handleListening);
    };
    const handleError = (error: NodeJS.ErrnoException) => {
      cleanup();
      if (isRelayListenAddressInUseError(error)) {
        resolve(false);
        return;
      }
      reject(error);
    };
    const handleListening = () => {
      cleanup();
      server.close(() => {
        resolve(true);
      });
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    // NOTE(victor): Probe the exact bind address because this wrapper does not receive the bundled Hono server's raw error event surface.
    server.listen(RELAY_PORT, RELAY_HOST);
  });
}

export async function ensureRelayListenAddressAvailableWithRetry(
  options: RelayListenAddressAvailabilityOptions,
): Promise<RelayListenAddressAvailabilityResult> {
  const listenError = createRelayListenAddressInUseError();

  if (await options.checkRelayListenAddressAvailable()) {
    return { status: 'available' };
  }

  await options.handleInitialAddressConflict(listenError);

  if (await options.checkRelayListenAddressAvailable()) {
    return { status: 'available' };
  }

  await options.handleRetryAddressConflict(listenError);
  return { status: 'blocked' };
}

export async function startRelayServerWithAddressConflictRetry(
  options: RelayAddressConflictRetryOptions,
): Promise<RelayAddressConflictRetryResult> {
  try {
    const server = await options.startRelayServer();
    return { status: 'started', server };
  } catch (error) {
    if (!isRelayListenAddressInUseError(error)) {
      throw error;
    }

    await options.handleInitialAddressConflict(error);
  }

  try {
    const server = await options.startRelayServer();
    return { status: 'started', server };
  } catch (error) {
    if (!isRelayListenAddressInUseError(error)) {
      throw error;
    }

    await options.handleRetryAddressConflict(error);
    return { status: 'blocked' };
  }
}

export function isBrowserExtensionRelayReadyTimeoutError(error: unknown): boolean {
  return getErrorMessage(error).includes(RELAY_READY_TIMEOUT_ERROR_FRAGMENT);
}

function updateRelayStatus(patch: Partial<BrowserExtensionRelayStatus>): void {
  Object.assign(relayStatus, patch);
}

export function getBrowserExtensionRelayStatus(): BrowserExtensionRelayStatus {
  return { ...relayStatus };
}

export function setBrowserExtensionRelayLifecycleListener(
  listener: BrowserExtensionRelayLifecycleListener | null,
): void {
  lifecycleListener = listener;
}

function emitRelayLifecycleEvent(
  message: string,
  level: BrowserExtensionRelayLifecycleLevel,
  data?: Record<string, unknown>,
): void {
  lifecycleListener?.({
    message,
    level,
    data,
  });
}

function broadcastBrowserControlChanged(reason: 'policy' | 'status'): void {
  broadcastEvent(BROWSER_CONTROL_CHANGED_CHANNEL, {
    reason,
    policy: getBrowserAccessPolicySync(),
  });
}

function clearRelayStateChangeListener(): void {
  if (relayStateChangeBroadcastTimer) {
    clearTimeout(relayStateChangeBroadcastTimer);
    relayStateChangeBroadcastTimer = null;
  }
  if (relayServer && relayStateChangeListener) {
    relayServer.off('state:changed', relayStateChangeListener);
  }
  relayStateChangeListener = null;
}

export function formatBrowserExtensionRelayStartupFailureMessage(error: unknown): string {
  const status = getBrowserExtensionRelayStatus();
  const lines = [
    'Interpreter could not start browser control.',
    '',
    'The app launched, but browser control is unavailable until this is fixed.',
    '',
    `Details: ${getErrorMessage(error)}`,
  ];

  if (status.runtimeDir) {
    lines.push(`Relay runtime: ${status.runtimeDir}`);
  }
  if (status.relayLogPath) {
    lines.push(`Relay log: ${status.relayLogPath}`);
  }
  if (status.relayCdpLogPath) {
    lines.push(`CDP log: ${status.relayCdpLogPath}`);
  }

  lines.push('');
  lines.push('Restart Interpreter. If this keeps happening, reinstall the app.');
  return lines.join('\n');
}

export function formatOptionalBrowserExtensionRelayStartupFailureLog(
  error: unknown,
  status: BrowserExtensionRelayStatus = getBrowserExtensionRelayStatus(),
): string {
  return [
    '[BrowserExtensionRelay] Optional startup failed; continuing without browser control.',
    `phase=${status.phase}`,
    `error=${JSON.stringify(getErrorMessage(error))}`,
    `runtimeDir=${status.runtimeDir ?? 'null'}`,
    `relayLogPath=${status.relayLogPath ?? 'null'}`,
    `relayCdpLogPath=${status.relayCdpLogPath ?? 'null'}`,
  ].join(' ');
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  const len = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < len; i += 1) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) {
      return p1 - p2;
    }
  }

  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRelayVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${RELAY_HTTP_ENDPOINT}/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as { version?: unknown };
    return typeof payload.version === 'string' ? payload.version : null;
  } catch {
    return null;
  }
}

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function coerceNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function coerceBoolean(value: unknown): boolean {
  return value === true;
}

function coerceFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

type NormalizedRelayTarget = Omit<BrowserControlTarget, 'tabRef'>;

function normalizeBrowserControlTarget(raw: unknown): NormalizedRelayTarget | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const target = raw as Record<string, unknown>;
  const targetId = coerceString(target.targetId);
  if (!targetId) {
    return null;
  }

  return {
    targetId,
    type: coerceString(target.type) ?? 'unknown',
    title: coerceString(target.title) ?? '',
    url: coerceString(target.url) ?? '',
    controlSource: target.shareSource === 'user'
      || target.shareSource === 'agent-created'
      || target.shareSource === 'auto-created'
      ? target.shareSource
      : undefined,
  };
}

function browserControlTabRef(connection: { extensionId: string; stableKey: string | null }, targetId: string): string {
  return `${connection.stableKey ?? connection.extensionId}:${targetId}`;
}

function browserControlChromeTabRef(
  connection: { extensionId: string; stableKey: string | null },
  chromeTabId: number,
): string {
  return `${connection.stableKey ?? connection.extensionId}:chrome-tab:${chromeTabId}`;
}

function browserControlProfileId(connection: { extensionId: string; stableKey: string | null }): string {
  return connection.stableKey ?? connection.extensionId;
}

function normalizeBrowserControlBrowserTab(
  raw: unknown,
  connection: { extensionId: string; stableKey: string | null },
): BrowserControlBrowserTab | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const tab = raw as Record<string, unknown>;
  const chromeTabId = coerceNonNegativeInteger(tab.chromeTabId);
  if (!chromeTabId) {
    return null;
  }

  const targetId = coerceString(tab.targetId);
  const sessionId = coerceString(tab.sessionId);
  const rawControlState = coerceString(tab.controlState);
  const controlStateDetail = coerceString(tab.controlStateDetail) ?? coerceString(tab.shareState);
  const controlState = rawControlState === 'observable' || rawControlState === 'controllable'
    ? rawControlState
    : coerceBoolean(tab.shared)
      ? 'controllable'
      : 'observable';

  return {
    tabRef: browserControlChromeTabRef(connection, chromeTabId),
    chromeTabId,
    windowId: coerceNonNegativeInteger(tab.windowId),
    index: coerceNonNegativeInteger(tab.index),
    active: coerceBoolean(tab.active),
    highlighted: coerceBoolean(tab.highlighted),
    pinned: coerceBoolean(tab.pinned),
    title: coerceString(tab.title) ?? '',
    url: coerceString(tab.url) ?? '',
    status: coerceString(tab.status) ?? 'unknown',
    controlState,
    ...(controlStateDetail ? { controlStateDetail } : {}),
    ...(targetId ? { targetId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function normalizeBrowserControlBrowserWindow(
  raw: unknown,
  connection: { extensionId: string; stableKey: string | null },
): BrowserControlBrowserWindow | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const window = raw as Record<string, unknown>;
  const windowId = coerceNonNegativeInteger(window.windowId);
  if (!windowId) {
    return null;
  }

  const rawTabs = Array.isArray(window.tabs) ? window.tabs : [];

  return {
    windowId,
    focused: coerceBoolean(window.focused),
    type: coerceString(window.type) ?? 'unknown',
    state: coerceString(window.state) ?? 'unknown',
    tabs: rawTabs
      .map((tab) => normalizeBrowserControlBrowserTab(tab, connection))
      .filter((tab): tab is BrowserControlBrowserTab => tab !== null),
  };
}

function normalizeBrowserControlPageElement(raw: unknown): BrowserControlPageElement | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const element = raw as Record<string, unknown>;
  const refId = coerceString(element.refId);
  const bounds = element.bounds && typeof element.bounds === 'object'
    ? element.bounds as Record<string, unknown>
    : null;
  if (!refId || !bounds) {
    return null;
  }
  const width = coerceFiniteNumber(bounds.width);
  const height = coerceFiniteNumber(bounds.height);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const checked = typeof element.checked === 'boolean' ? element.checked : null;
  return {
    refId,
    index: coerceNonNegativeInteger(element.index),
    tagName: coerceString(element.tagName) ?? 'unknown',
    role: coerceString(element.role) ?? 'unknown',
    name: coerceString(element.name) ?? '',
    text: coerceString(element.text) ?? '',
    value: coerceString(element.value),
    inputType: coerceString(element.inputType),
    checked,
    disabled: coerceBoolean(element.disabled),
    editable: coerceBoolean(element.editable),
    clickable: coerceBoolean(element.clickable),
    bounds: {
      x: coerceFiniteNumber(bounds.x),
      y: coerceFiniteNumber(bounds.y),
      width,
      height,
    },
  };
}

function normalizeBrowserControlPageElementFrame(
  raw: unknown,
  maxElementsPerFrame: number,
): BrowserControlPageElementFrame | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const frame = raw as Record<string, unknown>;
  const frameId = coerceNonNegativeInteger(frame.frameId);
  const documentRevision = coerceString(frame.documentRevision);
  const rawElements = Array.isArray(frame.elements) ? frame.elements : [];
  if (!documentRevision) {
    return null;
  }
  const viewport = frame.viewport && typeof frame.viewport === 'object'
    ? frame.viewport as Record<string, unknown>
    : {};
  const rawScreenBounds = viewport.screenBounds && typeof viewport.screenBounds === 'object'
    ? viewport.screenBounds as Record<string, unknown>
    : null;
  const rawScreenWidth = rawScreenBounds ? coerceFiniteNumber(rawScreenBounds.width) : 0;
  const rawScreenHeight = rawScreenBounds ? coerceFiniteNumber(rawScreenBounds.height) : 0;
  const screenBounds = rawScreenBounds && rawScreenWidth > 0 && rawScreenHeight > 0
    ? {
        x: coerceFiniteNumber(rawScreenBounds.x),
        y: coerceFiniteNumber(rawScreenBounds.y),
        width: rawScreenWidth,
        height: rawScreenHeight,
      }
    : null;
  const elements = rawElements
    .map(normalizeBrowserControlPageElement)
    .filter((element): element is BrowserControlPageElement => element !== null);
  const boundedElements = elements.slice(0, maxElementsPerFrame);

  return {
    frameId,
    chromeDocumentId: coerceString(frame.chromeDocumentId),
    url: coerceString(frame.url) ?? '',
    documentRevision,
    viewport: {
      width: coerceFiniteNumber(viewport.width),
      height: coerceFiniteNumber(viewport.height),
      scrollX: coerceFiniteNumber(viewport.scrollX),
      scrollY: coerceFiniteNumber(viewport.scrollY),
      devicePixelRatio: coerceFiniteNumber(viewport.devicePixelRatio) || 1,
      screenBounds,
    },
    selectionText: coerceString(frame.selectionText) ?? '',
    totalElementCount: elements.length,
    returnedElementCount: boundedElements.length,
    truncatedElementCount: Math.max(0, elements.length - boundedElements.length),
    elements: boundedElements,
  };
}

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function normalizeBrowserControlConnection(raw: unknown): BrowserControlConnection | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const connection = raw as Record<string, unknown>;
  const extensionId = coerceString(connection.extensionId);
  if (!extensionId) {
    return null;
  }

  const rawTargets = Array.isArray(connection.targets) ? connection.targets : [];
  const browserTabs = connection.browserTabs && typeof connection.browserTabs === 'object'
    ? connection.browserTabs as Record<string, unknown>
    : {};
  const rawBrowserWindows = Array.isArray(browserTabs.windows) ? browserTabs.windows : [];

  const normalizedConnection = {
    extensionId,
    stableKey: coerceString(connection.stableKey),
    browserName: coerceString(connection.browser),
    version: coerceString(connection.playwriterVersion),
    activeSessions: coerceNonNegativeInteger(connection.activeTargets),
  };
  const profileId = browserControlProfileId(normalizedConnection);
  const targets = rawTargets
    .map(normalizeBrowserControlTarget)
    .filter((target): target is NormalizedRelayTarget => target !== null)
    .map((target) => ({
      ...target,
      tabRef: browserControlTabRef(normalizedConnection, target.targetId),
    }));
  const browserWindows = rawBrowserWindows
    .map((window) => normalizeBrowserControlBrowserWindow(window, normalizedConnection))
    .filter((window): window is BrowserControlBrowserWindow => window !== null);
  const focusedWindow = browserWindows.find((window) => window.focused) ?? null;
  const activeTab = (focusedWindow?.tabs ?? []).find((tab) => tab.active)
    ?? browserWindows.flatMap((window) => window.tabs).find((tab) => tab.active)
    ?? null;

  return {
    ...normalizedConnection,
    profileId,
    targets,
    browserWindows,
    focusedWindowId: focusedWindow?.windowId ?? null,
    activeTabRef: activeTab?.tabRef ?? null,
    focusedWindow,
    activeTab,
  };
}

async function fetchRelayJson<T>(pathname: string, timeoutMs: number): Promise<T | null> {
  try {
    const response = await fetch(`${RELAY_HTTP_ENDPOINT}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }

    return await response.json() as T;
  } catch {
    return null;
  }
}

async function postRelayJson<T>(
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const response = await fetch(`${RELAY_HTTP_ENDPOINT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === 'string'
        ? payload.error
        : `Browser relay request failed with HTTP ${response.status}`,
    );
  }
  return payload as T;
}

async function getBrowserControlConnections(): Promise<BrowserControlConnection[]> {
  const extensionsPayload = await fetchRelayJson<{ extensions?: unknown }>('/extensions/status', 2_000);

  if (Array.isArray(extensionsPayload?.extensions)) {
    return extensionsPayload.extensions
      .map(normalizeBrowserControlConnection)
      .filter((connection): connection is BrowserControlConnection => connection !== null)
      .sort((left, right) => right.activeSessions - left.activeSessions);
  }

  const fallbackPayload = await fetchRelayJson<{
    connected?: unknown;
    browser?: unknown;
    activeTargets?: unknown;
    playwriterVersion?: unknown;
    targets?: unknown;
    browserTabs?: unknown;
  }>('/extension/status', 2_000);

  if (fallbackPayload?.connected !== true) {
    return [];
  }

  const fallbackConnection = normalizeBrowserControlConnection({
    extensionId: 'default',
    stableKey: null,
    browser: fallbackPayload.browser,
    activeTargets: fallbackPayload.activeTargets,
    playwriterVersion: fallbackPayload.playwriterVersion,
    targets: fallbackPayload.targets,
    browserTabs: fallbackPayload.browserTabs,
  });

  return fallbackConnection ? [fallbackConnection] : [];
}

export async function getBrowserControlPageElementInventory(input: {
  tabRef: string;
  maxElementsPerFrame?: number;
}): Promise<BrowserControlPageElementInventory> {
  const requestedMaxElements = input.maxElementsPerFrame ?? 80;
  const maxElementsPerFrame = Math.max(1, Math.min(Math.trunc(requestedMaxElements), 200));
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        chromeTabId?: unknown;
        frames?: unknown;
      }>('/extension/page-elements', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        maxElements: maxElementsPerFrame,
      }, 6_000);
      if (response.success !== true) {
        throw new Error('Browser page element inventory failed');
      }
      const frames = Array.isArray(response.frames)
        ? response.frames
            .map((frame) => normalizeBrowserControlPageElementFrame(frame, maxElementsPerFrame))
            .filter((frame): frame is BrowserControlPageElementFrame => frame !== null)
        : [];
      return {
        tabRef: tab.tabRef,
        chromeTabId: tab.chromeTabId,
        browserProfilePolicyId: connection.profileId,
        origin: originFromUrl(tab.url),
        frames,
      };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export async function activateBrowserControlTab(input: {
  tabRef: string;
}): Promise<{ success: true }> {
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        error?: unknown;
      }>('/extension/activate-tab', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        windowId: browserWindow.windowId,
      }, 6_000);
      if (response.success !== true) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Browser tab activation failed',
        );
      }
      return { success: true };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export async function drawBrowserControlPageTrace(input: {
  tabRef: string;
  frameId?: number;
  refId?: string;
  bounds?: BrowserControlPageElementBounds;
  durationMs?: number;
}): Promise<BrowserControlPageTraceResult> {
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        error?: unknown;
        chromeTabId?: unknown;
        frameId?: unknown;
        refId?: unknown;
        bounds?: unknown;
      }>('/extension/page-trace', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        frameId: input.frameId,
        refId: input.refId,
        bounds: input.bounds,
        durationMs: input.durationMs,
      }, 6_000);
      if (response.success !== true) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Browser page trace failed',
        );
      }
      const bounds = response.bounds && typeof response.bounds === 'object'
        ? response.bounds as Record<string, unknown>
        : null;
      if (!bounds) {
        throw new Error('Browser page trace response missing bounds');
      }
      return {
        tabRef: tab.tabRef,
        chromeTabId: coerceNonNegativeInteger(response.chromeTabId) || tab.chromeTabId,
        frameId: coerceNonNegativeInteger(response.frameId),
        refId: coerceString(response.refId),
        bounds: {
          x: coerceFiniteNumber(bounds.x),
          y: coerceFiniteNumber(bounds.y),
          width: coerceFiniteNumber(bounds.width),
          height: coerceFiniteNumber(bounds.height),
        },
      };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export async function clickBrowserControlPageElement(input: {
  tabRef: string;
  frameId?: number;
  refId: string;
  durationMs?: number;
}): Promise<BrowserControlPageClickResult> {
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        error?: unknown;
        chromeTabId?: unknown;
        frameId?: unknown;
        refId?: unknown;
        bounds?: unknown;
      }>('/extension/page-click', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        frameId: input.frameId,
        refId: input.refId,
        durationMs: input.durationMs,
      }, 6_000);
      if (response.success !== true) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Browser page click failed',
        );
      }
      const bounds = response.bounds && typeof response.bounds === 'object'
        ? response.bounds as Record<string, unknown>
        : null;
      if (!bounds) {
        throw new Error('Browser page click response missing bounds');
      }
      const clickedRefId = coerceString(response.refId);
      if (!clickedRefId) {
        throw new Error('Browser page click response missing refId');
      }
      return {
        tabRef: tab.tabRef,
        chromeTabId: coerceNonNegativeInteger(response.chromeTabId) || tab.chromeTabId,
        frameId: coerceNonNegativeInteger(response.frameId),
        refId: clickedRefId,
        bounds: {
          x: coerceFiniteNumber(bounds.x),
          y: coerceFiniteNumber(bounds.y),
          width: coerceFiniteNumber(bounds.width),
          height: coerceFiniteNumber(bounds.height),
        },
      };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export async function typeBrowserControlPageElement(input: {
  tabRef: string;
  frameId?: number;
  refId: string;
  text: string;
  durationMs?: number;
}): Promise<BrowserControlPageTypeResult> {
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        error?: unknown;
        chromeTabId?: unknown;
        frameId?: unknown;
        refId?: unknown;
        value?: unknown;
        bounds?: unknown;
      }>('/extension/page-type', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        frameId: input.frameId,
        refId: input.refId,
        text: input.text,
        durationMs: input.durationMs,
      }, 6_000);
      if (response.success !== true) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Browser page type failed',
        );
      }
      const bounds = response.bounds && typeof response.bounds === 'object'
        ? response.bounds as Record<string, unknown>
        : null;
      if (!bounds) {
        throw new Error('Browser page type response missing bounds');
      }
      const typedRefId = coerceString(response.refId);
      if (!typedRefId) {
        throw new Error('Browser page type response missing refId');
      }
      const value = coerceString(response.value);
      if (value === null) {
        throw new Error('Browser page type response missing value');
      }
      return {
        tabRef: tab.tabRef,
        chromeTabId: coerceNonNegativeInteger(response.chromeTabId) || tab.chromeTabId,
        frameId: coerceNonNegativeInteger(response.frameId),
        refId: typedRefId,
        value,
        bounds: {
          x: coerceFiniteNumber(bounds.x),
          y: coerceFiniteNumber(bounds.y),
          width: coerceFiniteNumber(bounds.width),
          height: coerceFiniteNumber(bounds.height),
        },
      };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export async function selectBrowserControlPageElement(input: {
  tabRef: string;
  frameId?: number;
  refId: string;
  value: string;
  durationMs?: number;
}): Promise<BrowserControlPageSelectResult> {
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        error?: unknown;
        chromeTabId?: unknown;
        frameId?: unknown;
        refId?: unknown;
        value?: unknown;
        bounds?: unknown;
      }>('/extension/page-select', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        frameId: input.frameId,
        refId: input.refId,
        value: input.value,
        durationMs: input.durationMs,
      }, 6_000);
      if (response.success !== true) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Browser page select failed',
        );
      }
      const bounds = response.bounds && typeof response.bounds === 'object'
        ? response.bounds as Record<string, unknown>
        : null;
      if (!bounds) {
        throw new Error('Browser page select response missing bounds');
      }
      const selectedRefId = coerceString(response.refId);
      if (!selectedRefId) {
        throw new Error('Browser page select response missing refId');
      }
      const value = coerceString(response.value);
      if (value === null) {
        throw new Error('Browser page select response missing value');
      }
      return {
        tabRef: tab.tabRef,
        chromeTabId: coerceNonNegativeInteger(response.chromeTabId) || tab.chromeTabId,
        frameId: coerceNonNegativeInteger(response.frameId),
        refId: selectedRefId,
        value,
        bounds: {
          x: coerceFiniteNumber(bounds.x),
          y: coerceFiniteNumber(bounds.y),
          width: coerceFiniteNumber(bounds.width),
          height: coerceFiniteNumber(bounds.height),
        },
      };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export async function scrollBrowserControlPage(input: {
  tabRef: string;
  frameId?: number;
  refId?: string;
  deltaX?: number;
  deltaY?: number;
}): Promise<BrowserControlPageScrollResult> {
  const connections = await getBrowserControlConnections();
  for (const connection of connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === input.tabRef);
      if (!tab) {
        continue;
      }
      const response = await postRelayJson<{
        success?: unknown;
        error?: unknown;
        chromeTabId?: unknown;
        frameId?: unknown;
        refId?: unknown;
        scrollX?: unknown;
        scrollY?: unknown;
        viewport?: unknown;
      }>('/extension/page-scroll', {
        extensionId: connection.stableKey ?? connection.extensionId,
        chromeTabId: tab.chromeTabId,
        frameId: input.frameId,
        refId: input.refId,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      }, 6_000);
      if (response.success !== true) {
        throw new Error(
          typeof response.error === 'string'
            ? response.error
            : 'Browser page scroll failed',
        );
      }
      const viewport = response.viewport && typeof response.viewport === 'object'
        ? response.viewport as Record<string, unknown>
        : null;
      if (!viewport) {
        throw new Error('Browser page scroll response missing viewport');
      }
      return {
        tabRef: tab.tabRef,
        chromeTabId: coerceNonNegativeInteger(response.chromeTabId) || tab.chromeTabId,
        frameId: coerceNonNegativeInteger(response.frameId),
        refId: typeof response.refId === 'string' && response.refId ? response.refId : undefined,
        scrollX: coerceFiniteNumber(response.scrollX),
        scrollY: coerceFiniteNumber(response.scrollY),
        viewport: {
          width: coerceFiniteNumber(viewport.width),
          height: coerceFiniteNumber(viewport.height),
        },
      };
    }
  }
  throw new Error(`Browser tab not found for tabRef: ${input.tabRef}`);
}

export function buildBrowserControlStatus(
  status: BrowserExtensionRelayStatus,
  observedVersion: string | null,
  connections: BrowserControlConnection[],
  profiles = buildBrowserControlProfiles(connections, []),
): BrowserControlStatus {
  const reachable = observedVersion !== null;
  const phase: BrowserExtensionRelayPhase = reachable
    ? 'ready'
    : status.phase === 'ready'
      ? 'error'
      : status.phase;

  return {
    relay: {
      ...status,
      phase,
      version: observedVersion ?? status.version,
      lastError: reachable ? null : status.lastError,
      reachable,
      endpoint: RELAY_HTTP_ENDPOINT,
    },
    connections,
    profiles,
    connectedBrowsers: connections.length,
    activeSessions: connections.reduce((total, connection) => total + connection.activeSessions, 0),
  };
}

export async function getBrowserControlStatus(): Promise<BrowserControlStatus> {
  const [observedVersion, connections, localProfiles] = await Promise.all([
    getRelayVersion(),
    getBrowserControlConnections(),
    discoverLocalBrowserProfiles(),
  ]);

  return buildBrowserControlStatus(
    getBrowserExtensionRelayStatus(),
    observedVersion,
    connections,
    await buildBrowserControlProfilesWithLocalMatches(connections, localProfiles),
  );
}

function resolveRelayRuntimeDir(): string {
  const candidatePaths = resolveBundledResourceCandidates({
    packagedSegments: ['browser-extension-relay'],
  });

  for (const candidate of candidatePaths) {
    if (hasRequiredRelayRuntimeLayout(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `[BrowserExtensionRelay] Relay runtime not found. Checked: ${candidatePaths.join(', ')}`,
  );
}

export function hasRequiredRelayRuntimeLayout(runtimeDir: string): boolean {
  return RELAY_REQUIRED_RUNTIME_PATHS
    .map((relativePath) => path.join(runtimeDir, relativePath))
    .every((requiredPath) => existsSync(requiredPath));
}

function readRelayRuntimeVersion(runtimeDir: string): string {
  const packageJsonPath = path.join(runtimeDir, 'package.json');
  const rawPackageJson = readFileSync(packageJsonPath, 'utf8');
  const parsedPackageJson = JSON.parse(rawPackageJson) as { version?: unknown };
  if (typeof parsedPackageJson.version !== 'string' || parsedPackageJson.version.trim().length === 0) {
    throw new Error(`[BrowserExtensionRelay] Missing runtime version in ${packageJsonPath}`);
  }
  return parsedPackageJson.version;
}

function resolveRelayInstallRoot(): string {
  const userDataDir = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (!userDataDir) {
    throw new Error('[BrowserExtensionRelay] INTERPRETER_USER_DATA_DIR is not set');
  }
  return path.join(userDataDir, RELAY_INSTALL_DIR_NAME);
}

function normalizeRelayRuntimeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

async function computeRelayRuntimeIntegritySummary(runtimeDir: string): Promise<RelayRuntimeIntegritySummary> {
  const hash = createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelayRuntimeRelativePath(path.relative(runtimeDir, entryPath));

      if (relativePath === RELAY_RUNTIME_MANIFEST_FILE_NAME) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`[BrowserExtensionRelay] Relay runtime must not contain symlinks: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`[BrowserExtensionRelay] Relay runtime contains unsupported entry: ${entryPath}`);
      }

      const fileContents = await readFile(entryPath);
      hash.update('F\0');
      hash.update(relativePath);
      hash.update('\0');
      hash.update(String(fileContents.byteLength));
      hash.update('\0');
      hash.update(fileContents);
      fileCount += 1;
      totalBytes += fileContents.byteLength;
    }
  }

  await walk(runtimeDir);

  return {
    fileCount,
    totalBytes,
    treeSha256: hash.digest('hex'),
  };
}

async function getRelayRuntimeIntegrityIssue(
  runtimeDir: string,
  bundledSummary: RelayRuntimeIntegritySummary,
): Promise<string | null> {
  try {
    const summary = await computeRelayRuntimeIntegritySummary(runtimeDir);

    if (summary.treeSha256 === bundledSummary.treeSha256) {
      return null;
    }

    const details: string[] = [];
    if (summary.fileCount !== bundledSummary.fileCount) {
      details.push(`file count mismatch (${summary.fileCount} !== ${bundledSummary.fileCount})`);
    }
    if (summary.totalBytes !== bundledSummary.totalBytes) {
      details.push(`byte size mismatch (${summary.totalBytes} !== ${bundledSummary.totalBytes})`);
    }
    details.push('tree hash mismatch');
    return details.join(', ');
  } catch (error) {
    return getErrorMessage(error);
  }
}

async function pruneOldRelayInstalls(installRoot: string, keepVersion: string): Promise<void> {
  if (!existsSync(installRoot)) {
    return;
  }

  const entries = await readdir(installRoot, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name === keepVersion || entry.name.startsWith('.')) {
      return;
    }
    await rm(path.join(installRoot, entry.name), { recursive: true, force: true });
  }));
}

export async function installRelayRuntimeFromBundledTree(
  bundledRuntimeDir: string,
  installRoot: string,
): Promise<{ runtimeDir: string; version: string }> {
  if (!hasRequiredRelayRuntimeLayout(bundledRuntimeDir)) {
    throw new Error(`[BrowserExtensionRelay] Bundled relay runtime is incomplete: ${bundledRuntimeDir}`);
  }

  const relayVersion = readRelayRuntimeVersion(bundledRuntimeDir);
  const bundledSummary = await computeRelayRuntimeIntegritySummary(bundledRuntimeDir);
  const runtimeDir = path.join(installRoot, relayVersion);

  if (hasRequiredRelayRuntimeLayout(runtimeDir) && readRelayRuntimeVersion(runtimeDir) === relayVersion) {
    const integrityIssue = await getRelayRuntimeIntegrityIssue(runtimeDir, bundledSummary);
    if (integrityIssue === null) {
      await pruneOldRelayInstalls(installRoot, relayVersion);
      return { runtimeDir, version: relayVersion };
    }
    console.warn(
      `[BrowserExtensionRelay] Reinstalling relay runtime after integrity drift runtimeDir=${runtimeDir} issue=${integrityIssue}`,
    );
  }

  await mkdir(installRoot, { recursive: true });
  const stagingDir = await mkdtemp(path.join(installRoot, `.staging-${relayVersion}-`));

  try {
    await cp(bundledRuntimeDir, stagingDir, { recursive: true, force: true });

    if (!hasRequiredRelayRuntimeLayout(stagingDir)) {
      throw new Error(`[BrowserExtensionRelay] Staged relay runtime is incomplete: ${stagingDir}`);
    }

    const stagedVersion = readRelayRuntimeVersion(stagingDir);
    if (stagedVersion !== relayVersion) {
      throw new Error(
        `[BrowserExtensionRelay] Staged relay runtime version ${stagedVersion} did not match bundled version ${relayVersion}`,
      );
    }

    const stagedIntegrityIssue = await getRelayRuntimeIntegrityIssue(stagingDir, bundledSummary);
    if (stagedIntegrityIssue !== null) {
      throw new Error(
        `[BrowserExtensionRelay] Staged relay runtime failed integrity verification: ${stagedIntegrityIssue}`,
      );
    }

    await rm(runtimeDir, { recursive: true, force: true });
    await rename(stagingDir, runtimeDir);
    await pruneOldRelayInstalls(installRoot, relayVersion);

    return { runtimeDir, version: relayVersion };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveRelayRuntimeInstall(): Promise<{ runtimeDir: string; relayVersion: string }> {
  const bundledRuntimeDir = resolveRelayRuntimeDir();
  const installRoot = resolveRelayInstallRoot();
  const { runtimeDir, version } = await installRelayRuntimeFromBundledTree(bundledRuntimeDir, installRoot);
  return {
    runtimeDir,
    relayVersion: version,
  };
}

function resolveRelayLogPaths(): { relayLogPath: string; relayCdpLogPath: string } {
  const appLogPath = process.env.LOG_FILE?.trim();
  const interpreterHome = process.env.INTERPRETER_HOME?.trim();
  const logDir = appLogPath
    ? path.dirname(appLogPath)
    : interpreterHome
      ? path.join(interpreterHome, 'logs')
      : path.join(process.cwd(), 'logs');
  mkdirSync(logDir, { recursive: true });
  return {
    relayLogPath: path.join(logDir, RELAY_LOG_FILE_NAME),
    relayCdpLogPath: path.join(logDir, RELAY_CDP_LOG_FILE_NAME),
  };
}

function ensureRelayLogDirectory(logFilePath: string): void {
  mkdirSync(path.dirname(logFilePath), { recursive: true });
}

function logRelayLoggerFailure(logFilePath: string, error: unknown): void {
  console.warn(
    `[BrowserExtensionRelay] Relay log write failed path=${logFilePath} error=${getErrorMessage(error)}`,
  );
}

export function createResilientRelayRuntimeLogger(logger: RelayRuntimeLogger): RelayRuntimeLogger {
  return {
    ...logger,
    log: async (...args: unknown[]) => {
      try {
        ensureRelayLogDirectory(logger.logFilePath);
        await logger.log(...args);
      } catch (error) {
        logRelayLoggerFailure(logger.logFilePath, error);
      }
    },
    error: async (...args: unknown[]) => {
      try {
        ensureRelayLogDirectory(logger.logFilePath);
        await logger.error(...args);
      } catch (error) {
        logRelayLoggerFailure(logger.logFilePath, error);
      }
    },
  };
}

export function createResilientRelayRuntimeCdpLogger(logger: RelayRuntimeCdpLogger): RelayRuntimeCdpLogger {
  return {
    ...logger,
    log: (entry: unknown) => {
      try {
        ensureRelayLogDirectory(logger.logFilePath);
        logger.log(entry);
      } catch (error) {
        logRelayLoggerFailure(logger.logFilePath, error);
      }
    },
  };
}

function resolveRelayRuntimeModuleUrl(runtimeDir: string, relativePath: string): string {
  return pathToFileURL(path.join(runtimeDir, 'dist', relativePath)).href;
}

async function loadRelayRuntimeModules(runtimeDir: string): Promise<RelayRuntimeModules> {
  if (relayRuntimeModulesPromise && relayRuntimeModulesDir === runtimeDir) {
    return relayRuntimeModulesPromise;
  }

  relayRuntimeModulesDir = runtimeDir;
  relayRuntimeModulesPromise = Promise.all([
    import(resolveRelayRuntimeModuleUrl(runtimeDir, 'cdp-relay.js')),
    import(resolveRelayRuntimeModuleUrl(runtimeDir, 'create-logger.js')),
    import(resolveRelayRuntimeModuleUrl(runtimeDir, 'cdp-log.js')),
  ]).then(([cdpRelayModule, fileLoggerModule, cdpLoggerModule]) => {
    const startPlayWriterCDPRelayServer = (cdpRelayModule as {
      startPlayWriterCDPRelayServer?: RelayRuntimeModules['startPlayWriterCDPRelayServer'];
    }).startPlayWriterCDPRelayServer;
    const createFileLogger = (fileLoggerModule as {
      createFileLogger?: RelayRuntimeModules['createFileLogger'];
    }).createFileLogger;
    const createCdpLogger = (cdpLoggerModule as {
      createCdpLogger?: RelayRuntimeModules['createCdpLogger'];
    }).createCdpLogger;

    if (typeof startPlayWriterCDPRelayServer !== 'function') {
      throw new Error('[BrowserExtensionRelay] Bundled relay runtime missing startPlayWriterCDPRelayServer export');
    }
    if (typeof createFileLogger !== 'function') {
      throw new Error('[BrowserExtensionRelay] Bundled relay runtime missing createFileLogger export');
    }
    if (typeof createCdpLogger !== 'function') {
      throw new Error('[BrowserExtensionRelay] Bundled relay runtime missing createCdpLogger export');
    }

    return {
      startPlayWriterCDPRelayServer,
      createFileLogger,
      createCdpLogger,
    };
  }).catch((error) => {
    relayRuntimeModulesPromise = null;
    relayRuntimeModulesDir = null;
    throw error;
  });

  return relayRuntimeModulesPromise;
}

function applyOwnedRelayProcessEnv(): void {
  if (!relayOwnedProcessEnvSnapshot) {
    relayOwnedProcessEnvSnapshot = {
      playwriterAutoEnable: process.env.PLAYWRITER_AUTO_ENABLE ?? null,
    };
  }

  process.env.PLAYWRITER_AUTO_ENABLE = '1';
}

function restoreOwnedRelayProcessEnv(): void {
  if (!relayOwnedProcessEnvSnapshot) {
    return;
  }

  const { playwriterAutoEnable } = relayOwnedProcessEnvSnapshot;
  if (playwriterAutoEnable === null) {
    delete process.env.PLAYWRITER_AUTO_ENABLE;
  } else {
    process.env.PLAYWRITER_AUTO_ENABLE = playwriterAutoEnable;
  }
  relayOwnedProcessEnvSnapshot = null;
}

function closeOwnedRelayServerIfPresent(reason: string): void {
  if (!relayServer || !appOwnsRelayProcess) {
    return;
  }

  clearRelayStateChangeListener();

  emitRelayLifecycleEvent(reason, 'info', {
    runtimeDir: relayStatus.runtimeDir,
  });

  try {
    relayServer.close();
  } catch (error) {
    console.warn('[BrowserExtensionRelay] Failed to close owned relay server before restart:', error);
    emitRelayLifecycleEvent('failed to close owned relay server before restart', 'warning', {
      error: getErrorMessage(error),
      runtimeDir: relayStatus.runtimeDir,
    });
  }

  relayServer = null;
  appOwnsRelayProcess = false;
  restoreOwnedRelayProcessEnv();
  broadcastBrowserControlChanged('status');
}

async function waitForRelayReady(expectedVersion: string, relayLogPath: string): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < RELAY_READY_TIMEOUT_MS) {
    const runningVersion = await getRelayVersion();
    if (runningVersion === null) {
      await sleep(RELAY_READY_POLL_INTERVAL_MS);
      continue;
    }

    if (runningVersion === expectedVersion || compareVersions(runningVersion, expectedVersion) > 0) {
      return;
    }

    emitRelayLifecycleEvent('running relay version is older than bundled runtime', 'error', {
      expectedVersion,
      runningVersion,
    });
    throw new Error(
      `[BrowserExtensionRelay] Relay responded with older version ${runningVersion}; expected ${expectedVersion}`,
    );
  }

  emitRelayLifecycleEvent('timed out waiting for readiness', 'error', {
    expectedVersion,
    relayLogPath,
    timeoutMs: RELAY_READY_TIMEOUT_MS,
  });
  throw new Error(
    `[BrowserExtensionRelay] Timed out waiting for relay readiness after ${RELAY_READY_TIMEOUT_MS}ms. Check ${relayLogPath}`,
  );
}

async function startOwnedRelay(): Promise<void> {
  const { runtimeDir, relayVersion } = await resolveRelayRuntimeInstall();
  const existingRelayVersion = await getRelayVersion();

  if (existingRelayVersion === relayVersion || (
    existingRelayVersion !== null && compareVersions(existingRelayVersion, relayVersion) > 0
  )) {
    console.log(`[BrowserExtensionRelay] Reusing existing relay version=${existingRelayVersion}`);
    emitRelayLifecycleEvent('reusing existing relay', 'info', {
      runningVersion: existingRelayVersion,
      bundledVersion: relayVersion,
      runtimeDir,
    });
    relayServer = null;
    appOwnsRelayProcess = false;
    restoreOwnedRelayProcessEnv();
    updateRelayStatus({
      phase: 'ready',
      version: existingRelayVersion,
      runtimeDir,
      relayLogPath: null,
      relayCdpLogPath: null,
      ownsRelayProcess: false,
      lastError: null,
    });
    return;
  }

  if (existingRelayVersion !== null) {
    console.log(
      `[BrowserExtensionRelay] Restarting older relay version=${existingRelayVersion} with bundled version=${relayVersion}`,
    );
    closeOwnedRelayServerIfPresent('closing owned relay server before relay version restart');
    emitRelayLifecycleEvent('restarting older relay', 'warning', {
      runningVersion: existingRelayVersion,
      bundledVersion: relayVersion,
      port: RELAY_PORT,
    });
    killPortProcessSync(RELAY_PORT, { excludePids: [process.pid] });
    await sleep(250);
  } else {
    // `/version` did not identify a healthy relay. Clear any stale listener so startup
    // does not fail with EADDRINUSE when another process still holds the relay port.
    closeOwnedRelayServerIfPresent('closing owned relay server before clearing stale relay listener');
    emitRelayLifecycleEvent('clearing stale relay listener before startup', 'info', {
      port: RELAY_PORT,
    });
    killPortProcessSync(RELAY_PORT, { excludePids: [process.pid] });
    await sleep(250);
  }

  const { relayLogPath, relayCdpLogPath } = resolveRelayLogPaths();

  updateRelayStatus({
    phase: 'starting',
    version: relayVersion,
    runtimeDir,
    relayLogPath,
    relayCdpLogPath,
    ownsRelayProcess: false,
    lastError: null,
  });

  console.log(`[BrowserExtensionRelay] Starting relay runtime=${runtimeDir}`);
  emitRelayLifecycleEvent('starting relay server', 'info', {
    runtimeDir,
    relayVersion,
    relayLogPath,
    relayCdpLogPath,
    timeoutMs: RELAY_READY_TIMEOUT_MS,
  });
  // Load and host the bundled relay inside the current app process so startup
  // does not relaunch the Electron executable as a second dock-visible app.
  const relayRuntime = await loadRelayRuntimeModules(runtimeDir);
  applyOwnedRelayProcessEnv();

  let startedRelayServer: RelayRuntimeServer | null = null;
  try {
    const logger = createResilientRelayRuntimeLogger(
      relayRuntime.createFileLogger({ logFilePath: relayLogPath }),
    );
    const cdpLogger = createResilientRelayRuntimeCdpLogger(
      relayRuntime.createCdpLogger({ logFilePath: relayCdpLogPath }),
    );

    const startRelayServer = async (): Promise<RelayRuntimeServer> => {
      const server = await relayRuntime.startPlayWriterCDPRelayServer({
        host: RELAY_HOST,
        port: RELAY_PORT,
        logger,
        cdpLogger,
        enableCliRoutes: false,
        sanitizeBufferInspect: false,
        getAccessPolicy: () => getBrowserAccessPolicyWithGrants(getBrowserAccessPolicySync()),
      });
      try {
        await waitForRelayReady(relayVersion, relayLogPath);
        return server;
      } catch (error) {
        closeRelayServerAfterStartupError(server);
        throw error;
      }
    };

    const logAddressInUseWarning = async (message: string, error: Error): Promise<void> => {
      console.warn(`[BrowserExtensionRelay] ${message}`, error);
      emitRelayLifecycleEvent(message, 'warning', {
        error: error.message,
        port: RELAY_PORT,
      });
      await logger.log(`[BrowserExtensionRelay] WARNING: ${message}`, error);
    };

    // NOTE(victor): Keep EADDRINUSE in the local startup flow before the nested Hono server can emit it process-wide.
    const listenAddressResult = await ensureRelayListenAddressAvailableWithRetry({
      checkRelayListenAddressAvailable: isRelayListenAddressAvailable,
      handleInitialAddressConflict: async (error) => {
        await logAddressInUseWarning(
          `Relay port ${RELAY_BIND_ENDPOINT} is already in use; killing listener before retry.`,
          error,
        );
        killPortProcessSync(RELAY_PORT, { excludePids: [process.pid] });
        await sleep(250);
      },
      handleRetryAddressConflict: async (error) => {
        await logAddressInUseWarning(
          `Relay port ${RELAY_BIND_ENDPOINT} is still in use after retry; browser control will retry on the next invocation.`,
          error,
        );
        relayServer = null;
        appOwnsRelayProcess = false;
        restoreOwnedRelayProcessEnv();
        updateRelayStatus({
          phase: 'error',
          ownsRelayProcess: false,
          lastError: `Relay port ${RELAY_BIND_ENDPOINT} is still in use; retry will run on the next invocation.`,
        });
      },
    });

    if (listenAddressResult.status === 'blocked') {
      return;
    }

    const relayStartupResult = await startRelayServerWithAddressConflictRetry({
      startRelayServer,
      handleInitialAddressConflict: async (error) => {
        await logAddressInUseWarning(
          `Relay port ${RELAY_BIND_ENDPOINT} is already in use; killing listener before retry.`,
          error,
        );
        killPortProcessSync(RELAY_PORT, { excludePids: [process.pid] });
        await sleep(250);
      },
      handleRetryAddressConflict: async (error) => {
        await logAddressInUseWarning(
          `Relay port ${RELAY_BIND_ENDPOINT} is still in use after retry; browser control will retry on the next invocation.`,
          error,
        );
        relayServer = null;
        appOwnsRelayProcess = false;
        restoreOwnedRelayProcessEnv();
        updateRelayStatus({
          phase: 'error',
          ownsRelayProcess: false,
          lastError: `Relay port ${RELAY_BIND_ENDPOINT} is still in use; retry will run on the next invocation.`,
        });
      },
    });

    if (relayStartupResult.status === 'blocked') {
      return;
    }

    startedRelayServer = relayStartupResult.server;
  } catch (error) {
    closeRelayServerAfterStartupError(startedRelayServer);
    relayServer = null;
    appOwnsRelayProcess = false;
    restoreOwnedRelayProcessEnv();
    broadcastBrowserControlChanged('status');
    throw error;
  }

  relayServer = startedRelayServer;
  relayStateChangeListener = () => {
    if (relayStateChangeBroadcastTimer) {
      return;
    }
    relayStateChangeBroadcastTimer = setTimeout(() => {
      relayStateChangeBroadcastTimer = null;
      broadcastBrowserControlChanged('status');
    }, BROWSER_CONTROL_STATUS_BROADCAST_DEBOUNCE_MS);
  };
  relayServer.on('state:changed', relayStateChangeListener);
  appOwnsRelayProcess = true;
  updateRelayStatus({
    phase: 'ready',
    version: relayVersion,
    runtimeDir,
    relayLogPath,
    relayCdpLogPath,
    ownsRelayProcess: true,
    lastError: null,
  });
  emitRelayLifecycleEvent('relay ready', 'info', {
    relayVersion,
    runtimeDir,
  });
  console.log(`[BrowserExtensionRelay] Relay ready version=${relayVersion}`);
  broadcastBrowserControlChanged('status');
}

export async function ensureBrowserExtensionRelayRunning(): Promise<void> {
  if (startupPromise) {
    return startupPromise;
  }

  if (relayServer && appOwnsRelayProcess) {
    const runningVersion = await getRelayVersion();
    if (runningVersion !== null) {
      return;
    }

    console.warn('[BrowserExtensionRelay] Owned relay became unreachable; restarting');
    emitRelayLifecycleEvent('owned relay became unreachable; restarting', 'warning', {
      runtimeDir: relayStatus.runtimeDir,
    });

    try {
      clearRelayStateChangeListener();
      relayServer.close();
    } catch (error) {
      console.warn('[BrowserExtensionRelay] Failed to close unreachable relay server:', error);
      emitRelayLifecycleEvent('failed to close unreachable relay server', 'warning', {
        error: getErrorMessage(error),
      });
    }

    relayServer = null;
    appOwnsRelayProcess = false;
    restoreOwnedRelayProcessEnv();
    updateRelayStatus({
      phase: 'error',
      ownsRelayProcess: false,
      lastError: 'Owned relay became unreachable',
    });
    broadcastBrowserControlChanged('status');
  }

  startupPromise = startOwnedRelay()
    .catch((error) => {
      updateRelayStatus({
        phase: 'error',
        ownsRelayProcess: appOwnsRelayProcess,
        lastError: getErrorMessage(error),
      });
      emitRelayLifecycleEvent('startup failed', 'error', {
        error: getErrorMessage(error),
        phase: relayStatus.phase,
        runtimeDir: relayStatus.runtimeDir,
        relayLogPath: relayStatus.relayLogPath,
        relayCdpLogPath: relayStatus.relayCdpLogPath,
      });
      throw error;
    })
    .finally(() => {
      startupPromise = null;
    });
  return startupPromise;
}

export async function shutdownBrowserExtensionRelay(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  const server = relayServer;
  if (!server || !appOwnsRelayProcess) {
    return;
  }

  shutdownPromise = (async () => {
    try {
      emitRelayLifecycleEvent('closing owned relay server', 'info', {
        runtimeDir: relayStatus.runtimeDir,
      });
      clearRelayStateChangeListener();
      server.close();
    } catch (error) {
      console.warn('[BrowserExtensionRelay] Failed to close relay server:', error);
      emitRelayLifecycleEvent('failed to close relay server', 'warning', {
        error: getErrorMessage(error),
      });
    }

    relayServer = null;
    appOwnsRelayProcess = false;
    restoreOwnedRelayProcessEnv();
    updateRelayStatus({
      phase: 'stopped',
      ownsRelayProcess: false,
      lastError: null,
    });
    emitRelayLifecycleEvent('relay shutdown complete', 'info', {
      runtimeDir: relayStatus.runtimeDir,
    });
    broadcastBrowserControlChanged('status');
  })().finally(() => {
    shutdownPromise = null;
  });

  return shutdownPromise;
}
