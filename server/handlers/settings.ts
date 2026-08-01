/**
 * Settings Handlers
 *
 * THE business logic for theme, primaryColor, backgroundOpacity.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import * as configStore from '../configStore';
import { broadcastEvent } from './broadcast';
import { IPC_CHANNELS } from '../../electron/ipc/registry';
import { booleanSettingChannels, type BooleanUISettingId } from '../../shared/booleanSettings';
import { emitInterpreterOverlaySettingsChanged } from '../../apps/interpreter-overlay/electron/settings-events';
import { emitBooleanUISettingChanged } from '../lib/boolean-ui-setting-events';
import { getCurrentServerAccessTokenUserIdSync } from '../lib/authTokens';
import {
  getInterpreterOverlayAccessState,
  type InterpreterOverlayAccessState,
} from '../lib/subscriptionStatus';
import type { InterpreterOverlaySettings } from '../../apps/interpreter-overlay/shared/settings';
import { resolveOverlaySettingsForCurrentAccount } from '../../apps/interpreter-overlay/electron/access';
import { constants as fsConstants } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

import { supportedLanguages, type SupportedLanguage } from '../../shared/locales';

type ThemeOption = 'light' | 'dark' | 'system';
type RuntimeConfigFileId = 'interpreterConfigJson' | 'runtimeConfigToml';

interface RuntimeConfigResetFileResult {
  id: RuntimeConfigFileId;
  path: string;
  existed: boolean;
  removed: boolean;
  error?: string;
}

interface RuntimeConfigResetResponse {
  success: boolean;
  files: RuntimeConfigResetFileResult[];
}

interface RuntimeConfigResetOptions {
  interpreterConfigPath?: string;
  runtimeConfigTomlPath?: string;
}

function getElectronModule(): typeof import('electron') {
  return require(['electron'].join('')) as typeof import('electron');
}

const electronNativeTheme = process.versions.electron
  ? (getElectronModule() as { nativeTheme: { themeSource: ThemeOption } }).nativeTheme
  : null;

function getCurrentOverlayAccountUserId(): string | null {
  if (!process.versions.electron) {
    return null;
  }

  return getCurrentServerAccessTokenUserIdSync();
}

// ============================================================================
// Language / Locale
// ============================================================================

export async function getLanguage(): Promise<{ language: string }> {
  const language = await configStore.getLanguage();
  if (language) return { language };

  // No config override -- resolve from main process i18next if in Electron
  if (process.versions.electron) {
    const { getCurrentLanguage } = await import('../../electron/i18n');
    return { language: getCurrentLanguage() };
  }

  return { language: 'en' };
}

export async function setLanguage(language: string): Promise<{ success: boolean; error?: string }> {
  if (!(supportedLanguages as readonly string[]).includes(language)) {
    return { success: false, error: `Unsupported language: ${language}` };
  }

  await configStore.setLanguage(language);

  // Update main process i18next and rebuild menus
  if (process.versions.electron) {
    const { changeLanguage } = await import('../../electron/i18n');
    await changeLanguage(language as SupportedLanguage);
    const { buildApplicationMenu } = await import('../../electron/menu');
    await buildApplicationMenu();
  }

  broadcastEvent(IPC_CHANNELS.LOCALE_CHANGED, { language });
  return { success: true };
}

// ============================================================================
// Theme
// ============================================================================

export async function getTheme(): Promise<{ theme: ThemeOption }> {
  const theme = await configStore.getTheme();
  return { theme };
}

export async function setTheme(theme: ThemeOption): Promise<{ success: boolean }> {
  if (electronNativeTheme) {
    electronNativeTheme.themeSource = theme;
  }
  await configStore.setTheme(theme);
  broadcastEvent('theme:changed', { theme });
  return { success: true };
}

// ============================================================================
// Primary Color
// ============================================================================

export async function getPrimaryColor(): Promise<{ color: string }> {
  const color = await configStore.getPrimaryColor();
  return { color };
}

export async function setPrimaryColor(color: string): Promise<{ success: boolean }> {
  await configStore.setPrimaryColor(color);
  broadcastEvent('primaryColor:changed', { color });
  return { success: true };
}

// ============================================================================
// Background Opacity
// ============================================================================

export async function getBackgroundOpacity(): Promise<{ opacity: number }> {
  const opacity = await configStore.getBackgroundOpacity();
  return { opacity };
}

export async function setBackgroundOpacity(opacity: number): Promise<{ success: boolean }> {
  await configStore.setBackgroundOpacity(opacity);
  broadcastEvent('backgroundOpacity:changed', { opacity });
  return { success: true };
}

// ============================================================================
// Zoom Factor
// ============================================================================

export async function getZoomFactor(): Promise<{ zoomFactor: number }> {
  const zoomFactor = await configStore.getZoomFactor();
  return { zoomFactor };
}

export async function setZoomFactor(zoomFactor: number): Promise<{ success: boolean }> {
  await configStore.setZoomFactor(zoomFactor);

  if (process.versions.electron) {
    const { BrowserWindow } = getElectronModule();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.setZoomFactor(zoomFactor);
    }
  }

  broadcastEvent('zoomFactor:changed', { zoomFactor });
  return { success: true };
}

function resolveInterpreterDataDir(): string {
  const explicitUserDataDir = process.env.INTERPRETER_USER_DATA_DIR?.trim();
  if (explicitUserDataDir) {
    return explicitUserDataDir;
  }

  if (process.versions.electron) {
    const { app } = require('electron') as typeof import('electron');
    return app.getPath('userData');
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA is required to resolve Interpreter data directory');
    }
    return pathJoin(appData, 'interpreter');
  }

  if (process.platform === 'darwin') {
    return pathJoin(homedir(), 'Library', 'Application Support', 'interpreter');
  }

  return pathJoin(process.env.XDG_CONFIG_HOME ?? pathJoin(homedir(), '.config'), 'interpreter');
}

async function resetRuntimeConfigFile(
  id: RuntimeConfigFileId,
  filePath: string,
): Promise<RuntimeConfigResetFileResult> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    return { id, path: filePath, existed: false, removed: false };
  }

  try {
    await rm(filePath, { force: true });
    return { id, path: filePath, existed: true, removed: true };
  } catch (error: any) {
    return {
      id,
      path: filePath,
      existed: true,
      removed: false,
      error: error?.message || String(error),
    };
  }
}

export async function resetRuntimeConfigFiles(
  options: RuntimeConfigResetOptions = {},
): Promise<RuntimeConfigResetResponse> {
  const interpreterConfigPath = options.interpreterConfigPath
    ?? pathJoin(homedir(), '.interpreter', 'config.json');
  const runtimeConfigTomlPath = options.runtimeConfigTomlPath
    ?? pathJoin(resolveInterpreterDataDir(), 'codex-home', 'config.toml');

  const files = await Promise.all([
    resetRuntimeConfigFile('interpreterConfigJson', interpreterConfigPath),
    resetRuntimeConfigFile('runtimeConfigToml', runtimeConfigTomlPath),
  ]);

  return {
    success: files.every((entry) => !entry.error),
    files,
  };
}

// ============================================================================
// Max Steps (Agent Settings)
// ============================================================================

export async function getMaxSteps(): Promise<{ maxSteps: number }> {
  const maxSteps = await configStore.getMaxSteps();
  return { maxSteps };
}

export async function setMaxSteps(maxSteps: number): Promise<{ success: boolean }> {
  await configStore.setMaxSteps(maxSteps);
  broadcastEvent('maxSteps:changed', { maxSteps });
  return { success: true };
}

// ============================================================================
// Max Subagent Depth
// ============================================================================

export async function getMaxSubagentDepth(): Promise<{ maxSubagentDepth: number }> {
  const maxSubagentDepth = await configStore.getMaxSubagentDepth();
  return { maxSubagentDepth };
}

export async function setMaxSubagentDepth(depth: number): Promise<{ success: boolean }> {
  await configStore.setMaxSubagentDepth(depth);
  broadcastEvent('maxSubagentDepth:changed', { maxSubagentDepth: depth });
  return { success: true };
}

// ============================================================================
// Auto-Continuation Limit
// ============================================================================

export async function getAutoContinuationLimit(): Promise<{ autoContinuationLimit: number }> {
  const autoContinuationLimit = await configStore.getAutoContinuationLimit();
  return { autoContinuationLimit };
}

export async function setAutoContinuationLimit(limit: number): Promise<{ success: boolean }> {
  await configStore.setAutoContinuationLimit(limit);
  broadcastEvent('autoContinuationLimit:changed', { autoContinuationLimit: limit });
  return { success: true };
}

// ============================================================================
// Boolean UI Settings (generic)
// ============================================================================

const BOOLEAN_SETTING_SIDE_EFFECTS: Partial<Record<BooleanUISettingId, (enabled: boolean) => void>> = {
  launchAtLogin: (_enabled) => {
    if (!process.versions.electron) return;
    const { app } = getElectronModule();
    const launchAtLogin = configStore.getBooleanUISettingSync('launchAtLogin');
    app.setLoginItemSettings({
      openAtLogin: launchAtLogin,
      openAsHidden: launchAtLogin,
    });
  },
};

export async function getBooleanUISetting(id: BooleanUISettingId): Promise<{ enabled: boolean }> {
  const enabled = await configStore.getBooleanUISetting(id);
  return { enabled };
}

export async function setBooleanUISetting(id: BooleanUISettingId, enabled: boolean): Promise<{ success: boolean }> {
  await configStore.setBooleanUISetting(id, enabled);
  BOOLEAN_SETTING_SIDE_EFFECTS[id]?.(enabled);
  emitBooleanUISettingChanged({ id, enabled });
  broadcastEvent(booleanSettingChannels(id).changed, { enabled });
  return { success: true };
}

// ============================================================================
// Interpreter Overlay Settings
// ============================================================================

export async function getInterpreterOverlaySettings(): Promise<{ settings: InterpreterOverlaySettings }> {
  const settings = await configStore.getInterpreterOverlaySettings();
  return {
    settings: resolveOverlaySettingsForCurrentAccount(
      settings,
      getCurrentOverlayAccountUserId(),
    ),
  };
}

export async function getInterpreterOverlaySettingsAccessState(
  options?: { forceRefresh?: boolean },
): Promise<{ state: InterpreterOverlayAccessState }> {
  return {
    state: await getInterpreterOverlayAccessState(options),
  };
}

export function scopeInterpreterOverlaySettingsToCurrentAccount(
  settings: InterpreterOverlaySettings,
  currentUserId: string | null,
): InterpreterOverlaySettings {
  if (!settings.enabled) {
    return settings;
  }

  return {
    ...settings,
    accountUserId: currentUserId,
  };
}

export async function setInterpreterOverlaySettings(
  settings: InterpreterOverlaySettings,
): Promise<{ success: boolean; settings: InterpreterOverlaySettings }> {
  const scopedSettings = scopeInterpreterOverlaySettingsToCurrentAccount(
    settings,
    getCurrentOverlayAccountUserId(),
  );
  const nextSettings = await configStore.setInterpreterOverlaySettings(scopedSettings);
  emitInterpreterOverlaySettingsChanged(nextSettings);
  broadcastEvent('overlaySettings:changed', { settings: nextSettings });
  return { success: true, settings: nextSettings };
}

type OverlayScreenRecordingStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

interface InterpreterOverlayPermissionStatus {
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
  screenRecordingStatus: OverlayScreenRecordingStatus;
}

interface InterpreterOverlayPermissionResponse {
  success: boolean;
  status: InterpreterOverlayPermissionStatus;
  error?: string;
}

const nonDarwinOverlayScreenCaptureProbeState: {
  attempted: boolean;
  granted: boolean;
  error?: string;
} = {
  attempted: false,
  granted: false,
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAccessibilityPermissionErrorMessage(
  status: InterpreterOverlayPermissionStatus,
  requestError?: string,
): string | undefined {
  if (status.accessibilityGranted) {
    return undefined;
  }

  if (requestError) {
    return 'Accessibility permission is still not granted. Approve Interpreter in System Settings > Privacy & Security > Accessibility, then return here.';
  }

  return 'Grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then return here.';
}

function getScreenRecordingPermissionErrorMessage(
  status: InterpreterOverlayPermissionStatus,
  options: {
    wasDeniedBeforeRequest: boolean;
    captureError?: string;
    openedSettings: boolean;
    openSettingsError?: string;
  },
): string | undefined {
  if (status.screenRecordingGranted) {
    return undefined;
  }

  if (status.screenRecordingStatus === 'restricted') {
    return 'Screen Recording is restricted by macOS and cannot be granted from Interpreter.';
  }

  if (status.screenRecordingStatus === 'denied') {
    if (options.wasDeniedBeforeRequest) {
      if (options.openedSettings) {
        return 'Screen Recording permission was previously denied. System Settings was opened so you can enable Interpreter in Privacy & Security > Screen Recording.';
      }
      if (options.openSettingsError) {
        return `Screen Recording permission was previously denied and System Settings could not be opened (${options.openSettingsError}). Enable Interpreter in Privacy & Security > Screen Recording, then return here.`;
      }
      return 'Screen Recording permission was previously denied. Enable Interpreter in System Settings > Privacy & Security > Screen Recording, then return here.';
    }
    return 'Screen Recording permission was not granted. Enable Interpreter in System Settings > Privacy & Security > Screen Recording, then return here.';
  }

  if (options.captureError) {
    return 'Screen Recording permission is still not granted. If macOS did not show a prompt, enable Interpreter in System Settings > Privacy & Security > Screen Recording, then return here.';
  }

  return 'Screen Recording permission is still not granted. Enable Interpreter in System Settings > Privacy & Security > Screen Recording, then return here.';
}

function setNonDarwinOverlayScreenCaptureProbeState(
  granted: boolean,
  error?: string,
): void {
  nonDarwinOverlayScreenCaptureProbeState.attempted = true;
  nonDarwinOverlayScreenCaptureProbeState.granted = granted;
  nonDarwinOverlayScreenCaptureProbeState.error = error;
}

function getNonDarwinOverlayPermissionStatusInternal(): InterpreterOverlayPermissionStatus {
  if (process.platform === 'linux') {
    return {
      accessibilityGranted: true,
      screenRecordingGranted: nonDarwinOverlayScreenCaptureProbeState.granted,
      screenRecordingStatus: nonDarwinOverlayScreenCaptureProbeState.granted
        ? 'granted'
        : nonDarwinOverlayScreenCaptureProbeState.attempted
          ? 'unknown'
          : 'not-determined',
    };
  }

  return {
    accessibilityGranted: true,
    screenRecordingGranted: !nonDarwinOverlayScreenCaptureProbeState.attempted
      || nonDarwinOverlayScreenCaptureProbeState.granted,
    screenRecordingStatus: nonDarwinOverlayScreenCaptureProbeState.attempted
      && !nonDarwinOverlayScreenCaptureProbeState.granted
      ? 'unknown'
      : 'granted',
  };
}

function getNonDarwinScreenCaptureErrorMessage(captureError?: string): string {
  if (process.platform === 'linux') {
    if (captureError) {
      return `Screen capture is still unavailable on Linux (${captureError}). Approve the desktop environment's screen-share prompt. Wayland sessions also require a working xdg-desktop-portal ScreenCast service.`;
    }
    return 'Screen capture is still unavailable on Linux. Approve the desktop environment\'s screen-share prompt. Wayland sessions also require a working xdg-desktop-portal ScreenCast service.';
  }

  if (captureError) {
    return `Screen capture is unavailable in this Windows session (${captureError}). Windows does not use a separate Overlay permission prompt for desktop capture, so this usually means capture is blocked or unavailable right now.`;
  }

  return 'Screen capture is unavailable in this Windows session. Windows does not use a separate Overlay permission prompt for desktop capture, so this usually means capture is blocked or unavailable right now.';
}

async function probeInterpreterOverlayScreenCapture(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const { Capture } = await import('../../apps/interpreter-overlay/runtime/infra/capture');
    const capture = new Capture();
    await capture.captureActiveDisplayStrip();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: toErrorMessage(error),
    };
  }
}

function getInterpreterOverlayPermissionStatusInternal(): InterpreterOverlayPermissionStatus {
  if (!process.versions.electron) {
    return {
      accessibilityGranted: true,
      screenRecordingGranted: true,
      screenRecordingStatus: 'granted',
    };
  }

  if (process.platform !== 'darwin') {
    return getNonDarwinOverlayPermissionStatusInternal();
  }

  const { systemPreferences } = getElectronModule();
  const screenRecordingStatus = systemPreferences.getMediaAccessStatus('screen') as OverlayScreenRecordingStatus;
  const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false);

  return {
    accessibilityGranted,
    screenRecordingGranted: screenRecordingStatus === 'granted',
    screenRecordingStatus,
  };
}

export async function getInterpreterOverlayPermissionStatus(): Promise<{
  status: InterpreterOverlayPermissionStatus;
}> {
  return {
    status: getInterpreterOverlayPermissionStatusInternal(),
  };
}

export async function requestInterpreterOverlayAccessibilityPermission(): Promise<InterpreterOverlayPermissionResponse> {
  if (!process.versions.electron || process.platform !== 'darwin') {
    return {
      success: true,
      status: getInterpreterOverlayPermissionStatusInternal(),
    };
  }

  const { systemPreferences } = getElectronModule();
  let requestError: string | undefined;

  try {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true);
    }
  } catch (error) {
    requestError = toErrorMessage(error);
  }

  const status = getInterpreterOverlayPermissionStatusInternal();

  return {
    success: status.accessibilityGranted,
    status,
    error: getAccessibilityPermissionErrorMessage(status, requestError),
  };
}

export async function requestInterpreterOverlayScreenRecordingPermission(): Promise<InterpreterOverlayPermissionResponse> {
  if (!process.versions.electron) {
    return {
      success: true,
      status: getInterpreterOverlayPermissionStatusInternal(),
    };
  }

  if (process.platform !== 'darwin') {
    const probe = await probeInterpreterOverlayScreenCapture();
    setNonDarwinOverlayScreenCaptureProbeState(probe.success, probe.error);
    const status = getInterpreterOverlayPermissionStatusInternal();
    return {
      success: probe.success,
      status,
      error: probe.success ? undefined : getNonDarwinScreenCaptureErrorMessage(probe.error),
    };
  }

  const { systemPreferences } = getElectronModule();
  const initialStatus = systemPreferences.getMediaAccessStatus('screen') as OverlayScreenRecordingStatus;
  const wasDeniedBeforeRequest = initialStatus === 'denied';
  let captureError: string | undefined;
  let openSettingsError: string | undefined;
  let openedSettings = false;

  try {
    if (initialStatus !== 'granted' && initialStatus !== 'restricted') {
      const { Capture } = await import('../../apps/interpreter-overlay/runtime/infra/capture');
      const capture = new Capture();
      await capture.captureActiveDisplayStrip();
    }
  } catch (error) {
    captureError = toErrorMessage(error);
  }

  const status = getInterpreterOverlayPermissionStatusInternal();

  if (wasDeniedBeforeRequest && !status.screenRecordingGranted && status.screenRecordingStatus === 'denied') {
    const openSettingsResult = await openInterpreterOverlayPermissionPane('Privacy_ScreenCapture');
    openedSettings = openSettingsResult.success;
    openSettingsError = openSettingsResult.error;
  }

  return {
    success: status.screenRecordingGranted,
    status,
    error: getScreenRecordingPermissionErrorMessage(status, {
      wasDeniedBeforeRequest,
      captureError,
      openedSettings,
      openSettingsError,
    }),
  };
}

type InterpreterOverlayPermissionPane = 'Privacy_Accessibility' | 'Privacy_ScreenCapture';

async function openInterpreterOverlayPermissionPane(
  pane: InterpreterOverlayPermissionPane,
): Promise<{ success: boolean; error?: string }> {
  if (!process.versions.electron || process.platform !== 'darwin') {
    return { success: true };
  }

  try {
    const { shell } = getElectronModule();
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openInterpreterOverlayAccessibilitySettings(): Promise<{
  success: boolean;
  error?: string;
}> {
  return openInterpreterOverlayPermissionPane('Privacy_Accessibility');
}

export async function openInterpreterOverlayScreenRecordingSettings(): Promise<{
  success: boolean;
  error?: string;
}> {
  return openInterpreterOverlayPermissionPane('Privacy_ScreenCapture');
}

// ============================================================================
// MCP/Tool Settings
// ============================================================================

export async function getAllowAgentAddTools(): Promise<{ allowed: boolean }> {
  const allowed = await configStore.getAllowAgentAddTools();
  return { allowed };
}

export async function setAllowAgentAddTools(allowed: boolean): Promise<{ success: boolean }> {
  await configStore.setAllowAgentAddTools(allowed);
  broadcastEvent('mcpSettings:allowAgentAddToolsChanged', { allowed });
  return { success: true };
}

export async function getAllowLocalMcpServers(): Promise<{ allowed: boolean }> {
  const allowed = await configStore.getAllowLocalMcpServers();
  return { allowed };
}

export async function setAllowLocalMcpServers(allowed: boolean): Promise<{ success: boolean }> {
  await configStore.setAllowLocalMcpServers(allowed);
  broadcastEvent('mcpSettings:allowLocalMcpServersChanged', { allowed });
  return { success: true };
}

// ============================================================================
// Skills Settings
// ============================================================================

export async function getSkillFolders(): Promise<{ folders: string[] }> {
  const folders = await configStore.getSkillFolders();
  return { folders };
}

export async function setSkillFolders(folders: string[]): Promise<{ success: boolean }> {
  await configStore.setSkillFolders(folders);
  // Invalidate skills cache so new folders are picked up
  const { invalidateSkillsCache, reconcileCustomFolderWatchers } = await import('./skills');
  invalidateSkillsCache();
  reconcileCustomFolderWatchers(folders);
  broadcastEvent('skills:changed', {});
  broadcastEvent('skillSettings:foldersChanged', { folders });
  return { success: true };
}

export async function getAllowModelSkillEditing(): Promise<{ allowed: boolean }> {
  const allowed = await configStore.getAllowModelSkillEditing();
  return { allowed };
}

export async function setAllowModelSkillEditing(allowed: boolean): Promise<{ success: boolean }> {
  await configStore.setAllowModelSkillEditing(allowed);
  broadcastEvent('skillSettings:allowModelSkillEditingChanged', { allowed });
  return { success: true };
}
