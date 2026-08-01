import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { approvalManager } from '../../../approvalManager';
import { waitForComputerUseSetupReady } from '../../../computerUseSetupGate';
import { thumbnailService } from '../../../thumbnailService';
import { getBrowserAccessPolicy, getCuaAccessPolicy } from '../../../configStore';
import { getBrowserControlStatus } from '../../../utils/browserExtensionRelay';
import {
  checkFileAccessPermission,
  getFileAccessDeniedMessage,
  resolvePathWithWorkspace,
} from '../../../utils/permissions';
import { getSandboxDir } from '../../../utils/sandboxManager';
import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import type { ToolCallResponse } from '../../toolTypes';
import { callWindowsCuaDriverTool } from './windowsUia';
import type { BrowserControlStatus } from '../../../../shared/types/browserControl';
import {
  resolveCuaAccessPolicyMode,
  type CuaAccessPermissionKind,
  type CuaAccessPolicy,
} from '../../../../shared/cuaAccessPolicy';
import {
  getBrowserAccessProfilePolicy,
  normalizeBrowserAccessPolicy,
  type BrowserAccessPolicy,
} from '../../../../shared/browserAccessPolicy';

type WindowsCuaDriverToolProvider = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<ToolCallResponse>;

const execFileAsync = promisify(execFile);
const SERVER_ID = 'builtin-cua-driver';
const AGENT_ACTIVITY_IDLE_HIDE_MS = 3500;
let daemonProcess: ChildProcess | null = null;
let daemonStartPromise: Promise<void> | null = null;
let daemonCursorConfigured = false;
let macAgentActivityOverlayProcess: ChildProcess | null = null;
const appIconDataUrlCache = new Map<string, string | null>();
let browserControlStatusProvider: () => Promise<BrowserControlStatus> = getBrowserControlStatus;
let cuaAccessPolicyProvider: () => Promise<CuaAccessPolicy> = getCuaAccessPolicy;
let browserAccessPolicyProvider: () => Promise<BrowserAccessPolicy> = getBrowserAccessPolicy;
let windowsCuaDriverToolProvider: WindowsCuaDriverToolProvider = callWindowsCuaDriverTool;
const macCuaDriverSocketPath = path.join(os.tmpdir(), `interpreter-desktop-driver-${process.pid}.sock`);
const MAC_CUA_DRIVER_DAEMON_STARTUP_TIMEOUT_MS = 20_000;
const MAC_CUA_DRIVER_TOOL_TIMEOUT_MS = 60_000;
const MAC_CUA_DRIVER_ACTIVITY_TIMEOUT_MS = 5_000;
const MAC_CUA_DRIVER_ACTIVITY_MAX_BUFFER = 10 * 1024 * 1024;
const MAC_CUA_DRIVER_CALL_LOCK_DIR = path.join(os.tmpdir(), 'interpreter-desktop-driver-call.lock');
const MAC_CUA_DRIVER_CALL_LOCK_STALE_MS = 3 * MAC_CUA_DRIVER_TOOL_TIMEOUT_MS;
const MAC_SELECT_OPTION_MENU_WAIT_MS = 3_000;
const MAC_SELECT_OPTION_MENU_POLL_MS = 120;
const MAC_CUA_DRIVER_CALL_BUSY_MESSAGE = [
  'Another Computer Use action is already in progress.',
  'Wait for that action result, then call get_app_state again before issuing the next click, scroll, set_value, select_option, or key action.',
].join(' ');
type ComputerUseTarget = {
  app: string;
  title: string;
  pid: number;
  windowId: number | string;
  focusedElementIndex: number | null;
  onCurrentSpace?: boolean;
  isOnScreen?: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};
const computerUseAppStateCache = new Map<string, ComputerUseTarget>();

function automationBackendName(): string {
  return process.platform === 'win32' ? 'Windows UI Automation' : 'native desktop driver';
}

function approvalAgentId(context?: BuiltinToolContext): string | undefined {
  return context?.agentId || context?.callerTabId;
}

const DISCOVERY_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'list_automation_targets',
  'list_com_objects',
  'check_permissions',
  'get_screen_size',
  'get_cursor_position',
  'get_config',
  'get_agent_cursor_state',
  'get_recording_state',
]);

const INSPECT_TOOLS = new Set([
  'list_windows',
  'get_app_state',
  'get_ui_elements',
  'get_window_state',
  'get_accessibility_tree',
  'screenshot',
  'zoom',
]);

const TARGETED_GUI_TOOLS = new Set([
  'click',
  'double_click',
  'drag',
  'get_app_state',
  'get_ui_elements',
  'get_accessibility_tree',
  'get_window_state',
  'hotkey',
  'move_cursor',
  'press_key',
  'right_click',
  'screenshot',
  'scroll',
  'select_option',
  'set_value',
  'close_window',
  'focus_window',
  'maximize_window',
  'minimize_window',
  'restore_window',
  'set_window_bounds',
  'type_text',
  'type_text_chars',
  'zoom',
]);

const SELF_AUTOMATION_BLOCK_MESSAGE = 'Interpreter cannot use Computer Use to inspect or control its own app windows.';

function firstExistingPath(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cuaDriverRustBuildCandidates(driverRoot: string): string[] {
  const targetRoot = path.join(driverRoot, 'target');
  return [
    path.join(targetRoot, 'release', 'cua-driver'),
    path.join(targetRoot, 'debug', 'cua-driver'),
  ];
}

export function resolveCuaDriverBinary(): string {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const submoduleDriverRoot = path.join(process.cwd(), 'submodules', 'interpreter-cua', 'libs', 'cua-driver', 'rust');
  const envPath = process.env.CUA_DRIVER_PATH?.trim();
  const candidates = [
    ...(envPath ? [envPath] : []),
    ...(resourcesPath ? [path.join(resourcesPath, 'cua-driver', 'cua-driver')] : []),
    path.join(process.cwd(), 'dist-electron', 'cua-driver', 'cua-driver'),
    ...cuaDriverRustBuildCandidates(submoduleDriverRoot),
  ];

  const binary = firstExistingPath(candidates);
  if (binary) return binary;

  throw new Error(
    'macOS Computer Use driver binary not found. '
    + `Checked: ${candidates.join(', ')}. `
    + 'Run `pnpm run build:electron` on macOS or set CUA_DRIVER_PATH.',
  );
}

function resolveMacAgentActivityOverlayScript(): string {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const candidates = [
    path.join(process.cwd(), 'server', 'tools', 'builtin-tools', 'cua-driver', 'macos-agent-activity-overlay.jxa'),
    resourcesPath ? path.join(resourcesPath, 'cua-driver', 'macos-agent-activity-overlay.jxa') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`macOS Computer Use activity overlay script not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

function integerArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function protectedDesktopPids(): Set<number> {
  const pids = new Set<number>();
  if (Number.isInteger(process.pid) && process.pid > 0) {
    pids.add(process.pid);
  }
  const extra = process.env.INTERPRETER_COMPUTER_USE_PROTECTED_PIDS ?? '';
  for (const part of extra.split(',')) {
    const parsed = Number(part.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      pids.add(parsed);
    }
  }
  return pids;
}

function recordPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function targetIdentityPid(args: Record<string, unknown>): number | null {
  const targetIdentity = args.target_identity;
  if (!targetIdentity || typeof targetIdentity !== 'object' || Array.isArray(targetIdentity)) {
    return null;
  }
  const app = (targetIdentity as Record<string, unknown>).app;
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    return null;
  }
  return recordPid((app as Record<string, unknown>).pid);
}

function isProtectedDesktopRecord(value: unknown, protectedPids = protectedDesktopPids()): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pid = recordPid((value as Record<string, unknown>).pid);
  return pid !== null && protectedPids.has(pid);
}

export function isProtectedDesktopAutomationTarget(
  toolName: string,
  args: Record<string, unknown>,
  protectedPids = protectedDesktopPids(),
): boolean {
  if (toolName === 'replay_trajectory') {
    const events = Array.isArray(args.events)
      ? args.events
      : Array.isArray(args.trajectory)
        ? args.trajectory
        : [];
    return events.some((event) => (
      event
      && typeof event === 'object'
      && !Array.isArray(event)
      && isProtectedDesktopAutomationTarget(
        typeof (event as Record<string, unknown>).tool === 'string'
          ? String((event as Record<string, unknown>).tool)
          : '',
        ((event as Record<string, unknown>).args ?? {}) as Record<string, unknown>,
        protectedPids,
      )
    ));
  }

  if (!TARGETED_GUI_TOOLS.has(toolName)) {
    return false;
  }
  const pid = integerArg(args, 'pid') ?? targetIdentityPid(args);
  return pid !== null && protectedPids.has(pid);
}

function assertNotProtectedDesktopAutomationTarget(toolName: string, args: Record<string, unknown>): void {
  if (isProtectedDesktopAutomationTarget(toolName, args)) {
    throw new Error(SELF_AUTOMATION_BLOCK_MESSAGE);
  }
}

function assertNotProtectedDesktopPid(pid: number): void {
  if (protectedDesktopPids().has(pid)) {
    throw new Error(SELF_AUTOMATION_BLOCK_MESSAGE);
  }
}

function filterProtectedDesktopValue(value: unknown, protectedPids = protectedDesktopPids()): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isProtectedDesktopRecord(item, protectedPids))
      .map((item) => filterProtectedDesktopValue(item, protectedPids));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    return {
      ...record,
      data: filterProtectedDesktopValue(record.data, protectedPids),
    };
  }

  return value;
}

export function filterProtectedDesktopTargetsFromTextForTest(
  text: string,
  protectedPids = protectedDesktopPids(),
): string {
  return filterProtectedDesktopTargetsFromText(text, protectedPids);
}

function filterProtectedDesktopTargetsFromText(
  text: string,
  protectedPids = protectedDesktopPids(),
): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(filterProtectedDesktopValue(parsed, protectedPids));
  } catch {
    const lines = text.split(/\r?\n/);
    const jsonIndex = lines.findIndex((line) => {
      const candidate = line.trim();
      return candidate.startsWith('{') || candidate.startsWith('[');
    });
    if (jsonIndex < 0) return text;
    try {
      const parsed = JSON.parse(lines[jsonIndex]!.trim());
      lines[jsonIndex] = JSON.stringify(filterProtectedDesktopValue(parsed, protectedPids));
      return lines.join('\n');
    } catch {
      return text;
    }
  }
}

function filterProtectedDesktopTargetsFromResponse(
  toolName: string,
  response: ToolCallResponse,
): ToolCallResponse {
  if (toolName !== 'list_apps' && toolName !== 'list_windows' && toolName !== 'list_automation_targets') {
    return response;
  }

  return {
    ...response,
    content: (response.content ?? []).map((item) => (
      item.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: filterProtectedDesktopTargetsFromText(item.text) }
        : item
    )),
  };
}

function toolText(response: ToolCallResponse): string {
  return (response.content ?? [])
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Tool returned empty output.');
  return JSON.parse(trimmed);
}

type MacCuaWindowRecord = {
  owner?: string;
  app?: string;
  app_name?: string;
  title?: string;
  name?: string;
  pid?: number;
  id?: number | string;
  window_id?: number | string;
  layer?: number;
  is_on_screen?: boolean;
  on_current_space?: boolean;
  z_index?: number;
  bounds?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
};

type CuaWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CuaWindowTargetIdentity = {
  kind: 'app-window';
  platform: NodeJS.Platform;
  coordinate_space: 'screen-dip';
  observed_at: number;
  app: {
    name: string | null;
    pid: number;
  };
  window: {
    native_window_id: number | string;
    title: string | null;
  };
  bounds: CuaWindowBounds | null;
  ref_invalidation: {
    rules: string[];
  };
};

function windowRecordAppName(window: MacCuaWindowRecord): string {
  return window.owner ?? window.app ?? window.app_name ?? '';
}

function windowRecordTitle(window: MacCuaWindowRecord): string {
  return window.name ?? window.title ?? '';
}

function windowRecordId(window: MacCuaWindowRecord): number | null {
  const raw = window.window_id ?? window.id;
  return typeof raw === 'number' && Number.isInteger(raw)
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw)
      ? Number(raw)
      : null;
}

function windowRecordArea(window: MacCuaWindowRecord): number {
  const width = typeof window.bounds?.width === 'number' ? window.bounds.width : 0;
  const height = typeof window.bounds?.height === 'number' ? window.bounds.height : 0;
  return Math.max(0, width) * Math.max(0, height);
}

function normalizeWindowBounds(value: unknown): CuaWindowBounds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.x === 'number'
    && typeof record.y === 'number'
    && typeof record.width === 'number'
    && typeof record.height === 'number'
    ? {
        x: record.x,
        y: record.y,
        width: record.width,
        height: record.height,
      }
    : null;
}

function windowTargetIdentityForRecord(
  window: MacCuaWindowRecord,
  platform: NodeJS.Platform = process.platform,
  observedAt: number = Date.now(),
): CuaWindowTargetIdentity | null {
  const pid = typeof window.pid === 'number' && Number.isInteger(window.pid) ? window.pid : null;
  const nativeWindowId = window.window_id ?? window.id;
  if (pid === null || (typeof nativeWindowId !== 'number' && typeof nativeWindowId !== 'string')) {
    return null;
  }
  return {
    kind: 'app-window',
    platform,
    coordinate_space: 'screen-dip',
    observed_at: observedAt,
    app: {
      name: windowRecordAppName(window) || null,
      pid,
    },
    window: {
      native_window_id: nativeWindowId,
      title: windowRecordTitle(window) || null,
    },
    bounds: normalizeWindowBounds(window.bounds),
    ref_invalidation: {
      rules: [
        'target_identity_mismatch',
        'pid_mismatch',
        'native_window_id_mismatch',
        'window_closed',
      ],
    },
  };
}

function withWindowTargetIdentity(window: MacCuaWindowRecord, platform: NodeJS.Platform, observedAt: number): MacCuaWindowRecord & {
  target_identity?: CuaWindowTargetIdentity;
} {
  const targetIdentity = windowTargetIdentityForRecord(window, platform, observedAt);
  return targetIdentity
    ? { ...window, target_identity: targetIdentity }
    : { ...window };
}

function enrichWindowRecordsInValue(value: unknown, platform: NodeJS.Platform, observedAt: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
        ? withWindowTargetIdentity(item as MacCuaWindowRecord, platform, observedAt)
        : item
    ));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    ...(Array.isArray(record.data)
      ? { data: enrichWindowRecordsInValue(record.data, platform, observedAt) }
      : {}),
    ...(Array.isArray(record.windows)
      ? { windows: enrichWindowRecordsInValue(record.windows, platform, observedAt) }
      : {}),
  };
}

function browserAppLabel(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(google chrome|chrome|chromium|brave browser|brave|microsoft edge|edge)\b/.test(normalized);
}

function browserControlWindowSummary(status: BrowserControlStatus) {
  const profilesByConnectionId = new Map(
    status.profiles.flatMap((profile) => [
      [profile.profileId, profile],
      ...(profile.policyProfileId ? [[profile.policyProfileId, profile] as const] : []),
      ...(profile.stableKey ? [[profile.stableKey, profile] as const] : []),
    ]),
  );

  return status.connections.flatMap((connection) => {
    const profile = profilesByConnectionId.get(connection.profileId)
      ?? (connection.stableKey ? profilesByConnectionId.get(connection.stableKey) : undefined)
      ?? null;
    const profilePolicyId = profile?.policyProfileId ?? connection.profileId;
    return connection.browserWindows.map((browserWindow) => ({
      browser_profile_id: connection.profileId,
      browser_profile_policy_id: profilePolicyId,
      browser_profile_name: profile?.profileName ?? null,
      browser_profile_path: profile?.profilePath || null,
      extension_stable_key: connection.stableKey,
      browser_name: connection.browserName,
      browser_window_id: browserWindow.windowId,
      focused: browserWindow.focused,
      state: browserWindow.state,
      type: browserWindow.type,
      active_tab_ref: browserWindow.tabs.find((tab) => tab.active)?.tabRef ?? null,
      tabs: browserWindow.tabs.map((tab) => ({
        tab_ref: tab.tabRef,
        chrome_tab_id: tab.chromeTabId,
        index: tab.index,
        active: tab.active,
        highlighted: tab.highlighted,
        pinned: tab.pinned,
        title: tab.title,
        url: tab.url,
        status: tab.status,
        control_state: tab.controlState,
        control_state_detail: tab.controlStateDetail ?? null,
        target_id: tab.targetId ?? null,
      })),
    }));
  });
}

const BROWSER_POLICY_DENIAL_PREFIX = 'Interpreter browser settings blocked this request.';

function browserReadModeIsDeny(policy: BrowserAccessPolicy, profilePolicyId: string): boolean {
  const normalizedPolicy = normalizeBrowserAccessPolicy(policy);
  const profilePolicy = getBrowserAccessProfilePolicy(normalizedPolicy, profilePolicyId);
  return (profilePolicy?.permissions ?? normalizedPolicy.permissions).read.mode === 'deny';
}

function browserTabOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the active browser page';
  }
}

async function assertNativeBrowserReadAllowed(appLabel: string): Promise<void> {
  if (!browserAppLabel(appLabel)) {
    return;
  }
  const browserWindows = browserControlWindowSummary(await browserControlStatusProvider());
  if (browserWindows.length === 0) {
    return;
  }
  const policy = await browserAccessPolicyProvider();
  for (const browserWindow of browserWindows) {
    const activeTab = browserWindow.tabs.find((tab) => tab.active);
    if (!activeTab?.url) {
      continue;
    }
    if (browserReadModeIsDeny(policy, browserWindow.browser_profile_policy_id)) {
      throw new Error(`${BROWSER_POLICY_DENIAL_PREFIX} Browser read access is denied for ${browserTabOrigin(activeTab.url)}.`);
    }
  }
}

function maskDeniedBrowserControlWindows(
  browserWindows: ReturnType<typeof browserControlWindowSummary>,
  policy: BrowserAccessPolicy,
): Array<Record<string, unknown>> {
  return browserWindows.map((browserWindow) => {
    if (!browserReadModeIsDeny(policy, browserWindow.browser_profile_policy_id)) {
      return browserWindow;
    }
    return {
      ...browserWindow,
      active_tab_ref: null,
      tabs: `${BROWSER_POLICY_DENIAL_PREFIX} Tab titles and URLs are hidden for this browser window.`,
    };
  });
}

function withBrowserControlForWindow(
  window: MacCuaWindowRecord,
  browserWindows: Array<Record<string, unknown>>,
): MacCuaWindowRecord & { browser_control?: Record<string, unknown> } {
  const appName = windowRecordAppName(window);
  const title = windowRecordTitle(window);
  if (!browserAppLabel(`${appName} ${title}`) || browserWindows.length === 0) {
    return window;
  }
  return {
    ...window,
    browser_control: {
      source: 'interpreter-browser-control',
      correlation: 'browser_app_window',
      windows: browserWindows,
    },
  };
}

function attachBrowserControlToWindowValue(value: unknown, browserWindows: Array<Record<string, unknown>>): unknown {
  if (browserWindows.length === 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
        ? withBrowserControlForWindow(item as MacCuaWindowRecord, browserWindows)
        : item
    ));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    ...(Array.isArray(record.data)
      ? { data: attachBrowserControlToWindowValue(record.data, browserWindows) }
      : {}),
    ...(Array.isArray(record.windows)
      ? { windows: attachBrowserControlToWindowValue(record.windows, browserWindows) }
      : {}),
  };
}

async function enrichListWindowsResponseWithTargetIdentity(
  response: ToolCallResponse,
  platform: NodeJS.Platform = process.platform,
  observedAt: number = Date.now(),
): Promise<ToolCallResponse> {
  if (response.isError) {
    return response;
  }
  const text = toolText(response);
  const parsed = parseJsonText(text);
  const withTargetIdentity = enrichWindowRecordsInValue(parsed, platform, observedAt);
  let withBrowserControl = withTargetIdentity;
  try {
    const browserWindows = browserControlWindowSummary(await browserControlStatusProvider());
    withBrowserControl = attachBrowserControlToWindowValue(
      withTargetIdentity,
      browserWindows.length === 0
        ? []
        : maskDeniedBrowserControlWindows(browserWindows, await browserAccessPolicyProvider()),
    );
  } catch (error) {
    console.warn('[CuaDriver] Browser-control context unavailable for list_windows', {
      error: getErrorMessage(error),
    });
  }
  return {
    ...response,
    content: [{
      type: 'text',
      text: JSON.stringify(withBrowserControl),
    }],
  };
}

function requireWindowTargetIdentity(args: Record<string, unknown>, action: string): {
  pid: number;
  windowId: number | string;
} {
  const targetIdentity = args.target_identity;
  if (!targetIdentity || typeof targetIdentity !== 'object' || Array.isArray(targetIdentity)) {
    throw new Error(`Missing required object field target_identity. Call list_windows and pass the target_identity for the window to ${action}.`);
  }
  const record = targetIdentity as Record<string, unknown>;
  const app = record.app;
  const window = record.window;
  const pid = app && typeof app === 'object' && !Array.isArray(app)
    ? (app as Record<string, unknown>).pid
    : null;
  const nativeWindowId = window && typeof window === 'object' && !Array.isArray(window)
    ? (window as Record<string, unknown>).native_window_id
    : null;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('target_identity.app.pid must be an integer.');
  }
  if (
    (typeof nativeWindowId !== 'number' || !Number.isInteger(nativeWindowId))
    && (typeof nativeWindowId !== 'string' || !nativeWindowId.trim())
  ) {
    throw new Error('target_identity.window.native_window_id must be an integer or non-empty string.');
  }
  return { pid, windowId: nativeWindowId };
}

function requireWindowTargetIdentityForBounds(args: Record<string, unknown>): {
  pid: number;
  windowId: number | string;
} {
  return requireWindowTargetIdentity(args, 'move');
}

function requireWindowTargetIdentityForFocus(args: Record<string, unknown>): {
  pid: number;
  windowId: number | string;
} {
  return requireWindowTargetIdentity(args, 'focus');
}

function requireWindowTargetIdentityForClose(args: Record<string, unknown>): {
  pid: number;
  windowId: number | string;
} {
  return requireWindowTargetIdentity(args, 'close');
}

function optionalElementIndex(args: Record<string, unknown>): number | null {
  if (args.element_index === undefined || args.element_index === null) {
    return null;
  }
  const value = Number(args.element_index);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('element_index must be a positive integer.');
  }
  return value;
}

function isContentWindowRecord(window: MacCuaWindowRecord): boolean {
  const width = typeof window.bounds?.width === 'number' ? window.bounds.width : 0;
  const height = typeof window.bounds?.height === 'number' ? window.bounds.height : 0;
  return width > 300 && height > 160;
}

function extractWindowRecords(parsed: unknown): MacCuaWindowRecord[] {
  if (Array.isArray(parsed)) return parsed as MacCuaWindowRecord[];
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as MacCuaWindowRecord[];
    if (Array.isArray(record.windows)) return record.windows as MacCuaWindowRecord[];
  }
  return [];
}

async function resolveMacComputerUseTarget(
  app: string,
  context?: BuiltinToolContext,
): Promise<ComputerUseTarget[]> {
  const response = await callCuaDriverCli('list_windows', {}, context);
  if (response.isError) {
    throw new Error(toolText(response));
  }
  const windows = extractWindowRecords(parseJsonText(toolText(response)))
    .filter((window) => {
      const haystack = `${windowRecordAppName(window)} ${windowRecordTitle(window)}`.toLowerCase();
      return haystack.includes(app.toLowerCase());
    })
    .filter((window) => typeof window.pid === 'number' && windowRecordId(window) !== null);

  if (windows.length === 0) {
    throw new Error(`No windows found for "${app}".`);
  }

  return [...windows].sort((left, right) => {
    const contentDelta = Number(isContentWindowRecord(right)) - Number(isContentWindowRecord(left));
    if (contentDelta !== 0) return contentDelta;
    const currentSpaceDelta = Number(right.on_current_space === true) - Number(left.on_current_space === true);
    if (currentSpaceDelta !== 0) return currentSpaceDelta;
    const onScreenDelta = Number(right.is_on_screen === true) - Number(left.is_on_screen === true);
    if (onScreenDelta !== 0) return onScreenDelta;
    const layerDelta = Number((left.layer ?? 0) === 0) - Number((right.layer ?? 0) === 0);
    if (layerDelta !== 0) return layerDelta;
    const areaDelta = windowRecordArea(right) - windowRecordArea(left);
    if (areaDelta !== 0) return areaDelta;
    const zIndexDelta = (right.z_index ?? 0) - (left.z_index ?? 0);
    if (zIndexDelta !== 0) return zIndexDelta;
    return 0;
  }).map((chosen) => {
    const bounds = chosen.bounds
      && typeof chosen.bounds.x === 'number'
      && typeof chosen.bounds.y === 'number'
      && typeof chosen.bounds.width === 'number'
      && typeof chosen.bounds.height === 'number'
      ? {
          x: chosen.bounds.x,
          y: chosen.bounds.y,
          width: chosen.bounds.width,
          height: chosen.bounds.height,
        }
      : undefined;

    return {
      app: windowRecordAppName(chosen) || app,
      title: windowRecordTitle(chosen),
      pid: chosen.pid!,
      windowId: windowRecordId(chosen)!,
      focusedElementIndex: null,
      onCurrentSpace: chosen.on_current_space === true,
      isOnScreen: chosen.is_on_screen === true,
      bounds,
    };
  });
}

function macComputerUseTreeHasWindowContent(markdown: string | undefined): boolean {
  if (!markdown) return false;
  return /\n\t\d+ standard window\b/.test(markdown)
    && /\n\t\t+\d+ HTML content\b/.test(markdown);
}

export function macComputerUseTreeHasWindowContentForTest(markdown: string | undefined): boolean {
  return macComputerUseTreeHasWindowContent(markdown);
}

const INTERACTIVE_TREE_LINE_LIMIT = 120;
const INTERACTIVE_TREE_LINE_MAX_LENGTH = 220;
const COMPUTER_USE_APP_STATE_TREE_MAX_CHARS = 12_000;
const COMPUTER_USE_SCROLL_MAX_PAGES = 5;
const INTERACTIVE_TREE_LINE_INDEX_RE = /^\s*(?:-\s*)?(?:\[(\d+)\]|(\d+))(?=\s|$)/;
const INTERACTIVE_TREE_ROLE_RE = /\b(?:AX(?:TextField|TextArea|ComboBox|PopUpButton|CheckBox|RadioButton|Button|Slider|MenuItem|Link)|text field|text area|combo box|pop(?: |-)?up button|check ?box|radio button|button|slider|menu item|link)\b/i;
const INTERACTIVE_TREE_ACTION_RE = /\b(?:set_value|click|press|toggle|show menu)\b/i;
const CONTEXT_TREE_ROLE_RE = /\b(?:AXStaticText|static text|heading|label|paragraph|text)\b/i;
const WEB_CONTENT_TREE_RE = /\b(?:HTML content|web area)\b/i;
const INTERACTIVE_CONTEXT_LINE_LIMIT = 3;

function compactComputerUseTreeLine(line: string): string {
  const compact = line.replace(/\s+/g, ' ').trim();
  return compact.length > INTERACTIVE_TREE_LINE_MAX_LENGTH
    ? `${compact.slice(0, INTERACTIVE_TREE_LINE_MAX_LENGTH - 1)}...`
    : compact;
}

function computerUseTreeIndent(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === '\t') {
      indent += 2;
    } else if (char === ' ') {
      indent += 1;
    } else {
      break;
    }
  }
  return indent;
}

function buildComputerUseInteractiveElementsSummary(markdown: string | undefined): string[] {
  if (!markdown) return [];
  const pageElements: string[] = [];
  const otherElements: string[] = [];
  const recentPageContext: string[] = [];
  const recentOtherContext: string[] = [];
  const emittedPageLines = new Set<string>();
  const emittedOtherLines = new Set<string>();
  let webContentIndent: number | null = null;
  const pushUnique = (target: string[], emitted: Set<string>, line: string) => {
    if (!line || emitted.has(line)) return;
    target.push(line);
    emitted.add(line);
  };
  for (const line of markdown.split('\n')) {
    const indent = computerUseTreeIndent(line);
    if (webContentIndent !== null && indent <= webContentIndent) {
      webContentIndent = null;
    }
    if (WEB_CONTENT_TREE_RE.test(line)) {
      webContentIndent = indent;
    }
    const hasIndexedLine = INTERACTIVE_TREE_LINE_INDEX_RE.test(line);
    if (!hasIndexedLine) continue;
    const compact = compactComputerUseTreeLine(line);
    if (!compact) continue;
    const isPageElement = webContentIndent !== null && indent > webContentIndent;
    const isInteractive = INTERACTIVE_TREE_ROLE_RE.test(line) || INTERACTIVE_TREE_ACTION_RE.test(line);
    if (!isInteractive) {
      if (!CONTEXT_TREE_ROLE_RE.test(line)) continue;
      const contextLines = isPageElement ? recentPageContext : recentOtherContext;
      contextLines.push(compact);
      while (contextLines.length > INTERACTIVE_CONTEXT_LINE_LIMIT) {
        contextLines.shift();
      }
      continue;
    }
    if (webContentIndent !== null && indent > webContentIndent) {
      for (const contextLine of recentPageContext) {
        pushUnique(pageElements, emittedPageLines, contextLine);
      }
      pushUnique(pageElements, emittedPageLines, compact);
    } else {
      for (const contextLine of recentOtherContext) {
        pushUnique(otherElements, emittedOtherLines, contextLine);
      }
      pushUnique(otherElements, emittedOtherLines, compact);
    }
  }
  return [...pageElements, ...otherElements].slice(0, INTERACTIVE_TREE_LINE_LIMIT);
}

export function buildComputerUseInteractiveElementsSummaryForTest(markdown: string | undefined): string[] {
  return buildComputerUseInteractiveElementsSummary(markdown);
}

type ComputerUseUiRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ComputerUseUiElementRef = {
  elementIndex: number;
  role: string;
  bounds: ComputerUseUiRegion;
  rawLine: string;
};

const UI_ELEMENT_BOUNDS_RE = /bounds=\{x=(-?\d+(?:\.\d+)?), y=(-?\d+(?:\.\d+)?), width=(\d+(?:\.\d+)?), height=(\d+(?:\.\d+)?), coordinate_space=screen_points\}/;

function requireOptionalUiRegion(args: Record<string, unknown>): ComputerUseUiRegion | null {
  const provided = ['x', 'y', 'width', 'height'].filter((key) => args[key] !== undefined);
  if (provided.length === 0) return null;
  if (provided.length !== 4) {
    throw new Error('Region filtering requires x, y, width, and height together.');
  }
  const x = numberArg(args, 'x');
  const y = numberArg(args, 'y');
  const width = numberArg(args, 'width');
  const height = numberArg(args, 'height');
  if (x === null) throw new Error('Missing required number field x.');
  if (y === null) throw new Error('Missing required number field y.');
  if (width === null || width <= 0) throw new Error('Missing required positive number field width.');
  if (height === null || height <= 0) throw new Error('Missing required positive number field height.');
  return { x, y, width, height };
}

function regionsIntersect(left: ComputerUseUiRegion, right: ComputerUseUiRegion): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function parseComputerUseUiElements(markdown: string | undefined, region: ComputerUseUiRegion | null): ComputerUseUiElementRef[] {
  if (!markdown) return [];
  const elements: ComputerUseUiElementRef[] = [];
  for (const line of markdown.split('\n')) {
    const boundsMatch = UI_ELEMENT_BOUNDS_RE.exec(line);
    if (!boundsMatch) continue;
    const indexMatch = /(?:^|\s)-\s*\[(\d+)\]\s+([^\s]+)/.exec(line)
      ?? /^\s*(\d+)\s+([^\s]+)/.exec(line);
    if (!indexMatch) continue;
    const bounds = {
      x: Number(boundsMatch[1]),
      y: Number(boundsMatch[2]),
      width: Number(boundsMatch[3]),
      height: Number(boundsMatch[4]),
    };
    if (region && !regionsIntersect(bounds, region)) continue;
    elements.push({
      elementIndex: Number(indexMatch[1]),
      role: indexMatch[2],
      bounds,
      rawLine: compactComputerUseTreeLine(line),
    });
  }
  return elements.slice(0, INTERACTIVE_TREE_LINE_LIMIT);
}

function formatComputerUseUiElements(
  target: ComputerUseTarget,
  parsed: { tree_markdown?: string; element_count?: number; turn_id?: number },
  region: ComputerUseUiRegion | null,
): ToolCallResponse {
  const elements = parseComputerUseUiElements(parsed.tree_markdown, region);
  const lines = ['CUA UI elements (coordinate_space=screen_points)'];
  lines.push(`Target: app="${target.app}" pid=${target.pid} window_id=${target.windowId}`);
  lines.push(`Window: "${target.title || target.app}"`);
  lines.push('Coordinate metadata: coordinate_space=screen_points display_id=unreported_by_cua_driver scale_factor=unreported_by_cua_driver');
  if (typeof parsed.turn_id === 'number') {
    lines.push(`Snapshot: turn_id=${parsed.turn_id}`);
  }
  if (typeof parsed.element_count === 'number') {
    lines.push(`Snapshot element_count=${parsed.element_count}`);
  }
  if (region) {
    lines.push(`Region filter: x=${region.x} y=${region.y} width=${region.width} height=${region.height}`);
  }
  lines.push('Refs are snapshot-scoped element_index values. Call get_ui_elements or get_app_state again after the UI changes.');
  lines.push('<ui_elements>');
  for (const element of elements) {
    lines.push([
      `ref=element_index:${element.elementIndex}`,
      `element_index=${element.elementIndex}`,
      `role=${element.role}`,
      `bounds={x=${element.bounds.x}, y=${element.bounds.y}, width=${element.bounds.width}, height=${element.bounds.height}, coordinate_space=screen_points}`,
      `raw=${JSON.stringify(element.rawLine)}`,
    ].join(' '));
  }
  if (elements.length === 0) {
    lines.push('No bounded actionable UI elements observed.');
  }
  lines.push('</ui_elements>');
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

export function parseComputerUseUiElementsForTest(
  markdown: string | undefined,
  region: ComputerUseUiRegion | null,
): ComputerUseUiElementRef[] {
  return parseComputerUseUiElements(markdown, region);
}

function formatComputerUseTreeMarkdownForModel(markdown: string | undefined): string | null {
  if (!markdown) return null;
  const trimmed = markdown.trimEnd();
  if (trimmed.length <= COMPUTER_USE_APP_STATE_TREE_MAX_CHARS) {
    return trimmed;
  }
  return [
    trimmed.slice(0, COMPUTER_USE_APP_STATE_TREE_MAX_CHARS).trimEnd(),
    `[accessibility tree truncated after ${COMPUTER_USE_APP_STATE_TREE_MAX_CHARS} chars; use <interactive_elements> above for actionable indexed controls]`,
  ].join('\n');
}

export function formatComputerUseTreeMarkdownForModelForTest(markdown: string | undefined): string | null {
  return formatComputerUseTreeMarkdownForModel(markdown);
}

function textFromToolResponse(response: ToolCallResponse): string {
  return response.content
    .map((item) => item.type === 'text' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

// select_option result text embeds raw sub-tool evidence (set_value output,
// opened-menu window state, verification window state). Full window states run
// to hundreds of KiB on real pages; bound each evidence block so the tool
// result stays readable for any model and any transport.
const SELECT_OPTION_EVIDENCE_MAX_CHARS = 2_000;

function boundSelectOptionEvidence(text: string): string {
  if (text.length <= SELECT_OPTION_EVIDENCE_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, SELECT_OPTION_EVIDENCE_MAX_CHARS)}\n[evidence truncated: ${text.length - SELECT_OPTION_EVIDENCE_MAX_CHARS} more characters]`;
}

// Spacing/case/punctuation-insensitive: spoken and transcribed option text has
// no reliable orthography ("Businessowners Policy" vs visible option
// "Business owners policy"), so options match on their letters and digits only.
function normalizeSelectOptionMatchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Resolve the requested option text against the popup's materialized
// AXMenuItem descendants: exact-normalized equality, and only a UNIQUE match
// counts. Returns the exact visible option text plus the observed options.
function resolveMacSelectOptionFromElements(
  elements: MacCuaWindowStateElement[],
  popupElementIndex: number,
  value: string,
): { optionText: string | null; options: string[] } {
  const byIndex = new Map<number, MacCuaWindowStateElement>();
  for (const element of elements) {
    if (typeof element.element_index === 'number') {
      byIndex.set(element.element_index, element);
    }
  }
  const isPopupDescendant = (element: MacCuaWindowStateElement): boolean => {
    let current: MacCuaWindowStateElement | undefined = element;
    for (let hop = 0; hop < 100 && current; hop += 1) {
      if (current.element_index === popupElementIndex) {
        return true;
      }
      current = typeof current.parent_index === 'number' ? byIndex.get(current.parent_index) : undefined;
    }
    return false;
  };
  const options: string[] = [];
  for (const element of elements) {
    if (element.role !== 'AXMenuItem') {
      continue;
    }
    const text = (element.label ?? element.value ?? '').trim();
    if (!text || !isPopupDescendant(element)) {
      continue;
    }
    if (!options.includes(text)) {
      options.push(text);
    }
  }
  const wanted = normalizeSelectOptionMatchText(value);
  const matches = wanted
    ? options.filter((option) => normalizeSelectOptionMatchText(option) === wanted)
    : [];
  return { optionText: matches.length === 1 ? matches[0] : null, options };
}

export function resolveMacSelectOptionFromElementsForTest(
  elements: MacCuaWindowStateElement[],
  popupElementIndex: number,
  value: string,
): { optionText: string | null; options: string[] } {
  return resolveMacSelectOptionFromElements(elements, popupElementIndex, value);
}

async function waitForMacSelectOptionResolution(
  target: { pid: number; windowId: string | number | null },
  elementIndex: number,
  value: string,
  context: BuiltinToolContext | undefined,
  appApprovalArgs: Record<string, unknown>,
): Promise<{ menuState: ToolCallResponse | null; optionText: string | null; options: string[] }> {
  const startedAt = Date.now();
  let menuState: ToolCallResponse | null = null;
  let options: string[] = [];
  while (Date.now() - startedAt <= MAC_SELECT_OPTION_MENU_WAIT_MS) {
    menuState = await callCuaDriverCli('get_window_state', {
      pid: target.pid,
      window_id: target.windowId,
    }, context, undefined, appApprovalArgs);
    if (!menuState.isError) {
      const parsed = parseJsonText(toolText(menuState)) as MacCuaWindowState;
      const resolved = resolveMacSelectOptionFromElements(parsed.elements ?? [], elementIndex, value);
      options = resolved.options;
      if (resolved.optionText !== null) {
        return { menuState, optionText: resolved.optionText, options };
      }
    }
    await new Promise(resolve => setTimeout(resolve, MAC_SELECT_OPTION_MENU_POLL_MS));
  }
  return { menuState, optionText: null, options };
}

function requireAppArg(args: Record<string, unknown>): string {
  const app = args.app;
  if (typeof app !== 'string' || !app.trim()) {
    throw new Error('Missing required string field app.');
  }
  return app.trim();
}

function optionalComputerUseTargetFromIdentity(
  app: string,
  args: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): ComputerUseTarget | null {
  const targetIdentity = args.target_identity;
  if (targetIdentity === undefined) {
    return null;
  }
  if (!targetIdentity || typeof targetIdentity !== 'object' || Array.isArray(targetIdentity)) {
    throw new Error('target_identity must be an object.');
  }
  const record = targetIdentity as Record<string, unknown>;
  if (record.kind !== 'app-window') {
    throw new Error('target_identity.kind must be "app-window".');
  }
  const appRecord = record.app;
  const windowRecord = record.window;
  if (!appRecord || typeof appRecord !== 'object' || Array.isArray(appRecord)) {
    throw new Error('target_identity.app must be an object.');
  }
  if (!windowRecord || typeof windowRecord !== 'object' || Array.isArray(windowRecord)) {
    throw new Error('target_identity.window must be an object.');
  }
  const pid = (appRecord as Record<string, unknown>).pid;
  const nativeWindowId = (windowRecord as Record<string, unknown>).native_window_id;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Error('target_identity.app.pid must be an integer.');
  }
  const windowId = typeof nativeWindowId === 'number' && Number.isInteger(nativeWindowId)
    ? nativeWindowId
    : typeof nativeWindowId === 'string' && platform === 'darwin' && /^\d+$/.test(nativeWindowId)
      ? Number(nativeWindowId)
      : typeof nativeWindowId === 'string' && platform !== 'darwin' && nativeWindowId.trim()
        ? nativeWindowId.trim()
        : null;
  if (windowId === null) {
    throw new Error(platform === 'darwin'
      ? 'target_identity.window.native_window_id must be an integer for macOS Computer Use.'
      : 'target_identity.window.native_window_id must be a non-empty window id for Computer Use.');
  }
  const appName = (appRecord as Record<string, unknown>).name;
  const title = (windowRecord as Record<string, unknown>).title;
  assertNotProtectedDesktopPid(pid);
  return {
    app: typeof appName === 'string' && appName.trim() ? appName.trim() : app,
    title: typeof title === 'string' ? title : '',
    pid,
    windowId,
    focusedElementIndex: null,
    onCurrentSpace: true,
    isOnScreen: true,
    bounds: normalizeWindowBounds(record.bounds) ?? undefined,
  };
}

function computerUseCacheKey(app: string, context?: BuiltinToolContext): string {
  return `${approvalAgentId(context) ?? 'default'}:${app.toLowerCase()}`;
}

function cacheComputerUseTarget(
  app: string,
  target: ComputerUseTarget,
  context?: BuiltinToolContext,
): void {
  computerUseAppStateCache.set(computerUseCacheKey(app, context), target);
  computerUseAppStateCache.set(computerUseCacheKey(target.app, context), target);
}

function requireCachedComputerUseTarget(
  app: string,
  context?: BuiltinToolContext,
): ComputerUseTarget {
  const cached = computerUseAppStateCache.get(computerUseCacheKey(app, context));
  if (!cached) {
    throw new Error(`No cached app state exists for "${app}". Call get_app_state first.`);
  }
  assertNotProtectedDesktopPid(cached.pid);
  return cached;
}

type MacCuaAppRecord = {
  active?: boolean;
  bundle_id?: string;
  name?: string;
  pid?: number;
  running?: boolean;
};

function extractAppRecords(parsed: unknown): MacCuaAppRecord[] {
  if (Array.isArray(parsed)) return parsed as MacCuaAppRecord[];
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.apps)) return record.apps as MacCuaAppRecord[];
    if (Array.isArray(record.data)) return record.data as MacCuaAppRecord[];
  }
  return [];
}

function formatMacComputerUseApps(response: ToolCallResponse): ToolCallResponse {
  const apps = extractAppRecords(parseJsonText(toolText(response)));
  const lines = apps
    .filter((app) => typeof app.name === 'string' && typeof app.bundle_id === 'string')
    .map((app) => {
      const flags = [
        app.running ? 'running' : null,
        app.active ? 'active' : null,
      ].filter(Boolean).join(', ');
      return `${app.name} — ${app.bundle_id}${flags ? ` [${flags}]` : ''}`;
    });
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

export type MacCuaWindowStateElement = {
  element_index?: number;
  parent_index?: number;
  role?: string;
  label?: string;
  value?: string;
};

type MacCuaWindowState = {
  bundle_id?: string;
  element_count?: number;
  elements?: MacCuaWindowStateElement[];
  name?: string;
  pid?: number;
  screenshot_file_path?: string;
  screenshot_height?: number;
  screenshot_original_height?: number;
  screenshot_original_width?: number;
  screenshot_scale_factor?: number;
  screenshot_width?: number;
  tree_markdown?: string;
};

function macComputerUseScreenshotPath(app: string): string {
  const safeApp = app.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  const filename = `computer-use-${safeApp}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  return path.join(getSandboxDir(), filename);
}

function focusedElementIndexFromTreeMarkdown(markdown: string | undefined): number | null {
  if (!markdown) return null;
  const match = markdown.match(/(?:^|\n)\s*(\d+)\s+.*\bFOCUSED\b/);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

export function macComputerUseScreenshotPathForTest(app: string): string {
  return macComputerUseScreenshotPath(app);
}

function formatMacComputerUseState(
  response: ToolCallResponse,
  target: { app: string; title: string; pid: number },
  parsed = parseJsonText(toolText(response)) as MacCuaWindowState,
  screenshotPath?: string,
): ToolCallResponse {
  const appName = parsed.name ?? target.app;
  const appId = parsed.bundle_id ?? appName;
  const title = target.title || appName;
  const lines = ['Computer Use state (CUA App Version: Interpreter)'];
  const interactiveElements = buildComputerUseInteractiveElementsSummary(parsed.tree_markdown);
  if (interactiveElements.length > 0) {
    lines.push('<interactive_elements>');
    lines.push('Web page and form controls are listed first. Nearby text lines are raw context, not label assignments. Use control element indices with CUA click, scroll, select_option, and set_value. Element bounds are observed screen-point boxes when present.');
    lines.push(...interactiveElements);
    lines.push('</interactive_elements>');
  }
  lines.push('<app_state>');
  lines.push(`App=${appId} (pid ${parsed.pid ?? target.pid})`);
  lines.push(`Window: "${title}", App: ${appName}.`);
  const treeMarkdown = formatComputerUseTreeMarkdownForModel(parsed.tree_markdown);
  if (treeMarkdown) {
    lines.push(treeMarkdown);
  }
  lines.push('</app_state>');
  const content: ToolCallResponse['content'] = [
    { type: 'text', text: lines.join('\n') },
  ];
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    content.push({
      type: 'image',
      image: {
        data: fs.readFileSync(screenshotPath).toString('base64'),
        mimeType: 'image/jpeg',
      },
    });
  }
  return {
    ...response,
    content,
    imagePaths: screenshotPath && fs.existsSync(screenshotPath) ? [screenshotPath] : response.imagePaths,
  };
}

type WindowsCuaWindowRecord = {
  app_name?: string;
  bounds?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  is_focused?: boolean;
  pid?: number;
  title?: string;
  window_id?: string;
};

type WindowsCuaAppRecord = {
  name?: string;
  pid?: number;
  window_count?: number;
};

type WindowsCuaWindowState = {
  app?: string;
  bounds?: WindowsCuaWindowRecord['bounds'];
  elements?: unknown[];
  pid?: number;
  title?: string;
  tree_markdown?: string;
  window_id?: string;
};

function unwrapWindowsToolData(response: ToolCallResponse): unknown {
  const envelope = parseWindowsToolEnvelope(toolResponseText(response));
  if (!envelope) {
    throw new Error(toolResponseText(response) || 'Windows Computer Use returned invalid JSON.');
  }
  if (envelope.ok === false) {
    const error = envelope as { error?: { message?: string } };
    throw new Error(error.error?.message ?? toolResponseText(response));
  }
  return envelope.data;
}

function extractWindowsWindowRecords(value: unknown): WindowsCuaWindowRecord[] {
  return Array.isArray(value) ? value as WindowsCuaWindowRecord[] : [];
}

function extractWindowsAppRecords(value: unknown): WindowsCuaAppRecord[] {
  return Array.isArray(value) ? value as WindowsCuaAppRecord[] : [];
}

function normalizedWindowBounds(
  bounds: WindowsCuaWindowRecord['bounds'] | undefined,
): ComputerUseTarget['bounds'] | undefined {
  if (
    bounds
    && typeof bounds.x === 'number'
    && typeof bounds.y === 'number'
    && typeof bounds.width === 'number'
    && typeof bounds.height === 'number'
  ) {
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }
  return undefined;
}

async function resolveWindowsComputerUseTarget(
  app: string,
  context?: BuiltinToolContext,
): Promise<ComputerUseTarget> {
  const response = await callCuaDriverCli('list_windows', {}, context);
  if (response.isError) {
    throw new Error(toolText(response));
  }
  const windows = extractWindowsWindowRecords(unwrapWindowsToolData(response))
    .filter((window) => {
      const haystack = `${window.app_name ?? ''} ${window.title ?? ''}`.toLowerCase();
      return haystack.includes(app.toLowerCase());
    })
    .filter((window) => typeof window.pid === 'number' && typeof window.window_id === 'string');

  if (windows.length === 0) {
    throw new Error(`No windows found for "${app}".`);
  }

  const chosen = [...windows].sort((left, right) => {
    const focusedDelta = Number(right.is_focused === true) - Number(left.is_focused === true);
    if (focusedDelta !== 0) return focusedDelta;
    return windowRecordArea(right as MacCuaWindowRecord) - windowRecordArea(left as MacCuaWindowRecord);
  })[0]!;

  return {
    app: chosen.app_name ?? app,
    title: chosen.title ?? '',
    pid: chosen.pid!,
    windowId: chosen.window_id!,
    focusedElementIndex: null,
    onCurrentSpace: true,
    isOnScreen: true,
    bounds: normalizedWindowBounds(chosen.bounds),
  };
}

function formatWindowsComputerUseApps(response: ToolCallResponse): ToolCallResponse {
  const apps = extractWindowsAppRecords(unwrapWindowsToolData(response));
  const lines = apps
    .filter((app) => typeof app.name === 'string' && typeof app.pid === 'number')
    .map((app) => {
      const windowCount = typeof app.window_count === 'number' ? app.window_count : 0;
      return `${app.name} — pid ${app.pid} [running, windows: ${windowCount}]`;
    });
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function formatWindowsComputerUseState(
  response: ToolCallResponse,
  target: ComputerUseTarget,
  parsed = unwrapWindowsToolData(response) as WindowsCuaWindowState,
  screenshotBase64?: string,
): ToolCallResponse {
  const appName = parsed.app ?? target.app;
  const title = parsed.title ?? (target.title || appName);
  const lines = ['Computer Use state (CUA App Version: Interpreter)'];
  const interactiveElements = buildComputerUseInteractiveElementsSummary(parsed.tree_markdown);
  if (interactiveElements.length > 0) {
    lines.push('<interactive_elements>');
    lines.push('Web page and form controls are listed first. Nearby text lines are raw context, not label assignments. Use control element indices with CUA click, scroll, select_option, and set_value. Element bounds are observed screen-point boxes when present.');
    lines.push(...interactiveElements);
    lines.push('</interactive_elements>');
  }
  lines.push('<app_state>');
  lines.push(`App=${appName} (pid ${parsed.pid ?? target.pid})`);
  lines.push(`Window: "${title}", App: ${appName}.`);
  const treeMarkdown = formatComputerUseTreeMarkdownForModel(parsed.tree_markdown);
  if (treeMarkdown) {
    lines.push(treeMarkdown);
  }
  lines.push('</app_state>');
  const content: ToolCallResponse['content'] = [
    { type: 'text', text: lines.join('\n') },
  ];
  if (screenshotBase64) {
    content.push({
      type: 'image',
      image: {
        data: screenshotBase64,
        mimeType: 'image/png',
      },
    });
  }
  return {
    ...response,
    content,
  };
}

function screenshotCoordinateToScreenCoordinate(
  target: ComputerUseTarget,
  x: unknown,
  y: unknown,
): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!target.bounds) return { x, y };
  return {
    x: target.bounds.x + x,
    y: target.bounds.y + y,
  };
}

function requireScreenshotCoordinate(
  target: ComputerUseTarget,
  x: unknown,
  y: unknown,
  label: string,
): { x: number; y: number } {
  const point = screenshotCoordinateToScreenCoordinate(target, x, y);
  if (!point) {
    throw new Error(`drag requires numeric ${label}_x and ${label}_y.`);
  }
  return point;
}

function macLaunchAppArgs(args: Record<string, unknown>): Record<string, unknown> {
  const nextArgs = { ...args };
  if (typeof nextArgs.app === 'string' && typeof nextArgs.name !== 'string' && typeof nextArgs.bundle_id !== 'string') {
    nextArgs.name = nextArgs.app;
  }
  delete nextArgs.app;
  return nextArgs;
}

function keyAndModifiers(rawKey: string): { key: string; modifiers?: string[] } {
  const parts = rawKey.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return { key: rawKey };
  return {
    key: parts[parts.length - 1]!,
    modifiers: parts.slice(0, -1).map((part) => part.toLowerCase()),
  };
}

async function callMacComputerUseTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
): Promise<ToolCallResponse> {
  if (toolName === 'list_apps') {
    const response = await callCuaDriverCli('list_apps', {}, context);
    if (response.isError) return response;
    return formatMacComputerUseApps(response);
  }

  if (toolName === 'list_windows') {
    return enrichListWindowsResponseWithTargetIdentity(
      await callCuaDriverCli('list_windows', args, context),
    );
  }

  if (toolName === 'launch_app') {
    return callCuaDriverCli('launch_app', macLaunchAppArgs(args), context);
  }

  if (toolName === 'set_window_bounds') {
    const { pid, windowId } = requireWindowTargetIdentityForBounds(args);
    if (typeof windowId !== 'number') {
      throw new Error('target_identity.window.native_window_id must be an integer for macOS window positioning.');
    }
    const x = typeof args.x === 'number' ? args.x : null;
    const y = typeof args.y === 'number' ? args.y : null;
    const width = typeof args.width === 'number' ? args.width : null;
    const height = typeof args.height === 'number' ? args.height : null;
    if (x === null) throw new Error('Missing required number field x.');
    if (y === null) throw new Error('Missing required number field y.');
    if (width === null) throw new Error('Missing required number field width.');
    if (height === null) throw new Error('Missing required number field height.');
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli('set_window_bounds', {
      pid,
      window_id: windowId,
      x,
      y,
      width,
      height,
    }, context);
  }

  if (toolName === 'focus_window') {
    const { pid, windowId } = requireWindowTargetIdentityForFocus(args);
    if (typeof windowId !== 'number') {
      throw new Error('target_identity.window.native_window_id must be an integer for macOS window focus.');
    }
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli('focus_window', {
      pid,
      window_id: windowId,
    }, context);
  }

  if (toolName === 'close_window') {
    const { pid, windowId } = requireWindowTargetIdentityForClose(args);
    if (typeof windowId !== 'number') {
      throw new Error('target_identity.window.native_window_id must be an integer for macOS window close.');
    }
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli('close_window', {
      pid,
      window_id: windowId,
    }, context);
  }

  if (toolName === 'minimize_window' || toolName === 'restore_window' || toolName === 'maximize_window') {
    const { pid, windowId } = requireWindowTargetIdentity(args, toolName.replace('_window', ''));
    if (typeof windowId !== 'number') {
      throw new Error(`target_identity.window.native_window_id must be an integer for macOS ${toolName}.`);
    }
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli(toolName, {
      pid,
      window_id: windowId,
    }, context);
  }

  const app = requireAppArg(args);
  const appApprovalArgs = { app };

  if (toolName === 'get_app_state') {
    const explicitTarget = optionalComputerUseTargetFromIdentity(app, args);
    const targets = explicitTarget ? [explicitTarget] : await resolveMacComputerUseTarget(app, context);
    await assertNativeBrowserReadAllowed([app, ...targets.map((target) => target.app)].join(' '));
    const screenshotPath = macComputerUseScreenshotPath(app);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    let lastResponse: ToolCallResponse | null = null;
    let lastTarget: ComputerUseTarget | null = null;
    let lastParsed: MacCuaWindowState | null = null;

    for (const target of targets) {
      assertNotProtectedDesktopPid(target.pid);
      try {
        fs.rmSync(screenshotPath, { force: true });
      } catch {
        // Best effort only: a failed cleanup should not block AX inspection.
      }
      const response = await callCuaDriverCli('get_window_state', {
        pid: target.pid,
        window_id: target.windowId,
      }, context, screenshotPath, appApprovalArgs);
      if (response.isError) {
        lastResponse = response;
        lastTarget = target;
        continue;
      }
      const parsed = parseJsonText(toolText(response)) as MacCuaWindowState;
      lastResponse = response;
      lastTarget = target;
      lastParsed = parsed;
      if (macComputerUseTreeHasWindowContent(parsed.tree_markdown)) {
        const observedTarget = {
          ...target,
          focusedElementIndex: focusedElementIndexFromTreeMarkdown(parsed.tree_markdown),
        };
        cacheComputerUseTarget(app, observedTarget, context);
        const resolvedScreenshotPath = parsed.screenshot_file_path ?? screenshotPath;
        return formatMacComputerUseState(response, observedTarget, parsed, resolvedScreenshotPath);
      }
    }

    if (lastResponse?.isError) return lastResponse;
    if (lastResponse && lastTarget && lastParsed) {
      const observedTarget = {
        ...lastTarget,
        focusedElementIndex: focusedElementIndexFromTreeMarkdown(lastParsed.tree_markdown),
      };
      cacheComputerUseTarget(app, observedTarget, context);
      const resolvedScreenshotPath = lastParsed.screenshot_file_path ?? screenshotPath;
      return formatMacComputerUseState(lastResponse, observedTarget, lastParsed, resolvedScreenshotPath);
    }

    throw new Error(`No inspectable windows found for "${app}".`);
  }

  if (toolName === 'get_ui_elements') {
    const region = requireOptionalUiRegion(args);
    const explicitTarget = optionalComputerUseTargetFromIdentity(app, args);
    const targets = explicitTarget ? [explicitTarget] : await resolveMacComputerUseTarget(app, context);
    await assertNativeBrowserReadAllowed([app, ...targets.map((target) => target.app)].join(' '));
    let lastResponse: ToolCallResponse | null = null;
    let lastTarget: ComputerUseTarget | null = null;
    let lastParsed: MacCuaWindowState | null = null;

    for (const target of targets) {
      assertNotProtectedDesktopPid(target.pid);
      const response = await callCuaDriverCli('get_window_state', {
        pid: target.pid,
        window_id: target.windowId,
      }, context, undefined, appApprovalArgs);
      if (response.isError) {
        lastResponse = response;
        lastTarget = target;
        continue;
      }
      const parsed = parseJsonText(toolText(response)) as MacCuaWindowState;
      lastResponse = response;
      lastTarget = target;
      lastParsed = parsed;
      if (macComputerUseTreeHasWindowContent(parsed.tree_markdown)) {
        const observedTarget = {
          ...target,
          focusedElementIndex: focusedElementIndexFromTreeMarkdown(parsed.tree_markdown),
        };
        cacheComputerUseTarget(app, observedTarget, context);
        return formatComputerUseUiElements(observedTarget, parsed, region);
      }
    }

    if (lastResponse?.isError) return lastResponse;
    if (lastResponse && lastTarget && lastParsed) {
      const observedTarget = {
        ...lastTarget,
        focusedElementIndex: focusedElementIndexFromTreeMarkdown(lastParsed.tree_markdown),
      };
      cacheComputerUseTarget(app, observedTarget, context);
      return formatComputerUseUiElements(observedTarget, lastParsed, region);
    }

    throw new Error(`No inspectable windows found for "${app}".`);
  }

  const target = optionalComputerUseTargetFromIdentity(app, args) ?? requireCachedComputerUseTarget(app, context);
  if (toolName === 'click') {
    if (args.mouse_button === 'middle') throw new Error('middle mouse button is not supported.');
    const elementIndex = args.element_index;
    if (typeof elementIndex === 'string' || typeof elementIndex === 'number') {
      const count = typeof args.click_count === 'number' ? Math.max(1, Math.round(args.click_count)) : 1;
      if (args.mouse_button === 'right') {
        return callCuaDriverCli('right_click', {
          pid: target.pid,
          window_id: target.windowId,
          element_index: Number(elementIndex),
        }, context, undefined, appApprovalArgs);
      }
      return callCuaDriverCli(count > 1 ? 'double_click' : 'click', {
        pid: target.pid,
        window_id: target.windowId,
        element_index: Number(elementIndex),
        ...(args.skip_change_detection === true ? { skip_change_detection: true } : {}),
        ...(typeof args.action === 'string' ? { action: args.action } : {}),
      }, context, undefined, appApprovalArgs);
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      return callCuaDriverCli('click', {
        pid: target.pid,
        window_id: target.windowId,
        x: args.x,
        y: args.y,
        count: typeof args.click_count === 'number' ? Math.max(1, Math.round(args.click_count)) : undefined,
      }, context, undefined, appApprovalArgs);
    }
    throw new Error('click requires element_index or x/y.');
  }

  if (toolName === 'drag') {
    return callCuaDriverCli('drag', {
      pid: target.pid,
      window_id: target.windowId,
      from_x: args.from_x,
      from_y: args.from_y,
      to_x: args.to_x,
      to_y: args.to_y,
    }, context, undefined, appApprovalArgs);
  }

  if (toolName === 'press_key') {
    if (typeof args.key !== 'string' || !args.key.trim()) throw new Error('Missing required string field key.');
    const key = keyAndModifiers(args.key.trim());
    if (key.modifiers?.length) {
      return callCuaDriverCli('hotkey', {
        pid: target.pid,
        keys: [...key.modifiers, key.key],
      }, context, undefined, appApprovalArgs);
    }
    const pressArgs: Record<string, unknown> = {
      pid: target.pid,
      ...key,
      ...(args.skip_change_detection === true ? { skip_change_detection: true } : {}),
    };
    if (target.focusedElementIndex !== null) {
      pressArgs.window_id = target.windowId;
      pressArgs.element_index = target.focusedElementIndex;
    }
    return callCuaDriverCli('press_key', pressArgs, context, undefined, appApprovalArgs);
  }

  if (toolName === 'type_text') {
    if (typeof args.text !== 'string') throw new Error('Missing required string field text.');
    const elementIndex = optionalElementIndex(args);
    const typeArgs: Record<string, unknown> = {
      pid: target.pid,
      text: args.text,
      ...(args.skip_change_detection === true ? { skip_change_detection: true } : {}),
    };
    if (elementIndex !== null) {
      typeArgs.window_id = target.windowId;
      typeArgs.element_index = elementIndex;
    } else if (target.focusedElementIndex !== null) {
      typeArgs.window_id = target.windowId;
      typeArgs.element_index = target.focusedElementIndex;
    }
    return callCuaDriverCli('type_text', typeArgs, context, undefined, appApprovalArgs);
  }

  if (toolName === 'set_value') {
    if (args.element_index === undefined) throw new Error('Missing required field element_index.');
    if (typeof args.value !== 'string') throw new Error('Missing required string field value.');
    return callCuaDriverCli('set_value', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: Number(args.element_index),
      value: args.value,
      ...(args.skip_change_detection === true ? { skip_change_detection: true } : {}),
    }, context, undefined, appApprovalArgs);
  }

  if (toolName === 'select_option') {
    if (args.element_index === undefined) throw new Error('Missing required field element_index.');
    if (typeof args.option !== 'string' || !args.option.trim()) throw new Error('Missing required string field option.');
    const elementIndex = Number(args.element_index);
    const value = args.option.trim();
    const skipChangeDetection = args.skip_change_detection === true
      ? { skip_change_detection: true }
      : {};
    const direct = await callCuaDriverCli('set_value', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: elementIndex,
      value,
      ...skipChangeDetection,
    }, context, undefined, appApprovalArgs);
    if (!direct.isError) {
      return direct;
    }

    const click = await callCuaDriverCli('click', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: elementIndex,
      ...skipChangeDetection,
    }, context, undefined, appApprovalArgs);
    if (click.isError) {
      return {
        content: [{
          type: 'text',
          text: [
            `Could not select option "${value}" on [${elementIndex}].`,
            'Direct set_value failed:',
            boundSelectOptionEvidence(textFromToolResponse(direct)),
            'Opening the control also failed:',
            boundSelectOptionEvidence(textFromToolResponse(click)),
          ].join('\n'),
        }],
        isError: true,
      };
    }

    // Direct exact/case-insensitive set_value failed. The popup is the only
    // holder of its option list, so open it, observe the materialized option
    // texts, close it with Escape, and — when the requested text resolves to
    // exactly one visible option ignoring case/spacing/punctuation (spoken
    // and transcribed option text has no reliable orthography) — act through
    // set_value again with the exact visible text. set_value is the one
    // verified popup primitive; pressing observed menu items directly is a
    // silent no-op on Chromium popups, and blind typeahead+Return can leak
    // an Enter into the page (observed submitting a real form).
    const menu = await waitForMacSelectOptionResolution(target, elementIndex, value, context, appApprovalArgs);
    const closeMenu = await callCuaDriverCli('press_key', {
      pid: target.pid,
      window_id: target.windowId,
      key: 'escape',
    }, context, undefined, appApprovalArgs);
    const closeEvidence = closeMenu.isError
      ? ['Menu close (Escape) result:', boundSelectOptionEvidence(textFromToolResponse(closeMenu))]
      : [];
    if (menu.optionText === null) {
      return {
        content: [{
          type: 'text',
          text: [
            `Could not select option "${value}" on [${elementIndex}]: no single visible option matches that text.`,
            `Observed options: ${JSON.stringify(menu.options)}.`,
            'Retry with the exact visible option text.',
            'Direct set_value result:',
            boundSelectOptionEvidence(textFromToolResponse(direct)),
            ...closeEvidence,
          ].join('\n'),
        }],
        isError: true,
      };
    }
    const resolved = await callCuaDriverCli('set_value', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: elementIndex,
      value: menu.optionText,
      ...skipChangeDetection,
    }, context, undefined, appApprovalArgs);
    return {
      content: [{
        type: 'text',
        text: [
          resolved.isError
            ? `Could not select option "${menu.optionText}" on [${elementIndex}] (resolved from requested "${value}").`
            : `✅ Selected option "${menu.optionText}" on [${elementIndex}] (resolved from requested "${value}"). Reread app state to verify the visible selection.`,
          'Resolved set_value result:',
          boundSelectOptionEvidence(textFromToolResponse(resolved)),
          'Initial direct set_value result:',
          boundSelectOptionEvidence(textFromToolResponse(direct)),
          ...closeEvidence,
        ].join('\n'),
      }],
      isError: resolved.isError,
    };
  }

  if (toolName === 'scroll') {
    return callCuaDriverCli('scroll', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: args.element_index === undefined ? undefined : Number(args.element_index),
      direction: args.direction,
      amount: typeof args.pages === 'number' ? Math.min(COMPUTER_USE_SCROLL_MAX_PAGES, Math.max(1, Math.round(args.pages))) : 1,
      ...(args.skip_change_detection === true ? { skip_change_detection: true } : {}),
    }, context, undefined, appApprovalArgs);
  }

  if (toolName === 'perform_secondary_action') {
    if (args.element_index === undefined) throw new Error('Missing required field element_index.');
    const action = typeof args.action === 'string' ? args.action : '';
    const mapped = action === 'AXShowMenu' || action === 'Show Menu' ? 'show_menu' : 'press';
    return callCuaDriverCli('click', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: Number(args.element_index),
      action: mapped,
    }, context, undefined, appApprovalArgs);
  }

  throw new Error(`Unsupported Computer Use tool: ${toolName}`);
}

async function callWindowsComputerUseTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
): Promise<ToolCallResponse> {
  if (toolName === 'list_apps') {
    const response = await callCuaDriverCli('list_apps', {}, context);
    if (response.isError) return response;
    return formatWindowsComputerUseApps(response);
  }

  if (toolName === 'list_windows') {
    return enrichListWindowsResponseWithTargetIdentity(
      await callCuaDriverCli('list_windows', args, context),
    );
  }

  if (toolName === 'launch_app') {
    return callCuaDriverCli('launch_app', args, context);
  }

  if (toolName === 'set_window_bounds') {
    const { pid, windowId } = requireWindowTargetIdentityForBounds(args);
    const x = typeof args.x === 'number' ? args.x : null;
    const y = typeof args.y === 'number' ? args.y : null;
    const width = typeof args.width === 'number' ? args.width : null;
    const height = typeof args.height === 'number' ? args.height : null;
    if (x === null) throw new Error('Missing required number field x.');
    if (y === null) throw new Error('Missing required number field y.');
    if (width === null) throw new Error('Missing required number field width.');
    if (height === null) throw new Error('Missing required number field height.');
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli('set_window_bounds', {
      pid,
      window_id: windowId,
      x,
      y,
      width,
      height,
    }, context);
  }

  if (toolName === 'focus_window') {
    const { pid, windowId } = requireWindowTargetIdentityForFocus(args);
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli('focus_window', {
      pid,
      window_id: windowId,
    }, context);
  }

  if (toolName === 'close_window') {
    const { pid, windowId } = requireWindowTargetIdentityForClose(args);
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli('close_window', {
      pid,
      window_id: windowId,
    }, context);
  }

  if (toolName === 'minimize_window' || toolName === 'restore_window' || toolName === 'maximize_window') {
    const { pid, windowId } = requireWindowTargetIdentity(args, toolName.replace('_window', ''));
    assertNotProtectedDesktopPid(pid);
    return callCuaDriverCli(toolName, {
      pid,
      window_id: windowId,
    }, context);
  }

  const app = requireAppArg(args);

  if (toolName === 'get_app_state') {
    const target = optionalComputerUseTargetFromIdentity(app, args) ?? await resolveWindowsComputerUseTarget(app, context);
    assertNotProtectedDesktopPid(target.pid);
    await assertNativeBrowserReadAllowed(`${app} ${target.app}`);
    const stateResponse = await callCuaDriverCli('get_window_state', {
      pid: target.pid,
      window_id: target.windowId,
    }, context);
    if (stateResponse.isError) return stateResponse;
    const parsed = unwrapWindowsToolData(stateResponse) as WindowsCuaWindowState;
    const observedTarget = {
      ...target,
      title: parsed.title ?? target.title,
      focusedElementIndex: focusedElementIndexFromTreeMarkdown(parsed.tree_markdown),
      bounds: normalizedWindowBounds(parsed.bounds) ?? target.bounds,
    };
    cacheComputerUseTarget(app, observedTarget, context);
    const screenshotResponse = await callCuaDriverCli('screenshot', {
      pid: observedTarget.pid,
      window_id: observedTarget.windowId,
    }, context);
    let screenshotBase64: string | undefined;
    if (!screenshotResponse.isError) {
      const screenshotData = unwrapWindowsToolData(screenshotResponse) as { screenshot_png_b64?: unknown; png_base64?: unknown };
      screenshotBase64 = typeof screenshotData.screenshot_png_b64 === 'string'
        ? screenshotData.screenshot_png_b64
        : typeof screenshotData.png_base64 === 'string'
          ? screenshotData.png_base64
          : undefined;
    }
    return formatWindowsComputerUseState(stateResponse, observedTarget, parsed, screenshotBase64);
  }

  if (toolName === 'get_ui_elements') {
    const region = requireOptionalUiRegion(args);
    const target = optionalComputerUseTargetFromIdentity(app, args) ?? await resolveWindowsComputerUseTarget(app, context);
    assertNotProtectedDesktopPid(target.pid);
    await assertNativeBrowserReadAllowed(`${app} ${target.app}`);
    const stateResponse = await callCuaDriverCli('get_window_state', {
      pid: target.pid,
      window_id: target.windowId,
    }, context);
    if (stateResponse.isError) return stateResponse;
    const parsed = unwrapWindowsToolData(stateResponse) as WindowsCuaWindowState;
    const observedTarget = {
      ...target,
      title: parsed.title ?? target.title,
      focusedElementIndex: focusedElementIndexFromTreeMarkdown(parsed.tree_markdown),
      bounds: normalizedWindowBounds(parsed.bounds) ?? target.bounds,
    };
    cacheComputerUseTarget(app, observedTarget, context);
    return formatComputerUseUiElements(observedTarget, parsed, region);
  }

  const target = optionalComputerUseTargetFromIdentity(app, args) ?? requireCachedComputerUseTarget(app, context);
  if (toolName === 'click') {
    if (args.mouse_button === 'middle') throw new Error('middle mouse button is not supported.');
    const elementIndex = args.element_index;
    if (typeof elementIndex === 'string' || typeof elementIndex === 'number') {
      if (args.mouse_button === 'right') {
        return callCuaDriverCli('right_click', {
          pid: target.pid,
          window_id: target.windowId,
          element_index: Number(elementIndex),
        }, context);
      }
      const count = typeof args.click_count === 'number' ? Math.max(1, Math.round(args.click_count)) : 1;
      return callCuaDriverCli(count > 1 ? 'double_click' : 'click', {
        pid: target.pid,
        window_id: target.windowId,
        element_index: Number(elementIndex),
      }, context);
    }
    const point = screenshotCoordinateToScreenCoordinate(target, args.x, args.y);
    if (point) {
      return callCuaDriverCli('click', {
        pid: target.pid,
        window_id: target.windowId,
        x: point.x,
        y: point.y,
      }, context);
    }
    throw new Error('click requires element_index or x/y.');
  }

  if (toolName === 'drag') {
    const from = requireScreenshotCoordinate(target, args.from_x, args.from_y, 'from');
    const to = requireScreenshotCoordinate(target, args.to_x, args.to_y, 'to');
    return callCuaDriverCli('drag', {
      pid: target.pid,
      window_id: target.windowId,
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
    }, context);
  }

  if (toolName === 'press_key') {
    if (typeof args.key !== 'string' || !args.key.trim()) throw new Error('Missing required string field key.');
    const key = args.key.trim();
    return callCuaDriverCli(key.includes('+') ? 'hotkey' : 'press_key', {
      pid: target.pid,
      window_id: target.windowId,
      key,
    }, context);
  }

  if (toolName === 'type_text') {
    if (typeof args.text !== 'string') throw new Error('Missing required string field text.');
    const elementIndex = optionalElementIndex(args);
    const typeArgs: Record<string, unknown> = {
      pid: target.pid,
      window_id: target.windowId,
      text: args.text,
    };
    if (elementIndex !== null) {
      typeArgs.element_index = elementIndex;
    }
    return callCuaDriverCli('type_text_chars', typeArgs, context);
  }

  if (toolName === 'set_value') {
    if (args.element_index === undefined) throw new Error('Missing required field element_index.');
    if (typeof args.value !== 'string') throw new Error('Missing required string field value.');
    return callCuaDriverCli('set_value', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: Number(args.element_index),
      value: args.value,
    }, context);
  }

  if (toolName === 'select_option') {
    if (args.element_index === undefined) throw new Error('Missing required field element_index.');
    if (typeof args.option !== 'string' || !args.option.trim()) throw new Error('Missing required string field option.');
    return callCuaDriverCli('set_value', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: Number(args.element_index),
      value: args.option.trim(),
    }, context);
  }

  if (toolName === 'scroll') {
    if (typeof args.direction !== 'string') throw new Error('Missing required string field direction.');
    return callCuaDriverCli('scroll', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: args.element_index === undefined ? undefined : Number(args.element_index),
      direction: args.direction,
      amount: typeof args.pages === 'number' ? Math.min(COMPUTER_USE_SCROLL_MAX_PAGES, Math.max(1, Math.round(args.pages))) : 1,
    }, context);
  }

  if (toolName === 'perform_secondary_action') {
    if (args.element_index === undefined) throw new Error('Missing required field element_index.');
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    return callCuaDriverCli(action === 'AXShowMenu' || action === 'Show Menu' ? 'right_click' : 'click', {
      pid: target.pid,
      window_id: target.windowId,
      element_index: Number(args.element_index),
    }, context);
  }

  throw new Error(`Unsupported Computer Use tool: ${toolName}`);
}

async function callComputerUseTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
): Promise<ToolCallResponse> {
  if (process.platform === 'darwin') {
    return callMacComputerUseTool(toolName, args, context);
  }
  if (process.platform === 'win32') {
    return callWindowsComputerUseTool(toolName, args, context);
  }
  return {
    content: [{ type: 'text', text: `Computer Use is not supported on ${process.platform}.` }],
    isError: true,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function macAppBundlePathForExecutable(executablePath: string): string {
  let current = executablePath;
  while (current && current !== path.dirname(current)) {
    if (current.toLowerCase().endsWith('.app')) {
      return current;
    }
    current = path.dirname(current);
  }
  return executablePath;
}

function displayNameFromAppPath(candidate: string): string | null {
  const withoutPid = candidate.trim().replace(/\s*\(pid\s+\d+\)\s*$/i, '').trim();
  if (!withoutPid) return null;

  const appPath = process.platform === 'darwin'
    ? macAppBundlePathForExecutable(withoutPid)
    : withoutPid;
  const basename = path.basename(appPath).trim();
  if (!basename) return null;

  const withoutExtension = basename.toLowerCase().endsWith('.app')
    ? basename.slice(0, -4).trim()
    : basename;
  return withoutExtension || null;
}

function displayNameFromTarget(target: string): string {
  const name = displayNameFromAppPath(target);
  return name ?? target;
}

function approvalIconPathFromCandidate(candidate: string | null): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  const iconPath = process.platform === 'darwin'
    ? macAppBundlePathForExecutable(trimmed)
    : trimmed;
  return fs.existsSync(iconPath) ? iconPath : null;
}

async function getAppIconDataUrl(iconPath: string | null): Promise<string | null> {
  if (!iconPath) return null;
  const cached = appIconDataUrlCache.get(iconPath);
  if (cached !== undefined) return cached;

  let dataUrl: string | null = null;
  try {
    const icon = await thumbnailService.getFileIcon(iconPath);
    dataUrl = icon?.startsWith('data:image/') ? icon : null;
  } catch {
    dataUrl = null;
  }
  appIconDataUrlCache.set(iconPath, dataUrl);
  return dataUrl;
}

async function windowsProcessExecutablePath(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '$ErrorActionPreference = "Stop"; $p = Get-Process -Id ([int]$args[0]); if ($p.Path) { [Console]::Out.Write($p.Path) }',
      String(pid),
    ], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function macProcessExecutablePath(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function approvalAppIconSourcePath(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (toolName === 'launch_app') {
    return approvalIconPathFromCandidate(
      stringArg(args, 'path')
      ?? stringArg(args, 'executable')
      ?? stringArg(args, 'app'),
    );
  }

  const pid = integerArg(args, 'pid');
  if (pid !== null) {
    const processPath = process.platform === 'win32'
      ? await windowsProcessExecutablePath(pid)
      : await macProcessExecutablePath(pid);
    return approvalIconPathFromCandidate(processPath);
  }

  return approvalIconPathFromCandidate(stringArg(args, 'app'));
}

async function withApprovalAppIcon(
  approvalContext: Record<string, unknown>,
  toolName: string,
  toolArgs: Record<string, unknown>,
  target: string,
): Promise<Record<string, unknown>> {
  const iconPath = await approvalAppIconSourcePath(toolName, toolArgs);
  const appIconDataUrl = await getAppIconDataUrl(iconPath);
  if (!appIconDataUrl) {
    return approvalContext;
  }
  return {
    ...approvalContext,
    appIconDataUrl,
    appIconLabel: target,
  };
}

type MacActivityKind = 'typing' | 'key' | 'hotkey';

type MacWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function macCuaDriverActivityExecOptions(): {
  maxBuffer: number;
  timeout: number;
} {
  return {
    maxBuffer: MAC_CUA_DRIVER_ACTIVITY_MAX_BUFFER,
    timeout: MAC_CUA_DRIVER_ACTIVITY_TIMEOUT_MS,
  };
}

export function macCuaDriverActivityExecOptionsForTest(): {
  maxBuffer: number;
  timeout: number;
} {
  return macCuaDriverActivityExecOptions();
}

type MacAgentActivityState = {
  activity_idle_hide_ms: number;
  activity_kind: MacActivityKind | null;
  activity_text: string | null;
  enabled: boolean;
  last_activity_at: number | null;
  overlay_pid: number | null;
  rendered: boolean;
  supported: boolean;
  target_rect: MacWindowRect | null;
};

function macAgentActivityStatePath(): string {
  return path.join(os.tmpdir(), 'interpreter-desktop-driver-macos-activity.json');
}

function defaultMacAgentActivityState(): MacAgentActivityState {
  return {
    activity_idle_hide_ms: AGENT_ACTIVITY_IDLE_HIDE_MS,
    activity_kind: null,
    activity_text: null,
    enabled: true,
    last_activity_at: null,
    overlay_pid: null,
    rendered: false,
    supported: true,
    target_rect: null,
  };
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readMacAgentActivityState(): MacAgentActivityState {
  const statePath = macAgentActivityStatePath();
  if (!fs.existsSync(statePath)) return defaultMacAgentActivityState();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<MacAgentActivityState>;
    return {
      ...defaultMacAgentActivityState(),
      ...parsed,
      activity_idle_hide_ms: typeof parsed.activity_idle_hide_ms === 'number'
        ? parsed.activity_idle_hide_ms
        : AGENT_ACTIVITY_IDLE_HIDE_MS,
      enabled: parsed.enabled !== false,
      overlay_pid: typeof parsed.overlay_pid === 'number' ? parsed.overlay_pid : null,
      rendered: parsed.rendered === true,
      supported: true,
      target_rect: isMacWindowRect(parsed.target_rect) ? parsed.target_rect : null,
    };
  } catch {
    return defaultMacAgentActivityState();
  }
}

function writeMacAgentActivityState(state: MacAgentActivityState): void {
  fs.writeFileSync(macAgentActivityStatePath(), JSON.stringify(state), 'utf8');
}

function isMacWindowRect(value: unknown): value is MacWindowRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) => (
    typeof rect[key] === 'number' && Number.isFinite(rect[key])
  ));
}

async function ensureMacAgentActivityOverlay(): Promise<MacAgentActivityState> {
  if (process.platform !== 'darwin') return defaultMacAgentActivityState();

  const existingState = readMacAgentActivityState();
  const trackedPid = macAgentActivityOverlayProcess?.pid ?? null;
  if (
    macAgentActivityOverlayProcess
    && !macAgentActivityOverlayProcess.killed
    && isProcessAlive(trackedPid)
  ) {
    const state = {
      ...existingState,
      enabled: true,
      overlay_pid: trackedPid,
      rendered: true,
      supported: true,
    };
    writeMacAgentActivityState(state);
    return state;
  }

  if (isProcessAlive(existingState.overlay_pid)) {
    const state = {
      ...existingState,
      enabled: true,
      rendered: true,
      supported: true,
    };
    writeMacAgentActivityState(state);
    return state;
  }

  const scriptPath = resolveMacAgentActivityOverlayScript();
  const child = spawn('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    scriptPath,
    macAgentActivityStatePath(),
  ], {
    stdio: 'ignore',
  });
  macAgentActivityOverlayProcess = child;
  child.unref();
  child.on('exit', () => {
    if (macAgentActivityOverlayProcess === child) {
      macAgentActivityOverlayProcess = null;
    }
  });
  const state = {
    ...existingState,
    enabled: true,
    overlay_pid: child.pid ?? null,
    rendered: typeof child.pid === 'number',
    supported: true,
  };
  writeMacAgentActivityState(state);
  return state;
}

function normalizeMacActivityText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((part) => typeof part === 'string' ? part.trim() : '')
      .filter(Boolean)
      .join('+');
    return text || null;
  }
  return null;
}

export function macAgentActivityForTool(
  toolName: string,
  args: Record<string, unknown>,
): { kind: MacActivityKind; text: string } | null {
  if (toolName === 'set_value') {
    const text = normalizeMacActivityText(args.value);
    return text ? { kind: 'typing', text } : null;
  }
  if (toolName === 'type_text' || toolName === 'type_text_chars') {
    const text = normalizeMacActivityText(args.text);
    return text ? { kind: 'typing', text } : null;
  }
  if (toolName === 'press_key') {
    const text = normalizeMacActivityText(args.key)
      ?? normalizeMacActivityText(args.combo)
      ?? normalizeMacActivityText(args.keys);
    return text ? { kind: 'key', text } : null;
  }
  if (toolName === 'hotkey') {
    const text = normalizeMacActivityText(args.keys)
      ?? normalizeMacActivityText(args.hotkey)
      ?? normalizeMacActivityText(args.combo)
      ?? normalizeMacActivityText(args.key);
    return text ? { kind: 'hotkey', text } : null;
  }
  return null;
}

function disableMacAgentActivityOverlay(): void {
  if (process.platform !== 'darwin') return;
  const state = readMacAgentActivityState();
  if (isProcessAlive(state.overlay_pid)) {
    try {
      process.kill(state.overlay_pid as number);
    } catch {}
  }
  macAgentActivityOverlayProcess = null;
  writeMacAgentActivityState({
    ...state,
    activity_kind: null,
    activity_text: null,
    enabled: false,
    last_activity_at: null,
    overlay_pid: null,
    rendered: false,
    supported: true,
  });
}

function toolResponseText(response: ToolCallResponse): string {
  return (response.content ?? [])
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n');
}

function parseWindowsToolEnvelope(text: string): { ok?: boolean; data?: unknown } | null {
  const jsonLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('{'));
  if (!jsonLine) return null;
  try {
    return JSON.parse(jsonLine) as { ok?: boolean; data?: unknown };
  } catch {
    return null;
  }
}

function booleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function displayNameForLaunchTarget(args: Record<string, unknown>): string {
  const rawTarget = typeof args.path === 'string'
    ? args.path
    : typeof args.app === 'string'
      ? args.app
      : typeof args.executable === 'string'
        ? args.executable
        : 'an app';
  const basename = path.basename(rawTarget).replace(/\.(exe|lnk)$/i, '') || rawTarget;
  return basename === 'calc' ? 'Calculator' : basename;
}

function windowsDiscoveryApprovalCopy(toolName: string): { message: string; warning: string } {
  switch (toolName) {
    case 'list_apps':
    case 'list_windows':
      return {
        message: 'Let Interpreter list your running apps and windows?',
        warning: 'Interpreter can see app names, window titles, and which window is currently active.',
      };
    case 'list_automation_targets':
      return {
        message: 'Let Interpreter inspect available Windows automation targets?',
        warning: 'Interpreter can see open windows and which automation methods each one supports.',
      };
    case 'list_com_objects':
      return {
        message: 'Let Interpreter list Windows COM automation objects?',
        warning: 'Interpreter will read registered automation object names from the Windows registry. It will not open or control apps.',
      };
    case 'check_permissions':
      return {
        message: 'Let Interpreter check desktop automation permissions?',
        warning: 'Interpreter will check whether Windows automation is available for this session.',
      };
    case 'get_screen_size':
      return {
        message: 'Let Interpreter read your screen size?',
        warning: 'Interpreter will only read display dimensions.',
      };
    case 'get_cursor_position':
      return {
        message: 'Let Interpreter read the mouse position?',
        warning: 'Interpreter will only read the current cursor coordinates.',
      };
    default:
      return {
        message: 'Let Interpreter inspect desktop automation status?',
        warning: 'Interpreter will read automation status for this session.',
      };
  }
}

function quoteApprovalTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed || trimmed === 'the requested app or window') {
    return 'the requested app';
  }
  return `"${trimmed}"`;
}

function windowsAccessApprovalCopy(kind: 'inspect' | 'control', target: string): { message: string; warning: string } {
  const quotedTarget = quoteApprovalTarget(target);
  if (kind === 'inspect') {
    return {
      message: `Let Interpreter inspect ${quotedTarget}?`,
      warning: 'Interpreter can read visible text, controls, and window structure from that app.',
    };
  }

  return {
    message: `Let Interpreter control ${quotedTarget}?`,
    warning: 'Interpreter may click, type, or change state in that app.',
  };
}

async function describeWindowsCuaTarget(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (toolName === 'launch_app') {
    return displayNameForLaunchTarget(args);
  }
  if (toolName === 'com_automation') {
    const progId = typeof args.progid === 'string' && args.progid.trim()
      ? args.progid.trim()
      : 'a COM Automation object';
    return progId;
  }

  const pid = integerArg(args, 'pid');
  if (pid === null) {
    return 'the requested app or window';
  }

  const requestedWindowId = typeof args.window_id === 'string' ? args.window_id : null;
  try {
    const windowsResponse = await windowsCuaDriverToolProvider('list_windows', {});
    const envelope = parseWindowsToolEnvelope(toolResponseText(windowsResponse));
    const windows = Array.isArray(envelope?.data) ? envelope.data as Array<Record<string, unknown>> : [];
    const match = windows.find((window) => (
      requestedWindowId !== null && window.window_id === requestedWindowId
    )) ?? windows.find((window) => window.pid === pid);
    const appName = typeof match?.app_name === 'string' ? match.app_name.trim() : '';
    if (appName) return appName;
    const title = typeof match?.title === 'string' ? match.title.trim() : '';
    if (title) return title;
  } catch {}

  return 'the requested app or window';
}

async function getWindowsWindowFocus(
  args: Record<string, unknown>,
): Promise<{ isFocused: boolean; target: string }> {
  const requestedWindowId = typeof args.window_id === 'string' ? args.window_id : null;
  const pid = integerArg(args, 'pid');
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const windowsResponse = await windowsCuaDriverToolProvider('list_windows', {});
  const envelope = parseWindowsToolEnvelope(toolResponseText(windowsResponse));
  const windows = Array.isArray(envelope?.data) ? envelope.data as Array<Record<string, unknown>> : [];
  const match = windows.find((window) => (
    requestedWindowId !== null && window.window_id === requestedWindowId
  )) ?? windows.find((window) => (
    pid !== null && window.pid === pid
  )) ?? windows.find((window) => (
    title.length > 0
    && typeof window.title === 'string'
    && window.title.includes(title)
  ));
  if (!match) {
    return { isFocused: false, target: await describeWindowsCuaTarget('click', args) };
  }
  const windowTitle = typeof match.title === 'string' && match.title.trim()
    ? match.title.trim()
    : await describeWindowsCuaTarget('click', args);
  return { isFocused: match.is_focused === true, target: windowTitle };
}

async function requestWindowsForegroundApprovalForPointerIfNeeded(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
): Promise<boolean> {
  const mayNeedForeground = toolName === 'drag' || (toolName === 'click' && booleanArg(args, 'bring_to_foreground'));
  if (process.platform !== 'win32' || !mayNeedForeground) {
    return false;
  }

  const { isFocused, target } = await getWindowsWindowFocus(args);
  if (isFocused) {
    return false;
  }

  const quotedTarget = quoteApprovalTarget(target);
  const action = toolName === 'drag' ? 'drag' : 'click';
  const message = `Let Interpreter bring ${quotedTarget} forward and ${action}?`;
  const approvalContext = await withApprovalAppIcon(
    {
      toolName,
      target,
      message,
      warning: `Interpreter will foreground the app and send a normal mouse ${action}.`,
      recommendation: 'If you do not allow this, the agent should use a background-safe method such as press_key, type_text, set_value, or click without bring_to_foreground.',
    },
    toolName,
    args,
    target,
  );
  const approved = await approvalManager.createApproval(
    `cua_driver:foreground:${target}`,
    SERVER_ID,
    approvalContext,
    0,
    context?.toolCallId,
    approvalAgentId(context),
  );
  if (!approved) {
    throw new Error(
      `User denied bringing "${target}" to the foreground. The ${action} was not sent. `
      + 'Try another method: call get_app_state again, use press_key/type_text/set_value when available, or retry click without bring_to_foreground.',
    );
  }
  return true;
}

function macToolMayRequireForegroundFocus(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'click') {
    return args.action === 'mouse' || (typeof args.x === 'number' && typeof args.y === 'number');
  }
  return toolName === 'double_click' || toolName === 'right_click' || toolName === 'drag';
}

export function macToolMayRequireForegroundFocusForTest(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  return macToolMayRequireForegroundFocus(toolName, args);
}

async function requestMacForegroundApprovalIfNeeded(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
): Promise<void> {
  if (process.platform !== 'darwin' || !macToolMayRequireForegroundFocus(toolName, args)) {
    return;
  }

  const pid = integerArg(args, 'pid');
  const target = pid !== null ? await describePidTarget(pid) : 'the requested app';
  const quotedTarget = quoteApprovalTarget(target);
  const message = `Let Interpreter bring ${quotedTarget} forward if required?`;
  const approvalContext = await withApprovalAppIcon(
    {
      toolName,
      target,
      message,
      warning: 'Interpreter may need to focus or bring the app forward to send a native mouse action.',
      recommendation: 'If you do not allow this, the agent should use background-safe actions such as AXPress element clicks, set_value, type_text, or press_key with a focused element.',
    },
    toolName,
    args,
    target,
  );
  const approved = await approvalManager.createApproval(
    `cua_driver:foreground:${target}`,
    SERVER_ID,
    approvalContext,
    0,
    context?.toolCallId,
    approvalAgentId(context),
  );
  if (!approved) {
    throw new Error(
      `User denied bringing ${quotedTarget} forward. The native action was not sent. `
      + 'Use a background-safe method such as AXPress element clicks, set_value, type_text, or press_key with a focused element.',
    );
  }
}

async function describePidTarget(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    const command = stdout.trim();
    if (command) return displayNameFromAppPath(command) ?? `pid ${pid}`;
  } catch {
    // Use pid-only target below.
  }
  return `pid ${pid}`;
}

function resetDaemonProcess(child: ChildProcess): void {
  if (daemonProcess === child) {
    daemonProcess = null;
    daemonStartPromise = null;
    daemonCursorConfigured = false;
  }
}

function stopChildProcess(child: ChildProcess | null, label: string): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (!exited) {
        console.warn(`[CuaDriver] force-killing ${label} process`, { pid: child.pid });
        child.kill('SIGKILL');
      }
      finish();
    }, 1000);
    forceTimer.unref();
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

export async function shutdownCuaDriverProcesses(): Promise<void> {
  const daemon = daemonProcess;
  const activityOverlay = macAgentActivityOverlayProcess;
  daemonProcess = null;
  daemonStartPromise = null;
  daemonCursorConfigured = false;
  macAgentActivityOverlayProcess = null;
  await Promise.all([
    stopChildProcess(daemon, 'daemon'),
    stopChildProcess(activityOverlay, 'activity overlay'),
  ]);
}

type CuaDriverServeStartupState = 'pending' | 'started' | 'already-running';

export function classifyCuaDriverServeStartupOutputForTest(output: string): CuaDriverServeStartupState {
  return classifyCuaDriverServeStartupOutput(output);
}

function classifyCuaDriverServeStartupOutput(output: string): CuaDriverServeStartupState {
  if (output.includes('daemon is already running')) return 'already-running';
  if (output.includes('daemon listening on')) return 'started';
  return 'pending';
}

type MacComputerUsePermissionStatus = {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  screenRecordingStatus?: string;
};

function hasMacComputerUsePermissions(status: MacComputerUsePermissionStatus | null): boolean {
  return Boolean(status?.accessibilityGranted && status.screenRecordingGranted);
}

function isElectronMainProcess(): boolean {
  return Boolean(process.versions.electron && (process as NodeJS.Process & { type?: string }).type === 'browser');
}

function macPermissionStatusResponse(status: MacComputerUsePermissionStatus | null): ToolCallResponse {
  const accessibility = status?.accessibilityGranted ? 'granted' : 'not granted';
  const screenRecording = status?.screenRecordingGranted ? 'granted' : 'not granted';
  const screenRecordingStatus = status?.screenRecordingStatus
    ? ` (${status.screenRecordingStatus})`
    : '';
  return {
    content: [{
      type: 'text',
      text: [
        `Accessibility: ${accessibility}`,
        `Screen Recording: ${screenRecording}${screenRecordingStatus}`,
      ].join('\n'),
    }],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let macCuaDriverCallChain: Promise<void> = Promise.resolve();

async function withMacCuaDriverSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = macCuaDriverCallChain.then(fn, fn);
  macCuaDriverCallChain = run.then(() => undefined, () => undefined);
  return run;
}

async function acquireMacCuaDriverProcessLock(lockDir = MAC_CUA_DRIVER_CALL_LOCK_DIR): Promise<() => void> {
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(path.join(lockDir, 'owner'), JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
        }));
      } catch {
        // The directory itself is the atomic lock; owner metadata is best-effort.
      }
      return () => {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Nothing actionable for a best-effort unlock during process teardown.
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }
      if (macCuaDriverProcessLockIsStale(lockDir)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      throw new Error(MAC_CUA_DRIVER_CALL_BUSY_MESSAGE);
    }
  }
}

function macCuaDriverProcessLockIsStale(lockDir: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ESRCH') {
          return true;
        }
      }
    }
  } catch {
    // Fall through to age-based stale detection for old or corrupt lock dirs.
  }

  try {
    const stat = fs.statSync(lockDir);
    return Date.now() - stat.mtimeMs > MAC_CUA_DRIVER_CALL_LOCK_STALE_MS;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function withMacCuaDriverProcessLockForTest<T>(
  lockDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireMacCuaDriverProcessLock(lockDir);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function withMacCuaDriverProcessLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireMacCuaDriverProcessLock();
  try {
    return await fn();
  } finally {
    release();
  }
}

async function getMacComputerUsePermissionStatus(): Promise<MacComputerUsePermissionStatus | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  if (!isElectronMainProcess()) {
    const binary = resolveCuaDriverBinary();
    const { stdout } = await execFileAsync(binary, [
      'call',
      'check_permissions',
      JSON.stringify({ prompt: false }),
      '--no-daemon',
    ], {
      maxBuffer: 1024 * 1024,
    });
    // The Rust driver emits the check_permissions structured JSON payload:
    // { "accessibility": bool, "screen_recording": bool, ... }
    const parsed = JSON.parse(stdout) as { accessibility?: unknown; screen_recording?: unknown };
    return {
      accessibilityGranted: parsed.accessibility === true,
      screenRecordingGranted: parsed.screen_recording === true,
      screenRecordingStatus: undefined,
    };
  }

  const { getInterpreterOverlayPermissionStatus } = await import('../../../handlers/settings');
  const response = await getInterpreterOverlayPermissionStatus();
  return response.status;
}

async function requestComputerUseSetupModal(): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  const [{ emitEvent }, { IPC_CHANNELS }] = await Promise.all([
    import('../../../utils/ipcBridge'),
    import('../../../../electron/ipc/registry'),
  ]);
  console.log('[Computer Use Setup] requesting setup modal');
  emitEvent(IPC_CHANNELS.COMPUTER_USE_SETUP_REQUESTED, { reason: 'desktop-tool' });
}

async function ensureMacComputerUsePermissionsBeforeDaemon(): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  const initialStatus = await getMacComputerUsePermissionStatus();
  console.log('[Computer Use Setup] initial permission status', initialStatus);
  if (hasMacComputerUsePermissions(initialStatus)) {
    return;
  }

  await requestComputerUseSetupModal();
  await waitForComputerUseSetupReady(8 * 60 * 1000);
  console.log('[Computer Use Setup] renderer reported permissions ready');

  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await getMacComputerUsePermissionStatus();
    if (hasMacComputerUsePermissions(status)) {
      console.log('[Computer Use Setup] permissions granted');
      return;
    }
    await wait(1000);
  }

  throw new Error(
    'Interpreter needs Accessibility and Screen Recording permission before Computer Use can start. '
    + 'Open Computer Use Setup in Interpreter and grant both macOS permissions.',
  );
}

async function ensureCuaDriverDaemon(binary: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (daemonProcess && !daemonProcess.killed) {
    await waitForCuaDriverDaemon(binary);
    await configureCuaDriverDaemon(binary);
    return;
  }
  if (daemonStartPromise) {
    await daemonStartPromise;
    await waitForCuaDriverDaemon(binary);
    await configureCuaDriverDaemon(binary);
    return;
  }

  daemonStartPromise = new Promise<void>((resolve, reject) => {
    // Embedded mode: the Rust driver runs as a direct child of the app,
    // inherits the app's TCC grants, and never disclaims, relaunches through
    // a CuaDriver.app bundle, or prompts on its own.
    const child = spawn(binary, ['serve', '--embedded', '--socket', macCuaDriverSocketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemonProcess = child;

    let settled = false;
    let output = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        resetDaemonProcess(child);
        reject(error);
        return;
      }
      resolve();
    };
    const timer = setTimeout(() => finish(), 1200);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (classifyCuaDriverServeStartupOutput(output) !== 'pending') finish();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      if (classifyCuaDriverServeStartupOutput(output) !== 'pending') finish();
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => {
      resetDaemonProcess(child);
      if (!settled && code !== 0) {
        if (classifyCuaDriverServeStartupOutput(output) !== 'pending') {
          finish();
          return;
        }
        finish(new Error(`Computer Use daemon exited during startup (code=${code}, signal=${signal ?? 'none'}): ${output.trim()}`));
        return;
      }
      if (!settled) finish();
    });
    process.once('exit', () => {
      if (!child.killed) child.kill();
    });
  });

  await daemonStartPromise;
  await waitForCuaDriverDaemon(binary);
  await configureCuaDriverDaemon(binary);
}

async function waitForCuaDriverDaemon(binary: string): Promise<void> {
  const deadline = Date.now() + MAC_CUA_DRIVER_DAEMON_STARTUP_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await execFileAsync(binary, ['status', '--socket', macCuaDriverSocketPath], { maxBuffer: 1024 * 1024 });
      return;
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      lastError = [err.stdout?.trim(), err.stderr?.trim(), err.message]
        .filter(Boolean)
        .join('\n');
      await wait(100);
    }
  }
  throw new Error(`Computer Use daemon did not become reachable within ${Math.round(MAC_CUA_DRIVER_DAEMON_STARTUP_TIMEOUT_MS / 1000)}s.${lastError ? ` Last status: ${lastError}` : ''}`);
}

async function configureCuaDriverDaemon(binary: string): Promise<void> {
  if (daemonCursorConfigured) return;
  // The agent cursor and the mac activity pill are off by default, always.
  // Explicitly disable on daemon startup so stale daemon state or a leftover
  // overlay process from an earlier run cannot keep fake visuals on screen.
  // Only an explicit set_agent_cursor_enabled tool call may turn them on.
  await execFileAsync(binary, [
    'call',
    'set_agent_cursor_enabled',
    JSON.stringify({ enabled: false }),
    '--socket',
    macCuaDriverSocketPath,
  ], {
    maxBuffer: 1024 * 1024,
  });
  disableMacAgentActivityOverlay();
  daemonCursorConfigured = true;
}

async function requestApproval(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
): Promise<void> {
  if (process.platform === 'darwin' && toolName === 'check_permissions') {
    return;
  }

  if (DISCOVERY_TOOLS.has(toolName)) {
    const copy = process.platform === 'win32'
      ? windowsDiscoveryApprovalCopy(toolName)
      : {
          message: 'Let Interpreter list your running apps and windows?',
          warning: 'Interpreter can see app names, window titles, and which window is currently active.',
        };
    const approval = await approvalManager.createSessionAwareApproval(
      process.platform === 'win32' ? `cua_driver:discover:${toolName}` : 'cua_driver:discover_apps',
      SERVER_ID,
      { toolName, message: copy.message },
      copy.warning,
      0,
      context?.toolCallId,
      approvalAgentId(context),
    );
    if (!approval.approved) {
      throw new Error(`User denied ${automationBackendName()} app discovery access.`);
    }
    return;
  }

  const pid = integerArg(args, 'pid');
  const target = process.platform === 'win32'
    ? await describeWindowsCuaTarget(toolName, args)
    : pid !== null
      ? await describePidTarget(pid)
      : typeof args.bundle_id === 'string' && args.bundle_id.trim()
        ? args.bundle_id.trim()
        : typeof args.app === 'string' && args.app.trim()
          ? args.app.trim()
        : 'the desktop';
  const displayTarget = displayNameFromTarget(target);
  const comAction = toolName === 'com_automation' && typeof args.action === 'string'
    ? args.action.trim().toLowerCase()
    : '';
  const kind = INSPECT_TOOLS.has(toolName) || (toolName === 'com_automation' && (comAction === 'members' || comAction === 'get'))
    ? 'inspect'
    : 'control';
  const policyMode = resolveCuaAccessPolicyMode(
    await cuaAccessPolicyProvider(),
    displayTarget,
    kind as CuaAccessPermissionKind,
  );
  if (policyMode === 'all') {
    return;
  }
  if (policyMode === 'deny') {
    throw new Error(
      `Computer Use ${kind} access to "${displayTarget}" is denied by Settings > Permissions.`,
    );
  }
  if (kind === 'control' && context?.overlayReviewedAction === true) {
    return;
  }

  const copy = process.platform === 'win32'
    ? windowsAccessApprovalCopy(kind, displayTarget)
    : kind === 'inspect'
      ? {
          message: `Let Interpreter inspect "${displayTarget}"?`,
          warning: 'Interpreter can read visible text, controls, and window structure from that app.',
        }
      : {
          message: `Let Interpreter control "${displayTarget}"?`,
          warning: 'Interpreter may click, type, or change state in that app.',
        };
  const approvalContext = await withApprovalAppIcon(
    { toolName, target: displayTarget, rawTarget: target, app: displayTarget, message: copy.message },
    toolName,
    args,
    displayTarget,
  );
  const approval = await approvalManager.createSessionAwareApproval(
    `cua_driver:${kind}:${displayTarget}`,
    SERVER_ID,
    approvalContext,
    copy.warning,
    0,
    context?.toolCallId,
    approvalAgentId(context),
  );
  if (!approval.approved) {
    throw new Error(`User denied ${automationBackendName()} ${kind} access to "${displayTarget}".`);
  }
}

async function callCuaDriverCli(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
  imageOutputPath?: string,
  approvalArgs?: Record<string, unknown>,
): Promise<ToolCallResponse> {
  assertNotProtectedDesktopAutomationTarget(toolName, args);
  if (process.platform === 'darwin') {
    return withMacCuaDriverProcessLock(() => (
      withMacCuaDriverSerialized(() => callMacCuaDriverCli(toolName, args, context, imageOutputPath, approvalArgs))
    ));
  }
  await requestApproval(toolName, approvalArgs ?? args, context);
  await requestWindowsForegroundApprovalForPointerIfNeeded(toolName, args, context);

  if (process.platform === 'win32') {
    const response = await windowsCuaDriverToolProvider(toolName, args);
    return filterProtectedDesktopTargetsFromResponse(toolName, response);
  }

  return {
    content: [{ type: 'text', text: `${automationBackendName()} is not supported on ${process.platform}.` }],
    isError: true,
  };
}

async function callMacCuaDriverCli(
  toolName: string,
  args: Record<string, unknown>,
  context?: BuiltinToolContext,
  imageOutputPath?: string,
  approvalArgs?: Record<string, unknown>,
): Promise<ToolCallResponse> {
  if (toolName === 'check_permissions' && !booleanArg(args, 'prompt')) {
    return macPermissionStatusResponse(await getMacComputerUsePermissionStatus());
  }
  await ensureMacComputerUsePermissionsBeforeDaemon();
  await requestApproval(toolName, approvalArgs ?? args, context);

  const binary = resolveCuaDriverBinary();
  await ensureCuaDriverDaemon(binary);
  await requestMacForegroundApprovalIfNeeded(toolName, args, context);
  const jsonArgs = JSON.stringify(args ?? {});
  let saveToDiskPath = imageOutputPath;
  let userRequestedSaveToDisk = false;
  if (context?.saveToDiskPath) {
    userRequestedSaveToDisk = true;
    try {
      saveToDiskPath = resolvePathWithWorkspace(context.saveToDiskPath, context.workspace ?? null);
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
    const requesterId = approvalAgentId(context);
    if (requesterId && !checkFileAccessPermission(requesterId, saveToDiskPath, 'write', context.workspace ?? null)) {
      return {
        content: [{
          type: 'text',
          text: getFileAccessDeniedMessage(requesterId, saveToDiskPath, 'write', context.workspace ?? null),
        }],
        isError: true,
      };
    }
    try {
      fs.mkdirSync(path.dirname(saveToDiskPath), { recursive: true });
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        }],
        isError: true,
      };
    }
  }
  try {
    const cliArgs = ['call', toolName, jsonArgs];
    cliArgs.push('--socket', macCuaDriverSocketPath);
    if (saveToDiskPath) {
      cliArgs.push('--screenshot-out-file', saveToDiskPath);
    }
    const { stdout, stderr } = await execFileAsync(binary, cliArgs, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: MAC_CUA_DRIVER_TOOL_TIMEOUT_MS,
    });
    const text = imageOutputPath
      ? stdout.trim()
      : [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    if (toolName === 'set_agent_cursor_enabled' && typeof args.enabled === 'boolean') {
      if (args.enabled) {
        await ensureMacAgentActivityOverlay();
      } else {
        disableMacAgentActivityOverlay();
      }
    }
    const response: ToolCallResponse = {
      content: [{ type: 'text', text }],
    };
    if (saveToDiskPath) {
      if (!fs.existsSync(saveToDiskPath)) {
        if (!userRequestedSaveToDisk) {
          return filterProtectedDesktopTargetsFromResponse(toolName, response);
        }
        return {
          content: [{
            type: 'text',
            text: [text, `Requested image output was not written: ${saveToDiskPath}`].filter(Boolean).join('\n'),
          }],
          isError: true,
        };
      }
      response.savedToPath = saveToDiskPath;
      response.imagePaths = [saveToDiskPath];
    }
    return filterProtectedDesktopTargetsFromResponse(toolName, response);
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const details = [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: details }],
      isError: true,
    };
  }
}

const COMPUTER_USE_TOOL_NAMES = new Set([
  'list_apps',
  'list_windows',
  'launch_app',
  'get_app_state',
  'get_ui_elements',
  'click',
  'drag',
  'press_key',
  'scroll',
  'select_option',
  'set_value',
  'close_window',
  'focus_window',
  'maximize_window',
  'minimize_window',
  'restore_window',
  'set_window_bounds',
  'type_text',
  'perform_secondary_action',
]);

function computerUseToolSchema(name: string): BuiltinToolDefinition['inputSchema'] {
  if (name === 'list_apps') {
    return {
      type: 'object',
      properties: {},
    };
  }
  if (name === 'list_windows') {
    return {
      type: 'object',
      properties: {
        pid: { type: 'number' },
      },
    };
  }
  if (name === 'get_app_state') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        target_identity: { type: 'object' },
      },
      required: ['app'],
    };
  }
  if (name === 'get_ui_elements') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        target_identity: { type: 'object' },
      },
      required: ['app'],
    };
  }
  if (name === 'launch_app') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        name: { type: 'string' },
        bundle_id: { type: 'string' },
        path: { type: 'string' },
        executable: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
        arguments: { type: 'string' },
        additional_arguments: { type: 'array', items: { type: 'string' } },
        window_style: { type: 'string', enum: ['normal', 'minimized', 'maximized', 'hidden'] },
      },
    };
  }
  if (name === 'click') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        click_count: { type: 'number' },
        element_index: { type: 'string' },
        mouse_button: { type: 'string', enum: ['left', 'right', 'middle'] },
        target_identity: { type: 'object' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['app'],
    };
  }
  if (name === 'drag') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        from_x: { type: 'number' },
        from_y: { type: 'number' },
        target_identity: { type: 'object' },
        to_x: { type: 'number' },
        to_y: { type: 'number' },
      },
      required: ['app', 'from_x', 'from_y', 'to_x', 'to_y'],
    };
  }
  if (name === 'press_key') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        key: { type: 'string' },
        target_identity: { type: 'object' },
      },
      required: ['app', 'key'],
    };
  }
  if (name === 'scroll') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        element_index: { type: 'string' },
        pages: { type: 'number', minimum: 1, maximum: COMPUTER_USE_SCROLL_MAX_PAGES },
        target_identity: { type: 'object' },
      },
      required: ['app', 'direction'],
    };
  }
  if (name === 'select_option') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'string' },
        option: { type: 'string' },
        target_identity: { type: 'object' },
      },
      required: ['app', 'element_index', 'option'],
    };
  }
  if (name === 'set_value') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'string' },
        target_identity: { type: 'object' },
        value: { type: 'string' },
      },
      required: ['app', 'element_index', 'value'],
    };
  }
  if (name === 'set_window_bounds') {
    return {
      type: 'object',
      properties: {
        target_identity: {
          type: 'object',
          description: 'The target_identity object returned by list_windows for the window to move.',
          properties: {
            kind: { type: 'string', enum: ['app-window'] },
            app: {
              type: 'object',
              properties: {
                name: { type: ['string', 'null'] },
                pid: { type: 'number' },
              },
              required: ['pid'],
            },
            window: {
              type: 'object',
              properties: {
                native_window_id: { type: ['number', 'string'] },
                title: { type: ['string', 'null'] },
              },
              required: ['native_window_id'],
            },
          },
          required: ['kind', 'app', 'window'],
        },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['target_identity', 'x', 'y', 'width', 'height'],
    };
  }
  if (name === 'focus_window') {
    return {
      type: 'object',
      properties: {
        target_identity: {
          type: 'object',
          description: 'The target_identity object returned by list_windows for the window to focus.',
          properties: {
            kind: { type: 'string', enum: ['app-window'] },
            app: {
              type: 'object',
              properties: {
                name: { type: ['string', 'null'] },
                pid: { type: 'number' },
              },
              required: ['pid'],
            },
            window: {
              type: 'object',
              properties: {
                native_window_id: { type: ['number', 'string'] },
                title: { type: ['string', 'null'] },
              },
              required: ['native_window_id'],
            },
          },
          required: ['kind', 'app', 'window'],
        },
      },
      required: ['target_identity'],
    };
  }
  if (name === 'minimize_window' || name === 'restore_window' || name === 'maximize_window') {
    const action = name.replace('_window', '');
    return {
      type: 'object',
      properties: {
        target_identity: {
          type: 'object',
          description: `The target_identity object returned by list_windows for the window to ${action}.`,
          properties: {
            kind: { type: 'string', enum: ['app-window'] },
            app: {
              type: 'object',
              properties: {
                name: { type: ['string', 'null'] },
                pid: { type: 'number' },
              },
              required: ['pid'],
            },
            window: {
              type: 'object',
              properties: {
                native_window_id: { type: ['number', 'string'] },
                title: { type: ['string', 'null'] },
              },
              required: ['native_window_id'],
            },
          },
          required: ['kind', 'app', 'window'],
        },
      },
      required: ['target_identity'],
    };
  }
  if (name === 'close_window') {
    return {
      type: 'object',
      properties: {
        target_identity: {
          type: 'object',
          description: 'The target_identity object returned by list_windows for the window to close.',
          properties: {
            kind: { type: 'string', enum: ['app-window'] },
            app: {
              type: 'object',
              properties: {
                name: { type: ['string', 'null'] },
                pid: { type: 'number' },
              },
              required: ['pid'],
            },
            window: {
              type: 'object',
              properties: {
                native_window_id: { type: ['number', 'string'] },
                title: { type: ['string', 'null'] },
              },
              required: ['native_window_id'],
            },
          },
          required: ['kind', 'app', 'window'],
        },
      },
      required: ['target_identity'],
    };
  }
  if (name === 'type_text') {
    return {
      type: 'object',
      properties: {
        app: { type: 'string' },
        element_index: { type: 'string' },
        target_identity: { type: 'object' },
        text: { type: 'string' },
      },
      required: ['app', 'text'],
    };
  }
  return {
    type: 'object',
    properties: {
      app: { type: 'string' },
      action: { type: 'string' },
      element_index: { type: 'string' },
      target_identity: { type: 'object' },
    },
    required: ['app', 'action', 'element_index'],
  };
}

function computerUseDescription(name: string): string {
  const descriptions: Record<string, string> = {
    list_apps: 'List the apps on this computer. Returns the set of apps that are currently running, as well as any that have been used in the last 14 days, including details on usage frequency.',
    list_windows: 'List top-level app windows with normalized target_identity objects, titles, and bounds.',
    launch_app: 'Launch an app so it can be targeted by Computer Use.',
    get_app_state: "Start an app use session if needed, then get the state of the app's key window and return a screenshot and accessibility tree. This must be called once per assistant turn before interacting with the app.",
    get_ui_elements: 'Get snapshot-scoped UI element refs and observed screen-point bounding boxes for an app, optionally filtered to a region.',
    click: 'Click an element by index or pixel coordinates from screenshot.',
    drag: 'Drag from one point to another using pixel coordinates.',
    press_key: 'Press a key or key-combination on the keyboard, including modifier and navigation keys.',
    scroll: 'Scroll an element in a direction by a number of pages.',
    select_option: 'Select an option in a dropdown, pop-up button, combo box, or select-like control.',
    set_value: 'Set the value of a settable accessibility element.',
    close_window: 'Request-close a top-level app window selected by target_identity from list_windows.',
    focus_window: 'Reveal and focus a top-level app window selected by target_identity from list_windows.',
    maximize_window: 'Zoom or maximize a top-level app window selected by target_identity from list_windows.',
    minimize_window: 'Minimize a top-level app window selected by target_identity from list_windows.',
    restore_window: 'Restore a minimized top-level app window selected by target_identity from list_windows.',
    set_window_bounds: 'Move and resize a top-level app window selected by target_identity from list_windows.',
    type_text: 'Type literal text using keyboard input.',
    perform_secondary_action: 'Invoke a secondary accessibility action exposed by an element.',
  };
  return descriptions[name] ?? name;
}

export function computerUseToolContractForTest(): Array<{
  name: string;
  description: string;
  inputSchema: BuiltinToolDefinition['inputSchema'];
}> {
  return [...COMPUTER_USE_TOOL_NAMES].map((name) => ({
    name,
    description: computerUseDescription(name),
    inputSchema: computerUseToolSchema(name),
  }));
}

export const enrichListWindowsResponseWithTargetIdentityForTest = enrichListWindowsResponseWithTargetIdentity;
export const requireWindowTargetIdentityForBoundsForTest = requireWindowTargetIdentityForBounds;

export function setBrowserControlStatusProviderForCuaDriverTest(
  provider: (() => Promise<BrowserControlStatus>) | null,
): void {
  browserControlStatusProvider = provider ?? getBrowserControlStatus;
}

export function setBrowserAccessPolicyProviderForCuaDriverTest(
  provider: (() => Promise<BrowserAccessPolicy>) | null,
): void {
  browserAccessPolicyProvider = provider ?? getBrowserAccessPolicy;
}

export function setCuaAccessPolicyProviderForCuaDriverTest(
  provider: (() => Promise<CuaAccessPolicy>) | null,
): void {
  cuaAccessPolicyProvider = provider ?? getCuaAccessPolicy;
}

export function setWindowsCuaDriverToolProviderForTest(
  provider: WindowsCuaDriverToolProvider | null,
): void {
  windowsCuaDriverToolProvider = provider ?? callWindowsCuaDriverTool;
}

export function clearComputerUseTargetCacheForTest(): void {
  computerUseAppStateCache.clear();
}

export const callComputerUseToolForTest = callComputerUseTool;
export const requestApprovalForTest = requestApproval;

function buildComputerUseTools(): BuiltinToolDefinition[] {
  return [...COMPUTER_USE_TOOL_NAMES].map((name) => ({
    name: name as BuiltinToolDefinition['name'],
    description: computerUseDescription(name),
    inputSchema: computerUseToolSchema(name),
    handler: async (args: Record<string, unknown>, context?: BuiltinToolContext) => (
      callComputerUseTool(name, args, context)
    ),
    annotations: {
      readOnlyHint: name === 'list_apps' || name === 'get_app_state' || name === 'get_ui_elements',
    },
  }));
}

// Keep the static tool catalog available on every platform. Runtime
// registration remains guarded by isCuaDriverSupportedPlatform() in
// builtinTools.ts, while platform-neutral consumers (for example the shared
// overlay prompt catalog) still need the authoritative schemas on Linux.
export const cuaDriverTools: BuiltinToolDefinition[] = buildComputerUseTools();
