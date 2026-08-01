import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WsWebSocket from 'ws';
import { mouse } from '@nut-tree-fork/nut-js';
import { approvalManager } from '../../../server/approvalManager';
import { agentTabManager } from '../../../server/agentTabManager';
import { startAgentTask } from '../../../server/agentTaskService';
import { readWordTool } from '../../../server/tools/builtin-tools/docx/readWordTool';
import { readPdfTool } from '../../../server/tools/builtin-tools/pdf/readPdfTool';
import { readSpreadsheetAttachment } from '../../../server/utils/readSpreadsheetAttachment';
import type { ToolCallResponse } from '../../../server/tools/toolTypes';
import {
  getRecentFolders,
  getCustomInstructions,
  getCuaAccessPolicy,
  getInterpreterOverlaySettings,
  getOnboardingState,
  setOnboardingState,
  setInterpreterOverlaySettings,
} from '../../../server/configStore';
import { createProfile, listProfiles, updateProfile } from '../../../server/handlers/profiles';
import { getSkills } from '../../../server/handlers/skills';
import { callTool as callInterpreterTool } from '../../../server/handlers/toolServers';
import { onServerAuthChanged } from '../../../server/lib/auth-events';
import {
  overlaySessionManager,
  type OverlayDrawingRequest,
  type OverlaySessionCapturedContext,
  type OverlaySessionCreateOptions,
  type OverlaySessionRecord,
} from '../../../server/overlaySessionManager';
import {
  getInterpreterOverlayAccessState,
  type InterpreterOverlayAccessState,
} from '../../../server/lib/subscriptionStatus';
import {
  getCurrentServerAccessTokenSync,
  getCurrentServerAccessTokenUserIdSync,
} from '../../../server/lib/authTokens';
import { getCurrentWorkspace } from '../../../server/utils/workspace';
import {
  getBrowserControlPageElementInventory,
  getBrowserControlStatus,
} from '../../../server/utils/browserExtensionRelay';
import { getWindowSessionByKey, listWindowSessions } from '../../../server/utils/windowSessions';
import { callHiddenAgentTool } from '../../../server/tools/builtin-tools/interpreter-overlay/hiddenAgentTool';
import type { StreamImageAttachment } from '../../../src/lib/codex/api-types';
import { isTerminalProfile, profileToModelConfig, type Profile } from '../../../shared/types/profile';
import {
  markOnboardingStepIdComplete,
  ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID,
} from '../../../shared/types/onboardingState';
import { resolveCuaAccessPolicyMode } from '../../../shared/cuaAccessPolicy.js';
import { getInterpreterOverlayBaseUrl } from '../../../shared/hostedApi.js';
import { RunEngine, type RunEngineDebugContext } from '../runtime/core/run-engine.js';
import {
  filterOverlayScopeSheenElements,
  normalizeStructuredContext,
} from '../runtime/core/structured-context.js';
import { mergeStreamingVoiceTranscript, normalizeVoiceText } from '../../../agent/utils/voiceTranscript.js';
import { Capture } from '../runtime/infra/capture.js';
import { activeWindow, windowAtPoint, type WindowInfo } from '../runtime/infra/window-tracker.js';
import { Automation, getAutomationDebugTrace, resetAutomationDebugTrace, type AutomationDebugEvent } from '../runtime/infra/automation.js';
import {
  appendOverlayTranscriptDebugEvent,
  createRemoteAgent,
  getOverlayTranscriptDebugEvents,
  resetOverlayTranscriptDebugEvents,
  type OverlayTranscriptDebugEvent,
} from '../runtime/infra/agent-remote.js';
import {
  performSegmentedOCR,
  type ScreenElement,
} from '../runtime/infra/accessibility-parser/index.js';
import { Input } from '../runtime/infra/input.js';
import {
  ProgressiveBlur,
  type ProgressiveBlurDebugState,
  type ProgressiveBlurLifecycleEvent,
} from '../runtime/infra/progressive-blur.js';
import { ServerClient } from '../runtime/infra/server-client.js';
import { createServerSTT, type ExtendedSTTPort } from '../runtime/stt/server.js';
import { INTERPRETER_OVERLAY_INPUT_DESIGN, usesProgressiveBlurInput } from '../shared/design.js';
import {
  INTERPRETER_OVERLAY_AX_MODE as OVERLAY_AX_MODE,
  INTERPRETER_OVERLAY_AGENT_MODE,
  INTERPRETER_OVERLAY_VISION_MODE as OVERLAY_VISION_MODE,
} from '../shared/agent-mode.js';
import { buildOverlayMainAgentSystemPrompt } from '../shared/main-agent-prompt.js';
import {
  buildOverlayContextPacketText,
  getOverlayRegionScopeKind,
} from '../shared/context-packet.js';
import {
  hasExecutableTargetRefs,
  isStructuredContextReadyForTarget,
} from './target-context-readiness.js';
import { getOverlayRegionSelectionRole } from './region-selection-role.js';
import { appendOverlayPromptExtras } from './overlay-prompt-extras.js';
import { getWorldReviewControlHitFromGlobalPoint } from './world-review-control-hit.js';
import {
  FORM_TESTS_ADVANCED_VOICE_AGENT_ALLOWED_TOOL_NAMES,
  OVERLAY_AGENT_ALLOWED_TOOL_NAMES,
  OVERLAY_AGENT_TOOL_NAMES,
  OVERLAY_AGENT_TOOL_SERVER_ID,
} from './overlay-agent-tools.js';
import { type AdvancedVoiceSessionKind } from '../shared/advanced-voice-create-call.js';
import { buildOverlayBuiltinToolIdentity, buildOverlayToolManagerIdentity } from './overlay-tool-identity.js';
import { runOverlayTextControllerLoop } from './text-controller-loop.js';
import {
  appendOverlayHiddenAgentReportInstruction,
  OVERLAY_HIDDEN_AGENT_REPORT_CONTRACT,
} from './overlay-controller-prompt.js';
import { createOverlayTextControllerLoopChatTransport } from './text-controller-loop-transport.js';
import {
  callOverlayComputerBatchBridgeTool,
  formatOverlaySelectedTargetBatchResult,
} from './overlay-computer-batch-bridge.js';
import { formatTouchedWindowDiff } from '../shared/touched-window-diff.js';
import { OverlayInvalidBatchActionError, OverlayTargetWindowClosedError } from '../shared/tool-results.js';
import { buildOverlaySelectedContextToolArgs } from './overlay-selected-context-tool-args.js';
import type { AgentRunResult, ToolCall, ToolExecutionResult, UIPort } from '../shared/ports.js';
import {
  clampBoundsToBounds,
  getDisplayViewport,
  hasMeaningfulScope,
  intersectBounds,
  normalizeDragBounds,
  relativeBBoxToBoundsInViewport,
  toAbsoluteBounds,
  toLocalBounds,
} from '../shared/scope.js';
import type { Action, Bounds, DisplayInfo, UIState } from '../shared/types.js';
import type {
  OverlayAction,
  OverlayBootstrapData,
  OverlayContextItem,
  OverlayContextRole,
  OverlayFileContextItem,
  OverlayRegionContextItem,
  OverlayRegionScopeKind,
  OverlaySelectionElement,
  OverlaySkillsResponse,
  OverlayState,
  OverlayUserAttachment,
  OverlayVisualHealth,
  OverlayVisualProbe,
  ReviewAction,
} from '../shared/ipc.js';
import type { QuestionRequest } from '../../../shared/types/approval';
import { DEFAULT_OVERLAY_STATE } from '../shared/ipc.js';
import { DEFAULT_INTERPRETER_OVERLAY_MODEL } from '../shared/model-config.js';
import {
  DEFAULT_INTERPRETER_OVERLAY_SETTINGS,
  resolveOverlayModelTaskProfileIds,
  type InterpreterOverlaySettings,
} from '../shared/settings.js';
import { AdvancedVoiceController } from './advanced-voice-controller.js';
import {
  buildOverlayTextControllerContextPrompt,
  buildOverlayTextControllerRequest,
  buildOverlayBrowserControlStateFromStatus,
  buildOverlayWholeComputerStateText,
  getTargetContextItem,
  isExecutableOverlayTextControllerDirectCommand,
  mergeOverlayContextItems,
  recordOverlayTextControllerAgentFailureResult,
  recordOverlayTextControllerAgentLaunchResult,
  recordOverlayTextControllerDirectCommandResult,
  type OverlayTextControllerManagedContext,
  type OverlayTextControllerManagedToolCall,
  type OverlayWholeComputerState,
} from '../shared/text-controller.js';
import {
  buildOverlayTargetIdentity,
  buildCurrentSelectionContext,
  type OverlayTargetAppIdentity,
  type OverlayTargetIdentity,
  type CurrentSelectionContext,
} from '../shared/target-identity.js';
import {
  executeOverlayTextControllerDirectCommand,
  OverlayTextDirectCommandExecutionError,
} from './text-controller-direct-command.js';
import { loadCuaRegionSelectionElements } from './cua-region-selection.js';
import {
  buildAttachedTargetContextSnapshot,
  committedTargetWindowClosedMessage,
  getNativeCuaSelectionRefreshRequest,
} from './attached-target-context.js';
import {
  buildNativeCuaAppWindowScrollToolCallForTarget,
  buildNativeCuaAppWindowTypeTextToolCallForTarget,
  buildNativeCuaClickToolCallForTarget,
  buildNativeCuaOverlayClickToolCall,
  buildNativeCuaOverlayScrollToolCall,
  buildNativeCuaOverlayTypeToolCall,
  buildNativeCuaPointClickToolCallForTarget,
  buildNativeCuaPressKeyToolCallForTarget,
  buildNativeCuaScrollToolCallForTarget,
  buildNativeCuaSelectOptionToolCallForTarget,
  buildNativeCuaSetValueToolCallForTarget,
  buildNativeCuaTypeTextToolCallForTarget,
  type NativeCuaOverlayToolCall,
} from './native-cua-overlay-action.js';
import {
  buildBrowserPageClickToolCallForTarget,
  buildBrowserPageOverlayClickToolCall,
  buildBrowserPageOverlayScrollToolCall,
  buildBrowserPageSelectToolCallForTarget,
  buildBrowserPageScrollToolCallForTarget,
  buildBrowserPageTypeToolCallForTarget,
  type BrowserPageOverlayToolCall,
} from './browser-page-overlay-action.js';
import { mergeSelectedContextRefsIntoRunEngineElements } from './selected-context-run-engine-elements.js';
import { buildOverlayTextControllerToolCatalogText } from './text-controller-tool-catalog.js';
import { hitsOverlayDrawingAction } from './overlay-drawing-hit-test.js';
import {
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Notification,
  powerSaveBlocker,
  screen,
} from './electron-bridge.js';
import {
  getOverlayUnavailableDialog,
  resolveEffectiveOverlaySettings,
  resolveOverlaySettingsForCurrentAccount,
} from './access.js';
import { INTERPRETER_OVERLAY_CHANNELS as CHANNELS } from './channels.js';
import { completedHotkeyHoldAfterInputOpenMs, hotkeyHoldIsActive, timedVoiceHoldIsLongEnough } from './hotkey-hold.js';
import { buildOverlayRunningAgents } from './agent-dashboard.js';
import { buildOverlayDashboardApprovals } from './approval-dashboard.js';
import { OverlayWindow } from './overlay-window.js';
import { getPendingHotkeyContextWaitPlan } from './pending-hotkey-context.js';
import { buildOverlayProfileOptions } from './profile-options.js';
import { onInterpreterOverlaySettingsChanged } from './settings-events.js';
import { buildOverlayOpenWorkspaceOptions } from './workspace-options.js';
import {
  buildOverlayContextItemsFromSelectionToolJson,
  createSelectedTextContextItem,
} from './selection-tool-context.js';
import type {
  BrowserControlStatus,
} from '../../../shared/types/browserControl';
import {
  buildOverlayBrowserSelectionElements,
  mergeBrowserSelectionIntoTargetContextItems,
} from './browser-selection-elements.js';

const VOICE_DELAY_MS = 600;
const ADVANCED_VOICE_DELAY_MS = 2000;
const execFileAsync = promisify(execFile);
const DISABLE_VOICE_TIMER = process.env.INTERPRETER_OVERLAY_DISABLE_VOICE_TIMER === 'true';
const FORM_TESTS_MODE = process.env.FORM_TESTS_MODE === 'true';
const DEBUG_EXECUTION_SENTINEL = process.env.INTERPRETER_OVERLAY_EXECUTION_SENTINEL === 'true';
const SHOULD_ENABLE_OVERLAY_GLOBAL_HOOK =
  process.env.NODE_ENV !== 'test' || FORM_TESTS_MODE;
const OVERLAY_VISUAL_HEALTH_CHECK_INTERVAL_MS = 250;
const OVERLAY_VISUAL_HEALTH_STALE_MS = 2500;
const OVERLAY_VISUAL_HEALTH_BLANK_GRACE_MS = 12000;
const OVERLAY_VISUAL_HEALTH_INITIAL_GRACE_MS = 12000;
// A loaded renderer reports its first visual health within a frame or two of
// the first state delivery. If the window claims ready but stays silent this
// long, the renderer is wedged (e.g. suspended while occluded) and must be
// recovered immediately instead of leaving the user staring at the blur.
const OVERLAY_VISUAL_HEALTH_WEDGED_GRACE_MS = 1500;
// A renderer that finished loading but never sent a single visual-health
// report is stalled mid-mount (commonly stuck behind the dev server's cold
// transform queue at app startup). Reload it while the overlay is still idle
// so the first hotkey open finds a live renderer.
const OVERLAY_RENDERER_BOOT_MOUNT_GRACE_MS = 8000;
// The renderer heartbeats every second while mounted. If reports stop for
// this long while the overlay is hidden, the renderer process was suspended;
// reload it in the background before the user needs it.
const OVERLAY_RENDERER_IDLE_SILENCE_MS = 10000;
// At hotkey open, a last report older than this proves the renderer is not
// running; recover immediately instead of waiting out the wedge grace.
const OVERLAY_RENDERER_OPEN_STALE_MS = 3000;
const OVERLAY_VISUAL_HEALTH_RECOVERY_COOLDOWN_MS = 1500;
const OVERLAY_VISUAL_HEALTH_MAX_RECOVERY_ATTEMPTS = 3;
const OVERLAY_EMERGENCY_STOP_CHECK_INTERVAL_MS = 16;
const OVERLAY_EMERGENCY_STOP_CORNER_THRESHOLD_PX = 24;
const PROGRESSIVE_BLUR_CLOSE_DELAY_MS = 160;
const ACTIVE_APP_TARGET_ATTACH_AFTER_INPUT_DELAY_MS = 80;
const WORLD_OVERLAY_CLOSE_FADE_MS = 700;
// How long the fast controller's dead-target text decision stays visible in
// the message pill before the completed run tears down to idle.
const OVERLAY_FAST_PATH_MESSAGE_HOLD_MS = 8000;
const TRACE_PRIMARY_COLORS = [
  '#ff2d55',
  '#00c853',
  '#ffb300',
  '#2979ff',
  '#7c4dff',
  '#00bcd4',
  '#ff6d00',
  '#d500f9',
];

function chooseTracePrimaryColor(): string {
  return TRACE_PRIMARY_COLORS[Math.floor(Math.random() * TRACE_PRIMARY_COLORS.length)] ?? TRACE_PRIMARY_COLORS[0]!;
}

export {
  OVERLAY_AGENT_ALLOWED_TOOL_NAMES,
  OVERLAY_AGENT_TOOL_NAMES,
  OVERLAY_AGENT_TOOL_SERVER_ID,
} from './overlay-agent-tools.js';

export function getAdvancedVoiceAgentAllowedToolNames(): string[] {
  if (!FORM_TESTS_MODE) {
    return OVERLAY_AGENT_ALLOWED_TOOL_NAMES;
  }
  return [
    ...OVERLAY_AGENT_ALLOWED_TOOL_NAMES,
    ...FORM_TESTS_ADVANCED_VOICE_AGENT_ALLOWED_TOOL_NAMES,
  ];
}
const OVERLAY_CONTEXT_TMP_DIR = path.join(os.tmpdir(), 'interpreter-overlay');
const OVERLAY_FILE_CONTEXT_TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'text/csv',
  'text/markdown',
  'text/plain',
]);
const OVERLAY_FILE_CONTEXT_TEXT_EXTENSIONS = new Set([
  '.csv',
  '.json',
  '.jsonl',
  '.md',
  '.markdown',
  '.txt',
  '.tsv',
]);
const OVERLAY_FILE_CONTEXT_DOCUMENT_EXTENSIONS = new Set([
  '.docx',
  '.xls',
  '.xlsm',
  '.xlsx',
]);
const MAX_OVERLAY_FILE_CONTEXT_DATA_URL_BYTES = 10 * 1024 * 1024;
const OVERLAY_FILE_CONTEXT_MIME_BY_EXTENSION = new Map<string, string>([
  ['.bmp', 'image/bmp'],
  ['.csv', 'text/csv'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain'],
  ['.tsv', 'text/tab-separated-values'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);
const FORM_TESTS_OVERLAY_AGENT_PROFILE_ID = 'form-tests:interpreter-smart';
const FORM_TESTS_OVERLAY_AGENT_PROFILE: Profile = {
  id: FORM_TESTS_OVERLAY_AGENT_PROFILE_ID,
  name: 'Interpreter Smart',
  modelId: 'interpreter-smart',
  isBuiltin: false,
  provider: 'hosted',
  providerId: 'builtin:hosted',
  reasoningEffort: 'medium',
};
const FORM_TESTS_ADVANCED_VOICE_AGENT_PROFILE_ID = 'form-tests:advanced-voice-agent';
let ensureFormTestsOverlayAgentProfileInFlight: Promise<void> | null = null;

function resolveFormTestsApiBaseUrl(): string {
  const configuredBaseUrl = (
    process.env.FORM_TESTS_INTERPRETER_OVERLAY_LLM_BASE_URL
    ?? process.env.INTERPRETER_OVERLAY_LLM_BASE_URL
    ?? 'https://api.groq.com/openai'
  ).trim();
  if (configuredBaseUrl.endsWith('/v1')) {
    return configuredBaseUrl;
  }
  return `${configuredBaseUrl.replace(/\/+$/, '')}/v1`;
}

function resolveFormTestsApiEnvironmentKey(baseURL: string): string {
  if (baseURL.includes('groq.com')) {
    return 'GROQ_API_KEY';
  }
  if (baseURL.includes('openrouter.ai')) {
    return 'OPENROUTER_API_KEY';
  }
  if (baseURL.includes('api.openai.com')) {
    return 'OPENAI_API_KEY';
  }
  return process.env.GROQ_API_KEY
    ? 'GROQ_API_KEY'
    : process.env.OPENAI_API_KEY
      ? 'OPENAI_API_KEY'
      : 'OPENROUTER_API_KEY';
}

function resolveFormTestsCodexProfileId(baseURL: string): string {
  if (baseURL.includes('groq.com')) {
    return 'groq';
  }
  if (baseURL.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (baseURL.includes('api.openai.com')) {
    return 'openai-api';
  }
  return 'custom';
}

function createFormTestsAdvancedVoiceAgentProfile(): Profile {
  const baseURL = resolveFormTestsApiBaseUrl();
  return {
    id: FORM_TESTS_ADVANCED_VOICE_AGENT_PROFILE_ID,
    name: 'Interpreter Scenario Voice Agent',
    modelId: (
      process.env.FORM_TESTS_INTERPRETER_OVERLAY_MODEL
      ?? process.env.INTERPRETER_OVERLAY_MODEL
      ?? process.env.SCENARIO_API_MODEL
      ?? 'openai/gpt-oss-120b'
    ).trim(),
    isBuiltin: false,
    provider: 'api',
    apiFormat: 'openai',
    environmentKey: resolveFormTestsApiEnvironmentKey(baseURL),
    baseURL,
    codexProfileId: resolveFormTestsCodexProfileId(baseURL),
    wireApi: 'chat',
    useResponsesApi: false,
    reasoningEffort: 'medium',
  };
}

function sanitizeFilenameSegment(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
}

function parseBase64DataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Expected a base64 data URL.');
  }

  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function getImageExtensionForAttachment(name: string, mimeType: string): string {
  const nameExtension = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(nameExtension)) {
    return nameExtension;
  }

  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    case 'image/heic':
      return '.heic';
    case 'image/heif':
      return '.heif';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.png';
  }
}

function getOverlayFileContextMimeType(filePath: string): string {
  return OVERLAY_FILE_CONTEXT_MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

interface OverlayFileContextSourceOptions {
  sourceKind?: OverlayFileContextItem['sourceKind'];
  sourceLabel?: string | null;
  sourceBounds?: Bounds | null;
  sourceDisplayId?: string | number | null;
}

async function normalizeOverlayFileContextPaths(
  filePaths: string[],
  sourceOptions: OverlayFileContextSourceOptions = {},
): Promise<OverlayFileContextItem[]> {
  const files: OverlayFileContextItem[] = [];
  for (const rawPath of filePaths) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      continue;
    }
    const fileStat = await fs.stat(rawPath);
    if (!fileStat.isFile()) {
      continue;
    }
    files.push({
      id: `overlay-file-${Date.now()}-${randomUUID()}`,
      kind: 'file',
      role: 'reference',
      name: path.basename(rawPath),
      mimeType: getOverlayFileContextMimeType(rawPath),
      sizeBytes: fileStat.size,
      filePath: rawPath,
      ...sourceOptions,
    });
  }

  return await Promise.all(files.map(normalizeOverlayFileContextItem));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatOverlayFileMention(label: string, filePath: string): string {
  const safePath = filePath.replace(/>/g, '%3E');
  return `@[${label}](<${safePath}>)`;
}

export function prependOverlayMentions(prompt: string, mentions: string[]): string {
  if (mentions.length === 0) {
    return prompt;
  }

  const trimmedPrompt = prompt.trim();
  return trimmedPrompt
    ? `${mentions.join('\n')}\n\n${trimmedPrompt}`
    : mentions.join('\n');
}

export function getInterpreterOverlayAccessToken(): string {
  if (FORM_TESTS_MODE) {
    return 'form-tests-local-overlay-token';
  }

  const accessToken = getCurrentServerAccessTokenSync();
  if (!accessToken) {
    throw new Error('Please sign in to use Interpreter Overlay.');
  }
  return accessToken;
}

function addFormTestsOverlayAgentProfile(profiles: Profile[]): Profile[] {
  if (!FORM_TESTS_MODE) {
    return profiles;
  }

  const formTestsProfiles = [
    FORM_TESTS_OVERLAY_AGENT_PROFILE,
    createFormTestsAdvancedVoiceAgentProfile(),
  ];
  const existingIds = new Set(profiles.map((profile) => profile.id));
  const missingProfiles = formTestsProfiles.filter((profile) => !existingIds.has(profile.id));
  return [...missingProfiles, ...profiles];
}

async function ensureFormTestsOverlayAgentProfile(): Promise<void> {
  if (!FORM_TESTS_MODE) {
    return;
  }

  if (ensureFormTestsOverlayAgentProfileInFlight) {
    await ensureFormTestsOverlayAgentProfileInFlight;
    return;
  }

  ensureFormTestsOverlayAgentProfileInFlight = (async () => {
    const profilesResponse = await listProfiles();
    const existingIds = new Set((profilesResponse.profiles as Profile[]).map((profile) => profile.id));
    for (const profile of [
      FORM_TESTS_OVERLAY_AGENT_PROFILE,
      createFormTestsAdvancedVoiceAgentProfile(),
    ]) {
      if (existingIds.has(profile.id)) {
        await updateProfile(profile.id, profile);
      } else {
        await createProfile(profile);
      }
    }
  })();

  try {
    await ensureFormTestsOverlayAgentProfileInFlight;
  } finally {
    ensureFormTestsOverlayAgentProfileInFlight = null;
  }
}

type OverlayOpenSource = 'hotkey' | 'tray';
type OverlayRunInputMethod = 'text' | 'voice';

type OverlayPresentationPhase = 'idle' | 'opening' | 'open' | 'closing';

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isControlSpaceHotkey(hotkey: string): boolean {
  const parts = hotkey
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  return parts.length === 2 && parts.includes('control') && parts.includes('space');
}

function appendOverlayDraftSegment(baseText: string, nextSegment: string): string {
  const normalizedSegment = nextSegment.trim();
  if (!normalizedSegment) {
    return baseText;
  }

  if (!baseText.trim()) {
    return normalizedSegment;
  }

  if (/[ \t\r\n]$/.test(baseText)) {
    return `${baseText}${normalizedSegment}`;
  }

  return `${baseText}\n${normalizedSegment}`;
}

function buildProgrammaticRunNotificationBody(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137)}...`;
}

function showProgrammaticRunNotification(prompt: string): void {
  try {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      title: 'Programmatic overlay run started',
      body: buildProgrammaticRunNotificationBody(prompt),
      silent: false,
    });
    notification.show();
  } catch (error) {
    console.warn('[InterpreterOverlayService] Failed to show programmatic run notification:', error);
  }
}

export function formatOverlayBounds(bounds: Bounds | null | undefined): string {
  if (!bounds) {
    return 'the full granted display';
  }

  return `x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, width=${Math.round(bounds.width)}, height=${Math.round(bounds.height)}`;
}

export function createOverlayAgentId(): string {
  return `overlay-agent-${randomUUID()}`;
}

export function createOverlayCallerToken(): string {
  return `overlay-caller-${randomUUID()}`;
}

function showOverlayAgentNotification(options: {
  body: string;
  targetWindowId: number | null;
  showMainWindow: () => void;
}): void {
  try {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      title: 'Interpreter is working on your request.',
      body: options.body,
      silent: false,
    });

    notification.on('click', () => {
      const targetWindow = options.targetWindowId
        ? BrowserWindow.fromId(options.targetWindowId)
        : null;
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.show();
        targetWindow.focus();
        return;
      }

      options.showMainWindow();
    });

    notification.show();
  } catch (error) {
    console.warn('[InterpreterOverlayService] Failed to show overlay agent notification:', error);
  }
}

export interface InterpreterOverlayTrayState {
  enabled: boolean;
  accelerator: string | null;
  runningAgents: Array<{
    agentId: string;
    label: string;
    latestAction: string | null;
  }>;
}

function getCurrentOverlayAccountUserId(): string | null {
  return getCurrentServerAccessTokenUserIdSync();
}

function classifyOverlayRunFailure(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('not_enough_tokens')) return 'not_enough_tokens';
  if (normalized.includes('billing')) return 'billing';
  if (normalized.includes('unauthorized') || normalized.includes('401')) return 'unauthorized';
  if (normalized.includes('remote overlay agent disconnected')) return 'remote_disconnect';
  if (normalized.includes('unexpected server response')) return 'unexpected_response';
  return 'unknown';
}

function getLocalViewport(display: DisplayInfo, scopeBounds: Bounds | null): Bounds {
  return toLocalBounds(getDisplayViewport(display, scopeBounds), display.boundsDIP);
}

export function boundsApproximatelyEqual(left: Bounds | null | undefined, right: Bounds | null | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return Math.abs(left.x - right.x) < 1
    && Math.abs(left.y - right.y) < 1
    && Math.abs(left.width - right.width) < 1
    && Math.abs(left.height - right.height) < 1;
}

function trimInputContextPreviewText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}…` : trimmed;
}

function createOverlayRegionContextItem(params: {
  role: OverlayContextRole;
  bounds: Bounds;
  display: DisplayInfo | null;
  targetWindowSessionKey?: string | null;
  nativeWindowId?: number | string | null;
  app?: OverlayTargetAppIdentity | null;
  label?: string | null;
  scopeKind?: OverlayRegionScopeKind | null;
  appIconDataUrl?: string | null;
  appIconLabel?: string | null;
  previewText?: string | null;
  previewImageDataUrl?: string | null;
  selectableElements?: OverlaySelectionElement[];
}): OverlayRegionContextItem {
  const label = params.label?.trim()
    || (params.role === 'target' ? 'Target region' : 'Reference region');
  const scopeKind = getOverlayRegionScopeKind(params.bounds, params.display, params.scopeKind);
  const id = `overlay-region-${params.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetIdentity = buildOverlayTargetIdentity({
    kind: scopeKind,
    bounds: params.bounds,
    display: params.display,
    targetWindowSessionKey: params.targetWindowSessionKey ?? null,
    nativeWindowId: params.nativeWindowId ?? null,
    appName: params.app?.name ?? null,
    appPid: params.app?.pid ?? null,
    appBundlePath: params.app?.bundlePath ?? null,
  });
  const selectableRefs = (params.selectableElements ?? []).map((element) => ({
    id: element.id,
    role: element.role,
    label: element.label,
    bounds: { ...element.bounds },
    nativeCua: element.nativeCua
      ? {
          app: element.nativeCua.app,
          elementIndex: element.nativeCua.elementIndex,
          targetIdentity: element.nativeCua.targetIdentity
            ? { ...element.nativeCua.targetIdentity }
            : undefined,
        }
      : undefined,
    browser: element.browser ? { ...element.browser } : undefined,
  }));
  return {
    id,
    kind: 'region',
    role: params.role,
    label,
    scopeKind,
    appIconDataUrl: params.appIconDataUrl ?? null,
    appIconLabel: params.appIconLabel ?? null,
    bounds: { ...params.bounds },
    displayId: params.display?.id ?? null,
    targetWindowSessionKey: params.targetWindowSessionKey ?? null,
    targetIdentity,
    snapshot: buildCurrentSelectionContext({
      targetIdentity,
      contextItemIds: [id],
      selectableRefs,
    }),
    previewText: trimInputContextPreviewText(params.previewText ?? null),
    previewImageDataUrl: params.previewImageDataUrl ?? null,
    selectableElements: params.selectableElements,
  };
}

const macAppIconDataUrlCache = new Map<string, string | null>();

async function resolveMacBundleIconDataUrl(appBundlePath: string): Promise<string | null> {
  const cached = macAppIconDataUrlCache.get(appBundlePath);
  if (cached !== undefined) {
    return cached;
  }

  let resolved: string | null = null;
  let tempDir: string | null = null;
  try {
    const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleIconFile',
      infoPlistPath,
    ], {
      timeout: 700,
      maxBuffer: 16 * 1024,
    });
    const iconFile = stdout.trim();
    if (iconFile) {
      const iconFileName = path.extname(iconFile) ? iconFile : `${iconFile}.icns`;
      const iconPath = path.join(appBundlePath, 'Contents', 'Resources', iconFileName);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interpreter-app-icon-'));
      const pngPath = path.join(tempDir, 'icon.png');
      await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', iconPath, '--out', pngPath], {
        timeout: 1200,
        maxBuffer: 256 * 1024,
      });
      const png = await fs.readFile(pngPath);
      if (png.length > 0) {
        resolved = `data:image/png;base64,${png.toString('base64')}`;
      }
    }
  } catch (error) {
    console.warn('[InterpreterOverlay] failed to resolve app bundle icon file', {
      appBundlePath,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  macAppIconDataUrlCache.set(appBundlePath, resolved);
  return resolved;
}

async function resolveMacAppIconDataUrl(pid: number, appBundlePath?: string | null): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  const appPath = appBundlePath?.trim() || '';
  if (!appPath) {
    console.warn('[InterpreterOverlay] active app icon missing bundle path', { pid });
    return null;
  }

  const appIconDataUrl = await resolveMacBundleIconDataUrl(appPath);
  if (!appIconDataUrl) {
    console.warn('[InterpreterOverlay] active app icon unavailable from bundle', { pid, appBundlePath: appPath });
  }
  return appIconDataUrl;
}

export function buildReferenceContextPrompt(contextItems: OverlayContextItem[], prompt: string): string {
  const packet = buildOverlayContextPacketText(contextItems).trim();
  if (!packet) {
    return prompt;
  }
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt ? `${packet}\n\n${trimmedPrompt}` : packet;
}

function isOverlayTextFileContext(mimeType: string, filePath: string | null, name: string): boolean {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.startsWith('text/') || OVERLAY_FILE_CONTEXT_TEXT_MIME_TYPES.has(normalizedMimeType)) {
    return true;
  }
  const extensionSource = filePath || name;
  return OVERLAY_FILE_CONTEXT_TEXT_EXTENSIONS.has(path.extname(extensionSource).toLowerCase());
}

function isOverlayPdfFileContext(mimeType: string, filePath: string | null, name: string): boolean {
  return mimeType.toLowerCase() === 'application/pdf'
    || path.extname(filePath || name).toLowerCase() === '.pdf';
}

function isOverlayDocumentFileContext(filePath: string | null, name: string): boolean {
  return OVERLAY_FILE_CONTEXT_DOCUMENT_EXTENSIONS.has(path.extname(filePath || name).toLowerCase());
}

function isOverlayImageFileContext(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

async function normalizeOverlayFileContextItem(file: OverlayFileContextItem): Promise<OverlayFileContextItem> {
  const name = file.name || (file.filePath ? path.basename(file.filePath) : 'Dropped file');
  const mimeType = file.mimeType || 'application/octet-stream';
  const filePath = file.filePath || null;
  let dataUrl = file.dataUrl;
  if (!dataUrl && filePath) {
    const fileStat = await fs.stat(filePath);
    if (fileStat.size <= MAX_OVERLAY_FILE_CONTEXT_DATA_URL_BYTES) {
      const bytes = await fs.readFile(filePath);
      dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
    }
  }
  const normalized: OverlayFileContextItem = {
    ...file,
    id: file.id || `overlay-file-${Date.now()}-${randomUUID()}`,
    kind: 'file',
    role: 'reference',
    name,
    mimeType,
    filePath,
    dataUrl,
    sizeBytes: Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0,
  };

  if (
    isOverlayTextFileContext(mimeType, normalized.filePath, name)
    || isOverlayPdfFileContext(mimeType, normalized.filePath, name)
    || isOverlayDocumentFileContext(normalized.filePath, name)
    || isOverlayImageFileContext(mimeType)
  ) {
    return normalized;
  }

  throw new Error(`Unsupported overlay file "${name}" (${mimeType}). Drop an image, PDF, Word, Excel, text, Markdown, CSV, TSV, or JSON file.`);
}

function extractOverlayReaderText(result: ToolCallResponse): string {
  if (result.isError) {
    const message = result.content
      .map((item) => (typeof item.text === 'string' ? item.text : null))
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(message || 'Attachment reader failed.');
  }

  return result.content
    .map((item) => (typeof item.text === 'string' ? item.text : null))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function withOverlayAttachmentPath<T>(
  attachment: Pick<OverlayUserAttachment, 'id' | 'name' | 'mimeType' | 'dataUrl' | 'filePath'>,
  callback: (filePath: string) => Promise<T>,
): Promise<T> {
  if (attachment.filePath) {
    return await callback(attachment.filePath);
  }

  if (!attachment.dataUrl) {
    throw new Error(`Attachment "${attachment.name}" does not have local readable data.`);
  }

  const parsed = parseBase64DataUrl(attachment.dataUrl);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interpreter-overlay-attachment-'));
  const extension = path.extname(attachment.name).toLowerCase() || '.bin';
  const tempPath = path.join(tempDir, `attachment${extension}`);
  try {
    await fs.writeFile(tempPath, parsed.buffer);
    return await callback(tempPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function readOverlayAttachmentText(
  attachment: Pick<OverlayUserAttachment, 'id' | 'name' | 'mimeType' | 'dataUrl' | 'filePath'>,
): Promise<string> {
  const filePath = attachment.filePath ?? null;
  const name = attachment.name || 'Attachment';
  const mimeType = attachment.mimeType || 'application/octet-stream';
  const extension = path.extname(filePath || name).toLowerCase();

  if (isOverlayTextFileContext(mimeType, filePath, name)) {
    if (attachment.dataUrl) {
      return parseBase64DataUrl(attachment.dataUrl).buffer.toString('utf8').trim();
    }
    if (!filePath) {
      throw new Error(`Text attachment "${name}" does not have readable local data.`);
    }
    return (await fs.readFile(filePath, 'utf8')).trim();
  }

  if (isOverlayPdfFileContext(mimeType, filePath, name)) {
    return await withOverlayAttachmentPath(attachment, async (readPath) =>
      extractOverlayReaderText(await readPdfTool.handler({ path: readPath })),
    );
  }

  if (extension === '.docx') {
    return await withOverlayAttachmentPath(attachment, async (readPath) =>
      extractOverlayReaderText(await readWordTool.handler({ path: readPath })),
    );
  }

  if (['.xlsx', '.xls', '.xlsm'].includes(extension)) {
    return await withOverlayAttachmentPath(attachment, readSpreadsheetAttachment);
  }

  throw new Error(`Attachment "${name}" (${mimeType}) is not readable as text.`);
}

function tokenizeAttachmentQuery(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3),
  ));
}

export function buildAttachmentQueryChunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  const maxLength = 2200;
  const overlap = 220;
  for (let start = 0; start < normalized.length; start += maxLength - overlap) {
    chunks.push(normalized.slice(start, start + maxLength).trim());
    if (start + maxLength >= normalized.length) {
      break;
    }
  }
  return chunks;
}

/**
 * Shared query_attachments implementation for both controller transports
 * (GPT-realtime voice bridge and typed fast loop): answer a focused question
 * from the locally attached selected-file/selected-text context items.
 */
export async function queryOverlayAttachments(
  contextItems: OverlayContextItem[],
  argumentsJson: string,
): Promise<string> {
  const parsed = JSON.parse(argumentsJson || '{}') as {
    question?: unknown;
    attachment_ids?: unknown;
  };
  const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
  if (!question) {
    throw new Error('query_attachments requires a question.');
  }
  const requestedIds = Array.isArray(parsed.attachment_ids)
    ? new Set(parsed.attachment_ids.filter((id): id is string => typeof id === 'string'))
    : null;
  const attachmentItems = contextItems.filter((item): item is OverlayFileContextItem => (
    item.kind === 'file'
    && (!requestedIds || requestedIds.has(item.id))
  ));
  if (attachmentItems.length === 0) {
    return JSON.stringify({
      status: 'no_attachments',
      question,
      answer: 'No selected files or selected text are attached to this overlay session.',
      attachments: [],
    });
  }

  const results: Array<{
    id: string;
    name: string;
    mimeType: string;
    sourceKind: string;
    status: 'ok' | 'image' | 'error' | 'empty';
    snippets?: string[];
    error?: string;
  }> = [];

  for (const item of attachmentItems) {
    const mimeType = item.mimeType || 'application/octet-stream';
    if (mimeType.toLowerCase().startsWith('image/')) {
      results.push({
        id: item.id,
        name: item.name,
        mimeType,
        sourceKind: item.sourceKind ?? 'unknown',
        status: 'image',
        snippets: [
          'This is an image attachment. Visual attachment querying is not available in this text-only tool yet.',
        ],
      });
      continue;
    }

    try {
      const text = await readOverlayAttachmentText({
        id: item.id,
        name: item.name,
        mimeType,
        dataUrl: item.dataUrl,
        filePath: item.filePath ?? undefined,
      });
      const chunks = buildAttachmentQueryChunks(text);
      if (chunks.length === 0) {
        results.push({
          id: item.id,
          name: item.name,
          mimeType,
          sourceKind: item.sourceKind ?? 'unknown',
          status: 'empty',
          snippets: [],
        });
        continue;
      }
      const ranked = rankAttachmentQueryChunks(chunks, question)
        .filter((entry, index) => entry.score > 0 || index === 0)
        .slice(0, 4)
        .map((entry) => entry.chunk);
      results.push({
        id: item.id,
        name: item.name,
        mimeType,
        sourceKind: item.sourceKind ?? 'unknown',
        status: 'ok',
        snippets: ranked,
      });
    } catch (error) {
      results.push({
        id: item.id,
        name: item.name,
        mimeType,
        sourceKind: item.sourceKind ?? 'unknown',
        status: 'error',
        error: getErrorMessage(error),
      });
    }
  }

  const okSnippets = results.flatMap((result) => result.snippets ?? []);
  return JSON.stringify({
    status: okSnippets.length > 0 ? 'ok' : 'no_text_answer',
    question,
    instruction: 'Answer the user from these local attachment snippets. If the needed fact is absent, say it is not present in the selected attachments.',
    attachments: results,
  });
}

export function rankAttachmentQueryChunks(chunks: string[], question: string): Array<{ chunk: string; score: number; index: number }> {
  const tokens = tokenizeAttachmentQuery(question);
  return chunks
    .map((chunk, index) => {
      const lower = chunk.toLowerCase();
      const score = tokens.length === 0
        ? (index === 0 ? 1 : 0)
        : tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
      return { chunk, score, index };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });
}

async function sendCdpCommand(
  ws: any,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<any> {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    const onMessage = (raw: unknown) => {
      const message = JSON.parse(String(raw));
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
        return;
      }
      resolve(message.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function withBrowserCdpPage<T>(callback: (ws: any) => Promise<T>): Promise<T | null> {
  const portText = process.env.INTERPRETER_OVERLAY_BROWSER_CDP_PORT;
  const port = portText ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Browser CDP target list failed: ${response.status}`);
  }
  const pages = await response.json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
  const preferredUrlNeedle = process.env.INTERPRETER_OVERLAY_BROWSER_CDP_TARGET_URL_CONTAINS;
  const availablePages = pages.filter((candidate) => (
    candidate.type === 'page'
    && candidate.webSocketDebuggerUrl
    && !String(candidate.url ?? '').startsWith('devtools://')
  ));
  const page = (
    preferredUrlNeedle
      ? availablePages.find((candidate) => String(candidate.url ?? '').includes(preferredUrlNeedle))
      : null
  ) ?? availablePages[0];
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No browser CDP page target available on port ${port}.`);
  }
  const ws = new WsWebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  try {
    console.log('[InterpreterOverlay] Using browser CDP page for region text', {
      url: page.url ?? null,
      targetUrlNeedle: preferredUrlNeedle || null,
    });
    return await callback(ws);
  } finally {
    ws.close();
  }
}

async function extractBrowserRegionText(absoluteBounds: Bounds): Promise<string | null> {
  return await withBrowserCdpPage<string | null>(async (ws) => {
    await sendCdpCommand(ws, 'Page.bringToFront', {}, 5000);
    const result = await sendCdpCommand(ws, 'Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const absolute = ${JSON.stringify({
          x: absoluteBounds.x,
          y: absoluteBounds.y,
          width: absoluteBounds.width,
          height: absoluteBounds.height,
        })};
        const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
        const chromeTop = Math.max(0, (window.outerHeight - window.innerHeight) - chromeX);
        const viewport = {
          left: absolute.x - window.screenX - chromeX,
          top: absolute.y - window.screenY - chromeTop,
          right: absolute.x - window.screenX - chromeX + absolute.width,
          bottom: absolute.y - window.screenY - chromeTop + absolute.height,
        };
        const intersects = (rect) => (
          rect.width > 0
          && rect.height > 0
          && rect.right >= viewport.left
          && rect.left <= viewport.right
          && rect.bottom >= viewport.top
          && rect.top <= viewport.bottom
        );
        const centerInside = (rect) => {
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return x >= viewport.left && x <= viewport.right && y >= viewport.top && y <= viewport.bottom;
        };
        const visible = (element) => {
          const style = window.getComputedStyle(element);
          return style.visibility !== 'hidden'
            && style.display !== 'none'
            && Number(style.opacity || '1') > 0;
        };
        const elementText = (element) => {
          if (element instanceof HTMLSelectElement) {
            return element.selectedOptions[0]?.textContent || element.value || '';
          }
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return element.value || element.getAttribute('placeholder') || '';
          }
          return element.textContent || '';
        };
        const controlCandidates = [];
        const pushElement = (element) => {
          if (!(element instanceof HTMLElement) || !visible(element)) return;
          const rect = element.getBoundingClientRect();
          if (!intersects(rect)) return;
          const text = String(elementText(element)).replace(/\\s+/g, ' ').trim();
          if (text.length < 2) return;
          controlCandidates.push({ text, area: Math.max(1, rect.width * rect.height), length: text.length });
        };
        for (const element of Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]')).slice(0, 1000)) {
          if (!(element instanceof HTMLElement) || !visible(element)) continue;
          const rect = element.getBoundingClientRect();
          if (!intersects(rect) && !centerInside(rect)) continue;
          pushElement(element);
        }
        if (controlCandidates.length > 0) {
          controlCandidates.sort((a, b) => b.length - a.length || a.area - b.area);
          return controlCandidates.map((candidate) => candidate.text).join('\\n');
        }
        const candidates = [];
        const pushTextElement = (element) => {
          if (!(element instanceof HTMLElement) || !visible(element)) return;
          const rect = element.getBoundingClientRect();
          if (!intersects(rect)) return;
          const text = String(elementText(element)).replace(/\\s+/g, ' ').trim();
          if (text.length < 2) return;
          candidates.push({ text, area: Math.max(1, rect.width * rect.height), length: text.length });
        };
        const sampleColumns = 6;
        const sampleRows = 6;
        for (let yIndex = 0; yIndex < sampleRows; yIndex += 1) {
          const y = viewport.top + ((viewport.bottom - viewport.top) * (yIndex + 0.5)) / sampleRows;
          for (let xIndex = 0; xIndex < sampleColumns; xIndex += 1) {
            const x = viewport.left + ((viewport.right - viewport.left) * (xIndex + 0.5)) / sampleColumns;
            for (const element of document.elementsFromPoint(x, y)) {
              if (element === document.body || element === document.documentElement) continue;
              pushTextElement(element);
              break;
            }
          }
        }
        candidates.sort((a, b) => b.length - a.length || a.area - b.area);
        const selected = [];
        for (const candidate of candidates) {
          if (selected.some((text) => text.includes(candidate.text))) continue;
          if (selected.some((text) => candidate.text.includes(text))) {
            for (let i = selected.length - 1; i >= 0; i -= 1) {
              if (candidate.text.includes(selected[i])) selected.splice(i, 1);
            }
          }
          selected.push(candidate.text);
          if (selected.join('\\n').length > 4000) break;
        }
        return selected.join('\\n');
      })()`,
    }, 1500);
    const value = result?.result?.value;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  });
}

function overlaySupportsAccessibilityContext(): boolean {
  return OVERLAY_AX_MODE;
}

function toReviewAction(
  action: Action,
  display: DisplayInfo,
  scopeBounds: Bounds | null,
): ReviewAction {
  const bbox = action.bbox;
  let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  const localViewport = getLocalViewport(display, scopeBounds);

  if (bbox) {
    bounds = relativeBBoxToBoundsInViewport(bbox, localViewport);
  } else if (action.visionAnchorPx) {
    // Vision anchors are already in display DIP coordinates by the time they
    // reach the renderer bridge. Convert them into overlay-local coordinates
    // by subtracting the display origin only; do not apply any scale transform.
    const localX = action.visionAnchorPx.x - display.boundsDIP.x;
    const localY = action.visionAnchorPx.y - display.boundsDIP.y;
    bounds = {
      x: localX - 8,
      y: localY - 8,
      width: 16,
      height: 16,
    };
  }

  let description = '';
  let detail = '';
  if (action.tool === 'click' || action.tool === 'type') {
    const params = action.params as { element_description?: string; element_id?: string; clear_first?: boolean };
    description = params.element_description ?? action.resolvedLabel ?? (params.element_id ? `Element ${params.element_id}` : '');
    const detailParts: string[] = [];
    if (params.element_id) {
      detailParts.push(`id ${params.element_id}`);
    }
    if (action.tool === 'type' && params.clear_first) {
      detailParts.push('replace existing text');
    }
    if (action.resolvedLabel && action.resolvedLabel !== description) {
      detailParts.push(action.resolvedLabel);
    }
    if (bbox) {
      detailParts.push(
        `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)}`,
      );
    }
    detail = detailParts.join('  ');
  } else if (action.tool === 'hotkey') {
    const params = action.params as { hotkey?: string };
    description = `Press ${params.hotkey?.trim() || 'invalid hotkey'}`;
  }

  return {
    id: action.id,
    type: action.tool as 'click' | 'type' | 'hotkey' | 'scroll',
    description,
    detail,
    bounds,
    hasBounds: Boolean(bbox || action.visionAnchorPx),
    centerColor: action.centerColor,
    text: action.tool === 'type' ? (action.params as { text: string }).text : undefined,
    currentValue: action.tool === 'type' ? action.currentValue : undefined,
    keys: action.tool === 'hotkey' ? (action.params as { hotkey?: string }).hotkey?.trim() : undefined,
  };
}

function toSelectableElement(
  element: ScreenElement,
  display: DisplayInfo,
  scopeBounds: Bounds | null = null,
): OverlaySelectionElement | null {
  void scopeBounds;
  const elementBounds = element.bbox;
  const clipped = intersectBounds(elementBounds, display.boundsDIP);
  if (!clipped) {
    return null;
  }

  return {
    id: element.id,
    role: element.role,
    label: element.label,
    bounds: toLocalBounds(clipped, display.boundsDIP),
  };
}

function isBrowserControlAppLabel(value: string): boolean {
  return /\b(google chrome|chrome|chromium|brave browser|brave|microsoft edge|edge)\b/i.test(value);
}

function selectActiveBrowserTabForOverlayTarget(
  status: BrowserControlStatus,
  target: WindowInfo,
): {
  tabRef: string;
  chromeTabId: number;
  profileId: string;
  windowId: number;
  url: string;
  title: string;
} | null {
  if (!isBrowserControlAppLabel(`${target.ownerName} ${target.title}`)) {
    return null;
  }
  for (const connection of status.connections) {
    const tab = connection.focusedWindow?.tabs.find((candidate) => candidate.active)
      ?? connection.activeTab;
    if (tab) {
      return {
        tabRef: tab.tabRef,
        chromeTabId: tab.chromeTabId,
        profileId: connection.profileId,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title,
      };
    }
  }
  return null;
}

export interface InterpreterOverlayServiceOptions {
  showMainWindow: () => void;
  createWorkstationWindow: (options?: {
    sourceWindowId?: number | null;
    workspacePath?: string | null;
    background?: boolean;
  }) => Promise<
    | { success: true; windowId: number; sessionKey: string }
    | { success: false; error: string }
  >;
  benchmarkMode?: boolean;
  onTrayStateChanged?: (state: InterpreterOverlayTrayState) => void;
}

export interface InterpreterOverlayDebugStatus {
  started: boolean;
  runtimeActive: boolean;
  authenticated: boolean;
  overlayWindowCount: number;
  visibleOverlayWindowCount: number;
  overlayCaptureSuppressed: boolean;
  overlayWindows: Array<{
    id: number;
    visible: boolean;
    focused: boolean;
    title: string;
    url: string;
    bounds: Electron.Rectangle;
  }>;
  worldWindow: ReturnType<import('./world-overlay-window.js').WorldOverlayWindow['getDebugSnapshot']>;
  lastVisualHealth: OverlayVisualHealth | null;
  lastVisualBlankSince: number | null;
  visualHealthRecoveryCount: number;
  lastVisualHealthRecoveryAt: number | null;
  lastWorldVisualHealth: OverlayVisualHealth | null;
  progressiveBlurHandoffPending: boolean;
  progressiveBlurClosePending: boolean;
  presentationTimings: InterpreterOverlayPresentationTimings;
  progressiveBlur: ProgressiveBlurDebugState;
  run: InterpreterOverlayDebugRunState;
  lastWorkspaceAgentLaunch: InterpreterOverlayWorkspaceAgentLaunchDebug | null;
  voice: {
    active: boolean;
    startedAt: number | null;
    stoppedAt: number | null;
  };
  advancedVoice: InterpreterOverlayAdvancedVoiceDebugState;
}

export interface InterpreterOverlayAdvancedVoiceDebugState {
  active: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
  createCallRequestedAt: number | null;
  createCallSucceededAt: number | null;
  createCallError: string | null;
  testAudioRequestedAt: number | null;
  testAudioPath: string | null;
  testAudioBytes: number | null;
  audioEvents: Array<{
    type: string;
    segmentIndex: number | null;
    at: number;
  }>;
  toolCalls: Array<{
    name: string;
    receivedAt: number;
    argumentsLength: number;
    argumentsPreview?: string;
    resultPreview?: string;
    error?: string;
  }>;
}

export interface InterpreterOverlayPresentationTimings {
  cycleId: number;
  source: OverlayOpenSource | null;
  phase: OverlayPresentationPhase;
  closeReason: string | null;
  openRequestedAt: number | null;
  reactVisibleAt: number | null;
  inputReadyAt: number | null;
  activeAppTargetAttachedAt: number | null;
  closeRequestedAt: number | null;
  reactHiddenAt: number | null;
  blurShowCommandAt: number | null;
  blurShownAt: number | null;
  blurHideCommandAt: number | null;
  blurHiddenAt: number | null;
  durationsMs: {
    openToReactVisible: number | null;
    openToInputReady: number | null;
    openToActiveAppTarget: number | null;
    openToBlurShown: number | null;
    closeToReactHidden: number | null;
    closeToBlurHidden: number | null;
    blurShowCommandToShown: number | null;
    blurHideCommandToHidden: number | null;
  };
}

export type InterpreterOverlayDebugRunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'start_failed';

export interface InterpreterOverlayDebugRunState {
  id: number;
  status: InterpreterOverlayDebugRunStatus;
  reason: string | null;
  finalText: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface InterpreterOverlayCapturedContext {
  agentMode: typeof INTERPRETER_OVERLAY_AGENT_MODE;
  formattedText: string;
  elementCount: number;
  elements: ScreenElement[];
  screenshotBase64?: string;
  screenshotPath?: string;
  displayScaleFactor?: number;
  displayBoundsDIP?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  captureBoundsDIP?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  targetIdentity?: OverlayTargetIdentity;
  currentSelectionContext?: CurrentSelectionContext;
}

export interface InterpreterOverlayAgentDebugContext extends RunEngineDebugContext {
  finalText: string | null;
  runStatus: InterpreterOverlayDebugRunStatus;
  runReason: string | null;
  automationDebugTrace: AutomationDebugEvent[];
  transcriptDebugTrace: OverlayTranscriptDebugEvent[];
}

export interface InterpreterOverlayWorkspaceAgentLaunchDebug {
  agentId: string;
  callerToken: string;
  overlaySessionId: string | null;
  profileId: string;
  workspacePath: string | null;
  targetWindowSessionKey: string;
  targetWindowId: number;
  scopeBoundsDIP: Bounds | null;
  startupAttachmentCount: number;
  initialElementCount: number;
  hasInitialScreenshot: boolean;
  initialScreenshotPath: string | null;
  launchedAt: number;
}

interface GlobalScopeGesture {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  role: OverlayContextRole;
  loggedFirstMove: boolean;
  startedAt: number;
  lastActivityAt: number;
}

const GLOBAL_SCOPE_GESTURE_STALE_TIMEOUT_MS = 8000;
const GLOBAL_SCOPE_GESTURE_ACTIVE_STALE_TIMEOUT_MS = 30000;
// A pure click must stay click-through; only a real region-selection drag may
// capture the mouse so the drag stops driving the app underneath.
const REGION_DRAG_CAPTURE_THRESHOLD_DIP = 4;

export class InterpreterOverlayService {
  private readonly overlay = new OverlayWindow((details) => {
    void this.handleOverlayRendererGone(details);
  });
  private readonly baseUrl = getInterpreterOverlayBaseUrl();
  private readonly showMainWindow: () => void;
  private readonly createWorkstationWindow: InterpreterOverlayServiceOptions['createWorkstationWindow'];
  private readonly onTrayStateChanged: ((state: InterpreterOverlayTrayState) => void) | null;
  private readonly acceptCallbacks: Array<() => void> = [];
  private readonly acceptAllCallbacks: Array<() => void> = [];
  private readonly acceptAllSessionCallbacks: Array<() => void> = [];
  private readonly rejectCallbacks: Array<() => void> = [];
  private readonly progressiveBlur: ProgressiveBlur;
  private readonly benchmarkMode: boolean;
  private engine: RunEngine | null = null;
  private input: Input | null = null;
  private capture: Capture | null = null;
  private stt: ExtendedSTTPort | null = null;
  private automation: Automation | null = null;
  private overlayState: OverlayState = { ...DEFAULT_OVERLAY_STATE };
  private voiceRecordingTimer: NodeJS.Timeout | null = null;
  private voiceRecordingTimerGeneration = 0;
  private isVoiceInputActive = false;
  private hotkeyInputOpenedAt: number | null = null;
  private lastControlDownAt: number | null = null;
  private lastControlHoldDurationMs: number | null = null;
  private lastControlUpAt: number | null = null;
  private lastCtrlSpaceDownAt: number | null = null;
  private lastCtrlSpaceHoldDurationMs: number | null = null;
  private lastCtrlSpaceUpAt: number | null = null;
  private pendingActiveAppTargetAttach: Promise<void> | null = null;
  private lastRemovedTargetContext: OverlayRegionContextItem | null = null;
  private overlayTextManagedContext: OverlayTextControllerManagedContext | null = null;
  private overlayApprovalAgentIds = new Set<string>();
  private globalApprovalPollTimer: NodeJS.Timeout | null = null;
  private agentDashboardPollTimer: NodeJS.Timeout | null = null;
  private agentTabCompletionCleanup: (() => void) | null = null;
  private readonly advancedVoice = new AdvancedVoiceController({
    baseUrl: this.baseUrl,
    overlayApprovalAgentIds: this.overlayApprovalAgentIds,
    getOverlayState: () => this.overlayState,
    getEffectiveSettings: () => this.effectiveSettings,
    getEngine: () => this.engine,
    getCapture: () => this.capture,
    getInteractionDisplay: () => this.interactionDisplay,
    setInteractionDisplay: (display) => {
      this.interactionDisplay = display;
    },
    setScopeBounds: (bounds) => {
      this.scopeBounds = bounds;
    },
    getLastRemovedTargetContext: () => this.lastRemovedTargetContext,
    getActiveAttachedSessionId: () => this.activeAttachedSessionId,
    getVoiceRecordingStartedAt: () => this.voiceRecordingStartedAt,
    setVoiceRecordingStartedAt: (value) => {
      this.voiceRecordingStartedAt = value;
    },
    setVoiceInputUsed: (value) => {
      this.voiceInputUsed = value;
    },
    send: (partial) => {
      this.send(partial);
    },
    beginAdvancedVoicePlanningVisual: async () => {
      // Voice planning window: pin the world overlay to the committed target
      // and enter the working (thinking sheen) presentation until a staged
      // batch review or the response end replaces it.
      if (!this.pinnedTarget) {
        await this.beginPinningWorldOverlayToTarget();
      }
      if (this.overlayState.mode === 'review' || this.overlayState.action) {
        return;
      }
      this.send({ mode: 'working', action: null, ghosts: [], pill: { kind: 'loading' } });
    },
    endAdvancedVoicePlanningVisual: () => {
      // Only clear the planning shape; a staged review or executing action
      // owns the overlay state at that point.
      if (this.overlayState.mode !== 'working' || this.overlayState.action) {
        return;
      }
      this.send({ mode: 'idle', pill: { kind: 'hidden' } });
    },
    trackOverlayEvent: (event, data) => {
      this.trackOverlayEvent(event, data);
    },
    cancelVoiceTimer: () => {
      this.cancelVoiceTimer();
    },
    startGlobalApprovalPoller: () => {
      this.startGlobalApprovalPoller();
    },
    stopGlobalApprovalPoller: () => {
      this.stopGlobalApprovalPoller();
    },
    onAdvancedVoiceStopped: (sessionKind) => {
      if (
        sessionKind !== 'onboarding_voice_interview'
        || !this.onboardingVoiceRuntimeActivated
      ) {
        return;
      }
      this.onboardingVoiceRuntimeActivated = false;
      queueMicrotask(() => {
        if (!this.effectiveSettings.enabled && !this.advancedVoice.isAdvancedVoiceInputActive) {
          this.deactivateRuntime();
        }
      });
    },
    waitForMatchingTargetContextHydration: async (bounds) =>
      await this.waitForMatchingTargetContextHydration(bounds),
    captureContextForScope: async (options) => await this.captureContextForScope(options),
    buildOverlayWholeComputerState: async (input) => await this.buildOverlayWholeComputerState(input),
    ensureExecutableContextForTarget: async (targetContext) =>
      await this.ensureExecutableContextForTarget(targetContext),
    createAgentToolSession: async (options) => await this.createAgentToolSession(options),
    resolveOverlayTargetWindow: async (workspacePath, targetWindowSessionKey) =>
      await this.resolveOverlayTargetWindow(workspacePath, targetWindowSessionKey),
    resolveHiddenAgentProfile: async () => await this.resolveHiddenAgentProfile(),
    resolveOverlayAgentProfileByModelSetting: async (requested, missingMessage) =>
      await this.resolveOverlayAgentProfileByModelSetting(requested, missingMessage),
    persistOverlayUserAttachmentMentions: async (userAttachments) =>
      await this.persistOverlayUserAttachmentMentions(userAttachments),
    buildNormalAgentAttachmentsFromContextItems: (contextItems) =>
      this.buildNormalAgentAttachmentsFromContextItems(contextItems),
    buildOverlayLaunchMessage: (prompt, initialContext, targetContext, attachmentMentions) =>
      this.buildOverlayLaunchMessage(prompt, initialContext, targetContext, attachmentMentions),
    buildOverlaySystemPrompt: async (session) => await this.buildOverlaySystemPrompt(session),
  });
  private started = false;
  private runtimeActive = false;
  private onboardingVoiceRuntimeActivated = false;
  private registeredHotkey: string | null = null;
  private inputOpeningInFlight = false;
  private settingsListenerCleanup: (() => void) | null = null;
  private authListenerCleanup: (() => void) | null = null;
  private currentSettings: InterpreterOverlaySettings = { ...DEFAULT_INTERPRETER_OVERLAY_SETTINGS };
  private effectiveSettings: InterpreterOverlaySettings = { ...DEFAULT_INTERPRETER_OVERLAY_SETTINGS };
  private accessState: InterpreterOverlayAccessState = { allowed: false, reason: 'signed-out' };
  private overlayHiddenForExecution = false;
  private tracePrimaryColor = chooseTracePrimaryColor();
  private activeOverlayDrawingIds = new Set<string>();
  private scopeSelectionInProgress = false;
  private regionDragCaptureActive = false;
  private suppressRegionSelectionUntil = 0;
  private progressiveBlurHandoffPending = false;
  private progressiveBlurClosePending = false;
  private progressiveBlurCloseTimer: NodeJS.Timeout | null = null;
  private worldOverlayCloseTimer: NodeJS.Timeout | null = null;
  private worldOverlayFinalizeTimer: NodeJS.Timeout | null = null;
  private inputFocusRetryTimers = new Set<NodeJS.Timeout>();
  private lastSentOverlayStateSignature: string | null = null;
  private mainWindowFocusSuppressed = false;
  private inputOpenedAt: number | null = null;
  private voiceRecordingStartedAt: number | null = null;
  private voiceRecordingStoppedAt: number | null = null;
  private voiceDraftBase = '';
  private voiceRecordingTranscript = '';
  private voiceInputUsed = false;
  private nextRunSystemAddendum: string | null = null;
  private lastOpenSource: OverlayOpenSource | null = null;
  private interactionDisplay: DisplayInfo | null = null;
  private selectionElements: ScreenElement[] = [];
  private scopedStructuredContext: {
    displayId: string;
    scopeBounds: Bounds;
    formattedText: string;
    elements: ScreenElement[];
  } | null = null;
  private scopeBounds: Bounds | null = null;
  private worldTargetBounds: Bounds | null = null;
  private lastGlobalScopeSelectedAt: number | null = null;
  private lastGlobalScopeLocalBounds: Bounds | null = null;
  private pinnedTarget: {
    pid: number;
    cgWindowId: number;
    initialWindowBounds: { x: number; y: number; width: number; height: number };
    initialScopeAbsolute: Bounds;
    initialActionBoundsAbsolute: Map<string, Bounds>;
    initialVisualProbeAbsolute: Bounds | null;
  } | null = null;
  private globalScopeGesture: GlobalScopeGesture | null = null;
  private globalScopeGestureTimeout: NodeJS.Timeout | null = null;
  private selectionRequestId = 0;
  private selectionPreviewTimer: NodeJS.Timeout | null = null;
  private pendingSelectionPreviewBounds: Bounds | null | undefined;
  private selectionPreviewInFlight = false;
  private inputStripRequestId = 0;
  private hotkeyContextRequestId = 0;
  private pendingInitialHotkeyContextAttach: {
    display: DisplayInfo;
    requestId: number;
    startedAt: number;
  } | null = null;
  private pendingInitialHotkeyContextAttachPromise: Promise<void> | null = null;
  private pendingTargetContextHydration: {
    display: DisplayInfo;
    absoluteBounds: Bounds;
    requestId: number;
    contextId: string;
  } | null = null;
  private pendingTargetContextHydrationPromise: Promise<void> | null = null;
  private pendingNativeCuaRegionSelectionPromise: Promise<OverlaySelectionElement[]> | null = null;
  private runStartedAt: number | null = null;
  private lastRunInputMethod: OverlayRunInputMethod | null = null;
  private lastOverlayVisualHealth: OverlayVisualHealth | null = null;
  private lastInputOverlayControlHealth: OverlayVisualHealth | null = null;
  private lastWorldOverlayVisualHealth: OverlayVisualHealth | null = null;
  private lastOverlayVisualHealthAt: number | null = null;
  private lastInputStateDeliveredAt: number | null = null;
  private lastOverlayVisualBlankSince: number | null = null;
  private lastAnyOverlayVisualHealthAt: number | null = null;
  private overlayRendererReadySince: number | null = null;
  private appSuspensionBlockerId: number | null = null;
  private lastOverlayVisualHealthSignature: string | null = null;
  private overlayVisualExpectationAt: number | null = null;
  private visualHealthWatchdog: NodeJS.Timeout | null = null;
  private emergencyStopWatchdog: NodeJS.Timeout | null = null;
  private visualHealthRecoveryInFlight = false;
  private visualHealthRecoveryCount = 0;
  private lastVisualHealthRecoveryAt: number | null = null;
  private emergencyStopHandling = false;
  private nextDebugRunId = 0;
  private nextPresentationCycleId = 0;
  private worldOverlayPreparedInputCycleId: number | null = null;
  private activeAttachedSessionId: string | null = null;
  private activeAttachedAgentId: string | null = null;
  private presentationTimings: Omit<InterpreterOverlayPresentationTimings, 'durationsMs'> = {
    cycleId: 0,
    source: null,
    phase: 'idle',
    closeReason: null,
    openRequestedAt: null,
    reactVisibleAt: null,
    inputReadyAt: null,
    activeAppTargetAttachedAt: null,
    closeRequestedAt: null,
    reactHiddenAt: null,
    blurShowCommandAt: null,
    blurShownAt: null,
    blurHideCommandAt: null,
    blurHiddenAt: null,
  };
  private debugRunState: InterpreterOverlayDebugRunState = {
    id: 0,
    status: 'idle',
    reason: null,
    finalText: null,
    startedAt: null,
    finishedAt: null,
  };
  private lastWorkspaceAgentLaunch: InterpreterOverlayWorkspaceAgentLaunchDebug | null = null;

  constructor(options: InterpreterOverlayServiceOptions) {
    this.showMainWindow = options.showMainWindow;
    this.createWorkstationWindow = options.createWorkstationWindow;
    this.benchmarkMode = options.benchmarkMode ?? false;
    this.onTrayStateChanged = options.onTrayStateChanged ?? null;
    this.progressiveBlur = new ProgressiveBlur({
      onLifecycleEvent: (event) => {
        this.handleProgressiveBlurLifecycleEvent(event);
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.currentSettings = await getInterpreterOverlaySettings();
    this.settingsListenerCleanup = onInterpreterOverlaySettingsChanged((settings) => {
      void this.applySettings(settings).catch((error) => {
        console.error('[InterpreterOverlay] Failed to apply settings:', error);
      });
    });
    this.agentTabCompletionCleanup ??= agentTabManager.onCompletion((event) => {
      this.advancedVoice.handleAgentTabCompletion(event);
    });
    this.authListenerCleanup = onServerAuthChanged(() => {
      void this.applySettings(this.currentSettings).catch((error) => {
        console.error('[InterpreterOverlay] Failed to refresh auth state:', error);
      });
    });
    await this.applySettings(this.currentSettings);
    this.started = true;
    console.log(
      this.baseUrl
        ? `[InterpreterOverlay] Started using ${this.baseUrl}`
        : '[InterpreterOverlay] Started without a hosted overlay runtime',
    );
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.settingsListenerCleanup?.();
    this.settingsListenerCleanup = null;
    this.authListenerCleanup?.();
    this.authListenerCleanup = null;
    this.agentTabCompletionCleanup?.();
    this.agentTabCompletionCleanup = null;
    this.clearProgressiveBlurCloseTimer();
    this.stopGlobalApprovalPoller();
    this.stopAgentDashboardPoller();
    this.deactivateRuntime();
    this.unregisterHotkey();

    this.overlayState = { ...DEFAULT_OVERLAY_STATE };
    this.lastSentOverlayStateSignature = null;
    this.lastWorkspaceAgentLaunch = null;
    this.advancedVoice.resetAdvancedVoiceDebug();
    this.started = false;
    console.log('[InterpreterOverlay] Stopped');
  }

  getDebugStatus(): InterpreterOverlayDebugStatus {
    const overlayWindows = this.getOverlayDebugWindows();
    return {
      started: this.started,
      runtimeActive: this.runtimeActive,
      authenticated: Boolean(getCurrentServerAccessTokenSync()),
      overlayWindowCount: overlayWindows.length,
      visibleOverlayWindowCount: overlayWindows.filter((window) => window.visible).length,
      overlayCaptureSuppressed: this.overlay.isCaptureSuppressed(),
      overlayWindows,
      worldWindow: this.overlay.getWorldWindow().getDebugSnapshot(),
      lastVisualHealth: this.lastOverlayVisualHealth ? { ...this.lastOverlayVisualHealth } : null,
      lastWorldVisualHealth: this.lastWorldOverlayVisualHealth ? { ...this.lastWorldOverlayVisualHealth } : null,
      lastVisualBlankSince: this.lastOverlayVisualBlankSince,
      visualHealthRecoveryCount: this.visualHealthRecoveryCount,
      lastVisualHealthRecoveryAt: this.lastVisualHealthRecoveryAt,
      progressiveBlurHandoffPending: this.progressiveBlurHandoffPending,
      progressiveBlurClosePending: this.progressiveBlurClosePending,
      presentationTimings: this.getPresentationTimingsSnapshot(),
      progressiveBlur: this.progressiveBlur.getDebugState(),
      run: { ...this.debugRunState },
      lastWorkspaceAgentLaunch: this.lastWorkspaceAgentLaunch
        ? { ...this.lastWorkspaceAgentLaunch }
        : null,
      voice: {
        active: this.isVoiceInputActive,
        startedAt: this.isVoiceInputActive ? this.voiceRecordingStartedAt : null,
        stoppedAt: this.voiceRecordingStoppedAt,
      },
      advancedVoice: {
        ...this.advancedVoice.advancedVoiceDebug,
        audioEvents: this.advancedVoice.advancedVoiceDebug.audioEvents.map((event) => ({ ...event })),
        toolCalls: this.advancedVoice.advancedVoiceDebug.toolCalls.map((toolCall) => ({ ...toolCall })),
      },
    };
  }

  private getOverlayDebugWindows(): InterpreterOverlayDebugStatus['overlayWindows'] {
    return BrowserWindow.getAllWindows()
      .filter((window) => window.getTitle() === 'Interpreter Overlay' || window.getTitle() === 'Interpreter World Overlay')
      .filter((window) => window.getTitle() !== 'Interpreter World Overlay' || window.isVisible() || this.overlayState.worldPinActive)
      .map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
        title: window.getTitle(),
        url: window.webContents.isDestroyed() ? '' : window.webContents.getURL(),
        bounds: window.getBounds(),
      }));
  }

  getTrayState(): InterpreterOverlayTrayState {
    const runningAgents = this.overlayState.runningAgents.map((agent) => ({
      agentId: agent.agentId,
      label: agent.label,
      latestAction: agent.latestAction,
    }));
    return {
      enabled: this.accessState.allowed && this.effectiveSettings.enabled && this.runtimeActive,
      accelerator: this.registeredHotkey,
      runningAgents,
    };
  }

  setDebugVisualProbe(probe: OverlayVisualProbe | null): void {
    if (!FORM_TESTS_MODE) {
      throw new Error('debug visual probes are only available in form tests mode');
    }

    const normalizedProbe = probe
      ? {
          ...probe,
          bounds: {
            x: Math.round(probe.bounds.x),
            y: Math.round(probe.bounds.y),
            width: Math.round(probe.bounds.width),
            height: Math.round(probe.bounds.height),
          },
        }
      : null;

    if (this.pinnedTarget && this.interactionDisplay) {
      this.pinnedTarget.initialVisualProbeAbsolute = normalizedProbe
        ? toAbsoluteBounds(normalizedProbe.bounds, this.interactionDisplay.boundsDIP)
        : null;
    }

    console.log('[InterpreterOverlay] debug visual probe', {
      enabled: Boolean(normalizedProbe),
      bounds: normalizedProbe?.bounds ?? null,
      hasPinnedTarget: Boolean(this.pinnedTarget),
      interactionDisplay: this.interactionDisplay?.boundsDIP ?? null,
      initialVisualProbeAbsolute: this.pinnedTarget?.initialVisualProbeAbsolute ?? null,
    });
    this.send({ debugVisualProbe: normalizedProbe });
  }

  async showOverlayFromTray(): Promise<void> {
    await this.showInputMode(false);
  }

  async startWindowVoiceMode(
    request?: { selectedText?: string | null; sessionKind?: AdvancedVoiceSessionKind },
  ): Promise<{ success: boolean; error?: string }> {
    const sessionKind = request?.sessionKind ?? 'advanced_voice';
    const isOnboardingInterview = sessionKind === 'onboarding_voice_interview';
    if (
      !this.effectiveSettings.advancedVoiceEnabled
      && !isOnboardingInterview
    ) {
      return { success: false, error: 'Advanced voice mode is disabled in Overlay settings.' };
    }
    if (this.advancedVoice.isAdvancedVoiceInputActive) {
      return { success: true };
    }

    const activateOnboardingRuntime = isOnboardingInterview && !this.runtimeActive;
    if (activateOnboardingRuntime) {
      await this.activateRuntime();
      this.onboardingVoiceRuntimeActivated = true;
    }

    await this.showInputMode(false, {
      loadSelectionElements: false,
      allowDisabledRuntime: isOnboardingInterview,
    });
    if (this.overlayState.mode !== 'input') {
      if (activateOnboardingRuntime) {
        this.onboardingVoiceRuntimeActivated = false;
        this.deactivateRuntime();
      }
      return { success: false, error: 'Interpreter Overlay input mode is not available.' };
    }

    const selectedText = request?.selectedText?.trim();
    const selectedTextContextItems = selectedText
      ? [createSelectedTextContextItem(selectedText, null, this.interactionDisplay?.id ?? null)]
      : [];

    this.send({
      transcript: '',
      screenshot: null,
      scopeBounds: null,
      draftScopeBounds: null,
      selectableElements: [],
      contextItems: selectedTextContextItems,
      targetContextId: null,
      activeRegionRole: 'target',
    });
    this.advancedVoice.startAdvancedVoiceInput('button', sessionKind);
    return { success: true };
  }

  revealAgentFromTray(agentId: string): void {
    agentTabManager.requestAgentWindowReveal(agentId);
    this.refreshAgentDashboardState();
  }

  stopAgentFromTray(agentId: string): void {
    agentTabManager.requestAgentWindowStop(agentId);
    this.refreshAgentDashboardState();
  }

  private emitTrayStateChanged(): void {
    this.onTrayStateChanged?.(this.getTrayState());
  }

  private beginDebugRun(): void {
    this.nextDebugRunId += 1;
    this.debugRunState = {
      id: this.nextDebugRunId,
      status: 'running',
      reason: null,
      finalText: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.syncEmergencyStopWatchdog();
  }

  private finishDebugRun(
    status: Exclude<InterpreterOverlayDebugRunStatus, 'idle' | 'running'>,
    finalText: string,
    reason: string | null,
  ): void {
    this.debugRunState = {
      id: this.debugRunState.id,
      status,
      reason,
      finalText,
      startedAt: this.debugRunState.startedAt,
      finishedAt: Date.now(),
    };
    this.syncEmergencyStopWatchdog();
  }

  private trackOverlayEvent(event: string, data: Record<string, unknown> = {}): void {
    console.log('[InterpreterOverlay] event', { event, ...data });
  }

  private async recordOverlayFirstSuccessfulUse(): Promise<void> {
    const state = await getOnboardingState();
    const nextState = markOnboardingStepIdComplete(state, ONBOARDING_OVERLAY_FIRST_SUCCESS_STEP_ID);
    if (nextState === state) {
      return;
    }
    await setOnboardingState(nextState);
  }

  private trackOverlayError(
    errorType: string,
    error: string,
    context: Record<string, unknown> = {},
  ): void {
    console.warn('[InterpreterOverlay] error', {
      errorType,
      error,
      surface: 'overlay',
      ...context,
    });
  }

  private getPresentationTimingsSnapshot(): InterpreterOverlayPresentationTimings {
    const snapshot = { ...this.presentationTimings };
    return {
      ...snapshot,
      durationsMs: {
        openToReactVisible: this.computeDurationMs(snapshot.openRequestedAt, snapshot.reactVisibleAt),
        openToInputReady: this.computeDurationMs(snapshot.openRequestedAt, snapshot.inputReadyAt),
        openToActiveAppTarget: this.computeDurationMs(snapshot.openRequestedAt, snapshot.activeAppTargetAttachedAt),
        openToBlurShown: this.computeDurationMs(snapshot.openRequestedAt, snapshot.blurShownAt),
        closeToReactHidden: this.computeDurationMs(snapshot.closeRequestedAt, snapshot.reactHiddenAt),
        closeToBlurHidden: this.computeDurationMs(snapshot.closeRequestedAt, snapshot.blurHiddenAt),
        blurShowCommandToShown: this.computeDurationMs(snapshot.blurShowCommandAt, snapshot.blurShownAt),
        blurHideCommandToHidden: this.computeDurationMs(snapshot.blurHideCommandAt, snapshot.blurHiddenAt),
      },
    };
  }

  private computeDurationMs(start: number | null, end: number | null): number | null {
    if (start === null || end === null) {
      return null;
    }

    return Math.max(0, end - start);
  }

  private beginPresentationTiming(source: OverlayOpenSource): void {
    this.nextPresentationCycleId += 1;
    this.presentationTimings = {
      cycleId: this.nextPresentationCycleId,
      source,
      phase: 'opening',
      closeReason: null,
      openRequestedAt: Date.now(),
      reactVisibleAt: null,
      inputReadyAt: null,
      activeAppTargetAttachedAt: null,
      closeRequestedAt: null,
      reactHiddenAt: null,
      blurShowCommandAt: null,
      blurShownAt: null,
      blurHideCommandAt: null,
      blurHiddenAt: null,
    };
    console.log('[InterpreterOverlay] timing', {
      cycleId: this.presentationTimings.cycleId,
      event: 'open_requested',
      source,
    });
  }

  private notePresentationMilestone(
    key:
      | 'reactVisibleAt'
      | 'inputReadyAt'
      | 'activeAppTargetAttachedAt'
      | 'closeRequestedAt'
      | 'reactHiddenAt'
      | 'blurShowCommandAt'
      | 'blurShownAt'
      | 'blurHideCommandAt'
      | 'blurHiddenAt',
    at: number,
    details: Record<string, unknown> = {},
  ): void {
    if (this.presentationTimings.cycleId === 0 || this.presentationTimings[key] !== null) {
      return;
    }

    this.presentationTimings[key] = at;

    if (key === 'reactVisibleAt' || key === 'inputReadyAt') {
      this.presentationTimings.phase = 'open';
    } else if (key === 'closeRequestedAt') {
      this.presentationTimings.phase = 'closing';
    } else if (key === 'reactHiddenAt') {
      this.presentationTimings.phase = 'idle';
    }

    const snapshot = this.getPresentationTimingsSnapshot();
    console.log('[InterpreterOverlay] timing', {
      cycleId: snapshot.cycleId,
      source: snapshot.source,
      event: key,
      openToReactVisibleMs: snapshot.durationsMs.openToReactVisible,
      openToInputReadyMs: snapshot.durationsMs.openToInputReady,
      openToBlurShownMs: snapshot.durationsMs.openToBlurShown,
      closeToReactHiddenMs: snapshot.durationsMs.closeToReactHidden,
      closeToBlurHiddenMs: snapshot.durationsMs.closeToBlurHidden,
      blurShowCommandToShownMs: snapshot.durationsMs.blurShowCommandToShown,
      blurHideCommandToHiddenMs: snapshot.durationsMs.blurHideCommandToHidden,
      ...details,
    });
  }

  private prepareWorldOverlayAfterInputReady(): void {
    if (this.overlayState.mode !== 'input' || this.presentationTimings.cycleId === 0) {
      return;
    }
    if (this.worldOverlayPreparedInputCycleId === this.presentationTimings.cycleId) {
      return;
    }
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return;
    }

    const electronDisplay = this.getElectronDisplay(this.interactionDisplay);
    if (!electronDisplay) {
      return;
    }

    const inputCycleId = this.presentationTimings.cycleId;
    this.worldOverlayPreparedInputCycleId = inputCycleId;
    setTimeout(() => {
      if (
        this.presentationTimings.cycleId !== inputCycleId
        || this.overlayState.mode === 'idle'
      ) {
        return;
      }
      this.overlay.prepareWorldOnDisplay(electronDisplay);
    }, 0);
  }

  private attachPendingInitialHotkeyContextAfterInputReady(): void {
    const pending = this.pendingInitialHotkeyContextAttach;
    if (!pending) {
      return;
    }
    this.pendingInitialHotkeyContextAttach = null;
    const pendingPromise = this.attachInitialHotkeyContextItems(
      pending.display,
      pending.requestId,
      pending.startedAt,
    ).finally(() => {
      if (this.pendingInitialHotkeyContextAttachPromise === pendingPromise) {
        this.pendingInitialHotkeyContextAttachPromise = null;
      }
    });
    this.pendingInitialHotkeyContextAttachPromise = pendingPromise;
  }

  private startPendingTargetContextHydration(reason: string): void {
    const pending = this.pendingTargetContextHydration;
    if (!pending || this.pendingTargetContextHydrationPromise) {
      return;
    }
    if (
      pending.requestId !== this.hotkeyContextRequestId
      || this.overlayState.mode !== 'input'
      || !this.interactionDisplay
      || this.interactionDisplay.id !== pending.display.id
    ) {
      this.pendingTargetContextHydration = null;
      return;
    }

    const startedAt = Date.now();
    console.log('[InterpreterOverlay] starting pending target context hydration', {
      reason,
      contextId: pending.contextId,
    });
    const hydrationPromise = this.loadSelectionElementsForTargetBounds(
      pending.display,
      pending.absoluteBounds,
    ).finally(() => {
      if (this.pendingTargetContextHydrationPromise === hydrationPromise) {
        this.pendingTargetContextHydrationPromise = null;
      }
      if (this.pendingTargetContextHydration?.contextId === pending.contextId) {
        this.pendingTargetContextHydration = null;
      }
      console.log('[InterpreterOverlay] pending target context hydration settled', {
        reason,
        contextId: pending.contextId,
        durationMs: Date.now() - startedAt,
      });
    });
    this.pendingTargetContextHydrationPromise = hydrationPromise;
  }

  private scheduleTargetContextHydrationAfterInputReady(
    display: DisplayInfo,
    absoluteBounds: Bounds,
    requestId: number,
    contextId: string,
  ): void {
    this.pendingTargetContextHydration = {
      display,
      absoluteBounds,
      requestId,
      contextId,
    };
    if (this.overlayState.inputReady) {
      setTimeout(() => this.startPendingTargetContextHydration('input already ready'), 0);
    }
  }

  private async waitForPendingHotkeyContext(
    reason: string,
    options?: { awaitTargetHydration?: boolean },
  ): Promise<void> {
    const awaitTargetHydration = options?.awaitTargetHydration !== false;
    const waitPlan = getPendingHotkeyContextWaitPlan({
      hasPendingActiveAppTargetAttach: Boolean(this.pendingActiveAppTargetAttach),
      hasPendingInitialContextAttach: Boolean(this.pendingInitialHotkeyContextAttach),
      hasPendingInitialContextAttachPromise: Boolean(this.pendingInitialHotkeyContextAttachPromise),
      hasPendingTargetContextHydration: Boolean(this.pendingTargetContextHydration),
      hasPendingTargetContextHydrationPromise: Boolean(this.pendingTargetContextHydrationPromise),
    });

    if (waitPlan.includes('attach-initial-context')) {
      this.attachPendingInitialHotkeyContextAfterInputReady();
    }
    if (waitPlan.includes('await-active-app-target')) {
      await this.waitForPendingActiveAppTargetAttach(reason);
    }

    if (waitPlan.includes('await-initial-context') && this.pendingInitialHotkeyContextAttachPromise) {
      const startedAt = Date.now();
      await this.pendingInitialHotkeyContextAttachPromise.catch((error) => {
        console.warn('[InterpreterOverlay] initial hotkey context attachment failed', { reason, error });
      });
      console.log('[InterpreterOverlay] initial hotkey context attachment settled before continuing', {
        reason,
        durationMs: Date.now() - startedAt,
      });
    }

    const hydrationWaitPlan = getPendingHotkeyContextWaitPlan({
      hasPendingActiveAppTargetAttach: false,
      hasPendingInitialContextAttach: false,
      hasPendingInitialContextAttachPromise: false,
      hasPendingTargetContextHydration: Boolean(this.pendingTargetContextHydration),
      hasPendingTargetContextHydrationPromise: Boolean(this.pendingTargetContextHydrationPromise),
    });

    if (hydrationWaitPlan.includes('start-target-hydration') && this.pendingTargetContextHydration && !this.pendingTargetContextHydrationPromise) {
      this.startPendingTargetContextHydration(reason);
    }
    if (awaitTargetHydration && hydrationWaitPlan.includes('await-target-hydration') && this.pendingTargetContextHydrationPromise) {
      const startedAt = Date.now();
      await this.pendingTargetContextHydrationPromise.catch((error) => {
        console.warn('[InterpreterOverlay] target context hydration failed', { reason, error });
      });
      console.log('[InterpreterOverlay] target context hydration settled before continuing', {
        reason,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private notePresentationCloseRequested(reason: string): void {
    if (this.presentationTimings.cycleId === 0) {
      return;
    }

    this.presentationTimings.closeReason = reason;
    this.notePresentationMilestone('closeRequestedAt', Date.now(), { reason });
    this.scheduleProgressiveBlurClose();
  }

  private handleProgressiveBlurLifecycleEvent(event: ProgressiveBlurLifecycleEvent): void {
    if (this.presentationTimings.cycleId === 0) {
      return;
    }

    switch (event.type) {
      case 'show-command':
        if (this.presentationTimings.openRequestedAt !== null) {
          this.notePresentationMilestone('blurShowCommandAt', event.at);
        }
        break;
      case 'shown':
        if (this.presentationTimings.blurShowCommandAt !== null) {
          this.notePresentationMilestone('blurShownAt', event.at);
        }
        break;
      case 'hide-command':
        if (this.presentationTimings.closeRequestedAt !== null) {
          this.notePresentationMilestone('blurHideCommandAt', event.at);
        }
        break;
      case 'hidden':
        if (this.presentationTimings.closeRequestedAt !== null || this.presentationTimings.blurHideCommandAt !== null) {
          this.notePresentationMilestone('blurHiddenAt', event.at);
        }
        break;
      default:
        break;
    }
  }

  private resetOverlayInputTracking(): void {
    this.cancelVoiceTimer();
    this.clearInputFocusRetryTimers();
    this.inputOpenedAt = null;
    this.voiceRecordingStartedAt = null;
    this.voiceDraftBase = '';
    this.voiceRecordingTranscript = '';
    this.voiceInputUsed = false;
    this.lastOpenSource = null;
    this.inputStripRequestId += 1;
    this.hotkeyContextRequestId += 1;
    this.pendingActiveAppTargetAttach = null;
    this.pendingInitialHotkeyContextAttach = null;
    this.pendingInitialHotkeyContextAttachPromise = null;
    this.pendingTargetContextHydration = null;
    this.pendingTargetContextHydrationPromise = null;
    this.lastRemovedTargetContext = null;
    this.lastCtrlSpaceDownAt = null;
    this.lastCtrlSpaceHoldDurationMs = null;
    this.lastCtrlSpaceUpAt = null;
  }

  private resetOverlaySelectionState(): void {
    this.selectionRequestId += 1;
    this.clearInputFocusRetryTimers();
    if (this.selectionPreviewTimer) {
      clearTimeout(this.selectionPreviewTimer);
      this.selectionPreviewTimer = null;
    }
    this.pendingSelectionPreviewBounds = undefined;
    this.selectionPreviewInFlight = false;
    this.inputStripRequestId += 1;
    this.interactionDisplay = null;
    this.pendingActiveAppTargetAttach = null;
    this.pendingInitialHotkeyContextAttach = null;
    this.pendingInitialHotkeyContextAttachPromise = null;
    this.pendingTargetContextHydration = null;
    this.pendingTargetContextHydrationPromise = null;
    this.selectionElements = [];
    this.scopedStructuredContext = null;
    this.scopeBounds = null;
    this.worldOverlayPreparedInputCycleId = null;
  }

  private clearInputFocusRetryTimers(): void {
    for (const timer of this.inputFocusRetryTimers) {
      clearTimeout(timer);
    }
    this.inputFocusRetryTimers.clear();
  }

  private scheduleInputFocusRetries(cycleId: number, displayId: string): void {
    this.clearInputFocusRetryTimers();
    for (const delayMs of [0, 40, 120, 280, 520, 900]) {
      const timer = setTimeout(() => {
        this.inputFocusRetryTimers.delete(timer);
        if (
          this.presentationTimings.cycleId !== cycleId
          || this.overlayState.mode !== 'input'
          || !this.interactionDisplay
          || this.interactionDisplay.id !== displayId
          || this.overlayState.inputReady
        ) {
          return;
        }
        this.overlay.focus();
        this.overlay.requestInputFocus();
      }, delayMs);
      this.inputFocusRetryTimers.add(timer);
    }
  }

  private async readInitialHotkeyContextItems(display: DisplayInfo): Promise<OverlayContextItem[]> {
    try {
      const result = await executeOverlayTextControllerDirectCommand(
        {
          kind: 'tool',
          serverId: 'builtin-selection',
          toolName: 'read_current_selection',
          args: { format: 'json' },
        },
        {
          agentId: createOverlayAgentId(),
          workspacePath: getCurrentWorkspace(),
          profileId: null,
        },
      );
      const contextItems = await buildOverlayContextItemsFromSelectionToolJson(
        result.text,
        display,
        normalizeOverlayFileContextPaths,
      );
      if (contextItems.length > 0) {
        console.log('[InterpreterOverlay] imported selection references through builtin-selection', { count: contextItems.length });
      }
      return contextItems;
    } catch (error) {
      console.warn('[InterpreterOverlay] failed to import selection references through builtin-selection', error);
    }

    return [];
  }

  private async attachInitialHotkeyContextItems(
    display: DisplayInfo,
    requestId: number,
    startedAt: number,
  ): Promise<void> {
    const contextItems = await this.readInitialHotkeyContextItems(display);
    if (
      requestId !== this.hotkeyContextRequestId
      || this.overlayState.mode !== 'input'
      || !this.interactionDisplay
      || this.interactionDisplay.id !== display.id
      || contextItems.length === 0
    ) {
      return;
    }

    this.send({
      contextItems: mergeOverlayContextItems(this.overlayState.contextItems, contextItems),
    });
    console.log('[InterpreterOverlay] attached initial hotkey context references', {
      count: contextItems.length,
      durationMs: Date.now() - startedAt,
    });
  }

  private async attachActiveAppTargetContext(
    display: DisplayInfo,
    requestId: number,
    startedAt: number,
  ): Promise<void> {
    const activeAppTarget = await this.resolveActiveAppTargetContext(display);
    if (
      requestId !== this.hotkeyContextRequestId
      || this.overlayState.mode !== 'input'
      || !this.interactionDisplay
      || this.interactionDisplay.id !== display.id
      || !activeAppTarget
      || this.overlayState.targetContextId !== null
    ) {
      return;
    }

    this.scopeBounds = activeAppTarget.absoluteBounds;
    this.selectionElements = [];
    this.scopedStructuredContext = null;
    this.send({
      scopeBounds: activeAppTarget.localBounds,
      contextItems: [
        activeAppTarget.contextItem,
        ...this.overlayState.contextItems.filter((item) => item.role !== 'target'),
      ],
      targetContextId: activeAppTarget.contextItem.id,
      activeRegionRole: 'target',
    });
    this.notePresentationMilestone('activeAppTargetAttachedAt', Date.now(), {
      ownerName: activeAppTarget.ownerName,
    });
    this.scheduleTargetContextHydrationAfterInputReady(
      display,
      activeAppTarget.absoluteBounds,
      requestId,
      activeAppTarget.contextItem.id,
    );
    void this.attachActiveAppIcon(
      activeAppTarget.contextItem.id,
      activeAppTarget.pid,
      activeAppTarget.appBundlePath,
    );
    console.log('[InterpreterOverlay] attached active-app target context', {
      contextId: activeAppTarget.contextItem.id,
      ownerName: activeAppTarget.ownerName,
      durationMs: Date.now() - startedAt,
    });
  }

  private async resolveActiveAppTargetContext(display: DisplayInfo): Promise<{
    contextItem: OverlayRegionContextItem;
    localBounds: Bounds;
    absoluteBounds: Bounds;
    pid: number;
    cgWindowId: number;
    ownerName: string;
    appBundlePath: string | null;
  } | null> {
    const target = await activeWindow();
    if (!target) {
      return null;
    }

    const absoluteBounds = intersectBounds(target.bounds, display.boundsDIP);
    if (!absoluteBounds || !hasMeaningfulScope(absoluteBounds)) {
      return null;
    }

    const localBounds = toLocalBounds(absoluteBounds, display.boundsDIP);
    const ownerName = target.ownerName.trim() || 'active app';
    const contextItem = createOverlayRegionContextItem({
      role: 'target',
      bounds: absoluteBounds,
      display,
      label: `Active app: ${ownerName}`,
      scopeKind: 'active-app',
      nativeWindowId: target.cgWindowId,
      app: {
        name: ownerName,
        pid: target.pid,
        bundlePath: target.appBundlePath ?? null,
      },
      appIconDataUrl: null,
      appIconLabel: ownerName,
    });

    return {
      contextItem,
      localBounds,
      absoluteBounds,
      pid: target.pid,
      cgWindowId: target.cgWindowId,
      ownerName,
      appBundlePath: target.appBundlePath ?? null,
    };
  }

  private async attachActiveAppIcon(contextId: string, pid: number, appBundlePath: string | null): Promise<void> {
    const appIconDataUrl = await resolveMacAppIconDataUrl(pid, appBundlePath);
    if (!appIconDataUrl || this.overlayState.mode !== 'input') {
      return;
    }

    const contextItems = this.overlayState.contextItems.map((item) => (
      item.kind === 'region' && item.id === contextId
        ? { ...item, appIconDataUrl }
        : item
    ));
    this.send({ contextItems });
  }

  private clearCachedInputVisualHealth(): void {
    this.lastOverlayVisualHealth = null;
    this.lastInputOverlayControlHealth = null;
    this.lastOverlayVisualHealthAt = null;
    this.lastInputStateDeliveredAt = null;
    this.lastOverlayVisualBlankSince = null;
    this.lastOverlayVisualHealthSignature = null;
  }

  private getCurrentViewport(): Bounds | null {
    if (!this.interactionDisplay) {
      return null;
    }

    return getDisplayViewport(this.interactionDisplay, this.scopeBounds);
  }

  private getLocalScopeBounds(): Bounds | null {
    if (!this.interactionDisplay || !this.scopeBounds) {
      return null;
    }

    return toLocalBounds(this.scopeBounds, this.interactionDisplay.boundsDIP);
  }

  private getElectronDisplay(display: DisplayInfo | null): Electron.Display | null {
    if (!display) {
      return null;
    }

    return screen.getAllDisplays().find((candidate) => String(candidate.id) === display.id) ?? null;
  }

  /**
   * Display workArea translated into overlay-window-local DIP coordinates
   * (the overlay window covers the full display bounds). Null when no
   * interaction display is known.
   */
  private getWindowLocalWorkArea(): Bounds | null {
    const display = this.getElectronDisplay(this.interactionDisplay);
    if (!display) {
      return null;
    }

    return {
      x: display.workArea.x - display.bounds.x,
      y: display.workArea.y - display.bounds.y,
      width: display.workArea.width,
      height: display.workArea.height,
    };
  }

  private showOverlayOnInteractionDisplay(): void {
    const display = this.getElectronDisplay(this.interactionDisplay);
    if (display) {
      this.overlay.showOnDisplay(display);
      return;
    }

    this.overlay.showAtCursorDisplay();
  }

  private overlayVisualHealthHasVisibleInputPrompt(health: OverlayVisualHealth | null): boolean {
    return Boolean(health?.hasVisibleInputControl);
  }

  private shouldShowProgressiveBlur(): boolean {
    const blurAlreadyVisible = this.progressiveBlur.getDebugState().visible;

    if (blurAlreadyVisible && this.progressiveBlurClosePending) {
      return true;
    }

    if (!this.overlayShouldBeVisuallyPresent()) {
      return false;
    }

    if (
      process.platform !== 'darwin'
      || this.overlayState.mode !== 'input'
      || !usesProgressiveBlurInput()
    ) {
      return false;
    }

    return true;
  }

  private syncProgressiveBlurVisibility(): void {
    if (!this.shouldShowProgressiveBlur()) {
      this.progressiveBlur.hide();
      return;
    }

    this.progressiveBlur.show();
  }

  private async loadSelectionElementsForDisplay(display: DisplayInfo): Promise<void> {
    await this.loadSelectionElementsForBounds(display, { ...display.boundsDIP });
  }

  private async refreshRegionContextEvidence(
    contextId: string,
    display: DisplayInfo,
    absoluteBounds: Bounds,
  ): Promise<void> {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    try {
      const centerX = absoluteBounds.x + absoluteBounds.width / 2;
      const centerY = absoluteBounds.y + absoluteBounds.height / 2;
      const target = await windowAtPoint(centerX, centerY);
      console.log('[InterpreterOverlay] Refreshing region context evidence', {
        contextId,
        targetPid: target?.pid ?? null,
        bounds: {
          x: Math.round(absoluteBounds.x),
          y: Math.round(absoluteBounds.y),
          width: Math.round(absoluteBounds.width),
          height: Math.round(absoluteBounds.height),
        },
      });
      let browserRegionText: string | null = null;
      let browserRegionTextFailed = false;
      try {
        browserRegionText = await extractBrowserRegionText(absoluteBounds);
      } catch (error) {
        browserRegionTextFailed = true;
        console.warn('[InterpreterOverlay] Browser CDP region text extraction failed; using accessibility context', error);
      }
      const segmentedResult = overlaySupportsAccessibilityContext()
        && browserRegionText === null
          ? await performSegmentedOCR(Buffer.alloc(0), display.scaleFactor, {
              scopeBounds: absoluteBounds,
              targetPid: process.platform === 'win32' ? null : target?.pid,
              targetWindowId: null,
              windowsViewMode: 'raw',
            })
        : null;
      const normalizedContext = segmentedResult
        ? normalizeStructuredContext(segmentedResult.formattedText, segmentedResult.elements)
        : null;
      const previewText = browserRegionText ?? normalizedContext?.formattedText ?? null;
      const contextItems = this.overlayState.contextItems.map((item) => (
        item.kind === 'region' && item.id === contextId
          ? {
              ...item,
              previewText: trimInputContextPreviewText(previewText ?? item.previewText),
              targetIdentity: target
                ? {
                    ...item.targetIdentity,
                    app: {
                      name: target.ownerName.trim() || 'unknown app',
                      pid: target.pid,
                      bundlePath: target.appBundlePath ?? null,
                    },
                    window: {
                      ...item.targetIdentity.window,
                      nativeWindowId: target.cgWindowId,
                    },
                  }
                : item.targetIdentity,
            }
          : item
      ));
      this.send({ contextItems });
      console.log('[InterpreterOverlay] Refreshed region context evidence', {
        contextId,
        source: browserRegionText === null ? 'accessibility' : 'browser-cdp',
        browserRegionTextFailed,
        hasPreviewText: Boolean(previewText?.trim()),
        previewTextLength: previewText?.length ?? 0,
      });
    } catch (error) {
      console.warn('[InterpreterOverlay] Failed to refresh region context evidence:', error);
    }
  }

  private async loadSelectionElementsForBounds(display: DisplayInfo, absoluteBounds: Bounds | null): Promise<void> {
    const requestId = ++this.selectionRequestId;

    if (!overlaySupportsAccessibilityContext() || !absoluteBounds) {
      this.selectionElements = [];
      this.send({ selectableElements: [] });
      return;
    }

    try {
      const segmentedResult = await performSegmentedOCR(
        Buffer.alloc(0),
        display.scaleFactor,
        { scopeBounds: absoluteBounds },
      );
      const normalizedContext = normalizeStructuredContext(
        segmentedResult.formattedText,
        segmentedResult.elements,
      );
      const sheenElements = filterOverlayScopeSheenElements(normalizedContext.elements);

      if (
        requestId !== this.selectionRequestId
        || !this.interactionDisplay
        || this.interactionDisplay.id !== display.id
        || this.overlayState.mode !== 'input'
        || !boundsApproximatelyEqual(this.scopeBounds, absoluteBounds)
      ) {
        return;
      }

      this.selectionElements = sheenElements;
      this.scopedStructuredContext = {
        displayId: display.id,
        scopeBounds: { ...absoluteBounds },
        formattedText: normalizedContext.formattedText,
        elements: normalizedContext.elements,
      };
      console.log('[InterpreterOverlay] Loaded scope selection elements', {
        count: this.selectionElements.length,
        scopeBounds: absoluteBounds,
      });
      this.send({
        selectableElements: this.selectionElements
          .map((element) => toSelectableElement(element, display, absoluteBounds))
          .filter((element): element is OverlaySelectionElement => element !== null),
      });
    } catch (error) {
      if (requestId !== this.selectionRequestId) {
        return;
      }

      console.error('[InterpreterOverlay] Failed to load selection elements:', error);
      this.trackOverlayError('overlay_scope_context_failed', getErrorMessage(error));
    }
  }

  private async loadBrowserSelectionElementsForTarget(params: {
    display: DisplayInfo;
    absoluteBounds: Bounds;
    target: WindowInfo;
  }): Promise<{
    selectableElements: OverlaySelectionElement[];
    browser: OverlayTargetIdentity['browser'];
  }> {
    if (!isBrowserControlAppLabel(`${params.target.ownerName} ${params.target.title}`)) {
      return { selectableElements: [], browser: null };
    }
    const status = await getBrowserControlStatus();
    const activeTab = selectActiveBrowserTabForOverlayTarget(status, params.target);
    if (!activeTab) {
      return { selectableElements: [], browser: null };
    }

    const inventory = await getBrowserControlPageElementInventory({
      tabRef: activeTab.tabRef,
      maxElementsPerFrame: 80,
    });
    const selectableElements = buildOverlayBrowserSelectionElements({
      display: params.display,
      absoluteBounds: params.absoluteBounds,
      inventory,
      browserWindowId: activeTab.windowId,
    });
    return {
      selectableElements,
      browser: {
        profileId: activeTab.profileId,
        windowId: activeTab.windowId,
        tabId: activeTab.chromeTabId,
        frameId: inventory.frames[0]?.frameId ?? null,
        url: activeTab.url,
        title: activeTab.title,
        documentRevision: inventory.frames[0]?.documentRevision ?? null,
      },
    };
  }

  private async loadNativeCuaRegionSelectionElements(params: {
    display: DisplayInfo;
    absoluteBounds: Bounds;
    target: WindowInfo;
  }): Promise<OverlaySelectionElement[]> {
    const previous = this.pendingNativeCuaRegionSelectionPromise;
    if (previous) {
      await Promise.race([
        previous.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 15000);
        }),
      ]);
    }

    const ownerName = params.target.ownerName.trim() || params.target.title.trim();
    const promise = loadCuaRegionSelectionElements({
      agentId: createOverlayAgentId(),
      workspacePath: getCurrentWorkspace(),
      profileId: null,
      appName: ownerName,
      targetIdentity: {
        kind: 'app-window',
        platform: process.platform,
        coordinate_space: 'screen-dip',
        observed_at: Date.now(),
        app: {
          name: ownerName || null,
          pid: params.target.pid,
        },
        window: {
          native_window_id: params.target.cgWindowId,
          title: params.target.title.trim() || null,
        },
        bounds: { ...params.target.bounds },
        ref_invalidation: {
          rules: [
            'target_identity_mismatch',
            'pid_mismatch',
            'native_window_id_mismatch',
            'window_closed',
          ],
        },
      },
      regionBounds: params.absoluteBounds,
      display: params.display,
    });
    this.pendingNativeCuaRegionSelectionPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.pendingNativeCuaRegionSelectionPromise === promise) {
        this.pendingNativeCuaRegionSelectionPromise = null;
      }
    }
  }

  private async shouldAutoLoadNativeCuaRegionRefs(target: WindowInfo): Promise<boolean> {
    const appName = target.ownerName.trim() || target.title.trim();
    const mode = resolveCuaAccessPolicyMode(await getCuaAccessPolicy(), appName, 'inspect');
    if (mode !== 'all') {
      console.log('[InterpreterOverlay] native CUA region refs not auto-loaded', {
        appName,
        inspectPolicy: mode,
      });
      return false;
    }
    return true;
  }

  private async loadSelectionElementsForTargetBounds(display: DisplayInfo, absoluteBounds: Bounds): Promise<void> {
    const requestId = ++this.selectionRequestId;
    if (!overlaySupportsAccessibilityContext()) {
      this.selectionElements = [];
      this.scopedStructuredContext = null;
      this.send({ selectableElements: [] });
      return;
    }

    try {
      const centerX = absoluteBounds.x + absoluteBounds.width / 2;
      const centerY = absoluteBounds.y + absoluteBounds.height / 2;
      const target = await windowAtPoint(centerX, centerY);
      if (!target) {
        throw new Error('No target window under selected scope.');
      }
      const segmentedResult = await performSegmentedOCR(
        Buffer.alloc(0),
        display.scaleFactor,
        {
          scopeBounds: absoluteBounds,
          targetPid: process.platform === 'win32' ? null : target.pid,
          targetWindowId: null,
        },
      );
      const normalizedContext = normalizeStructuredContext(
        segmentedResult.formattedText,
        segmentedResult.elements,
      );
      const sheenElements = filterOverlayScopeSheenElements(normalizedContext.elements);

      if (
        requestId !== this.selectionRequestId
        || !this.interactionDisplay
        || this.interactionDisplay.id !== display.id
        // 'working' stays eligible: a submit can flip the overlay to working
        // while the initial target hydration is still in flight, and the run
        // startup awaits that same hydration result. Advanced voice stays
        // eligible too: a live voice session keeps mode 'idle', and its
        // hydration and voice-time context rereads must still commit refs.
        || (this.overlayState.mode !== 'input' && this.overlayState.mode !== 'working' && this.overlayState.advancedVoiceActive !== true)
        || !boundsApproximatelyEqual(this.scopeBounds, absoluteBounds)
      ) {
        return;
      }

      this.selectionElements = sheenElements;
      this.scopedStructuredContext = {
        displayId: display.id,
        scopeBounds: { ...absoluteBounds },
        formattedText: normalizedContext.formattedText,
        elements: normalizedContext.elements,
      };
      const axSelectableElements = this.selectionElements
        .map((element) => toSelectableElement(element, display, absoluteBounds))
        .filter((element): element is OverlaySelectionElement => element !== null);
      let browserSelection: {
        selectableElements: OverlaySelectionElement[];
        browser: OverlayTargetIdentity['browser'];
      } = { selectableElements: [], browser: null };
      try {
        browserSelection = await this.loadBrowserSelectionElementsForTarget({
          display,
          absoluteBounds,
          target,
        });
      } catch (error) {
        console.warn('[InterpreterOverlay] Browser selection refs unavailable for target scope', {
          error: getErrorMessage(error),
        });
      }
      if (
        requestId !== this.selectionRequestId
        || !this.interactionDisplay
        || this.interactionDisplay.id !== display.id
        || (this.overlayState.mode !== 'input' && this.overlayState.mode !== 'working' && this.overlayState.advancedVoiceActive !== true)
        || !boundsApproximatelyEqual(this.scopeBounds, absoluteBounds)
      ) {
        return;
      }
      const targetRegionContext = this.overlayState.contextItems.find((item): item is OverlayRegionContextItem => (
        item.kind === 'region'
        && item.role === 'target'
        && boundsApproximatelyEqual(item.bounds, absoluteBounds)
      ));
      const shouldLoadNativeCuaRefs = !browserSelection.browser
        && (targetRegionContext?.scopeKind === 'screen-region' || targetRegionContext?.scopeKind === 'active-app')
        && await this.shouldAutoLoadNativeCuaRegionRefs(target);
      let nativeSelectableElements = axSelectableElements;
      if (!browserSelection.browser && shouldLoadNativeCuaRefs) {
        const preliminaryElements = [
          ...browserSelection.selectableElements,
          ...axSelectableElements,
        ];
        if (preliminaryElements.length > 0) {
          this.send({ selectableElements: preliminaryElements });
        }
        const nativeRefTimeoutMs = 15000;
        console.log('[InterpreterOverlay] native CUA region ref load started', {
          appName: target.ownerName,
          pid: target.pid,
          timeoutMs: nativeRefTimeoutMs,
        });
        try {
          nativeSelectableElements = await Promise.race([
            this.loadNativeCuaRegionSelectionElements({
              display,
              absoluteBounds,
              target,
            }),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => {
                reject(new Error(`native CUA region ref load timed out after ${nativeRefTimeoutMs}ms`));
              }, nativeRefTimeoutMs);
            }),
          ]);
        } catch (error) {
          console.error('[InterpreterOverlay] native CUA region ref load failed; using overlay accessibility refs', {
            appName: target.ownerName,
            pid: target.pid,
            error: getErrorMessage(error),
          });
          nativeSelectableElements = axSelectableElements;
        }
      }
      if (
        requestId !== this.selectionRequestId
        || !this.interactionDisplay
        || this.interactionDisplay.id !== display.id
        || (this.overlayState.mode !== 'input' && this.overlayState.mode !== 'working' && this.overlayState.advancedVoiceActive !== true)
        || !boundsApproximatelyEqual(this.scopeBounds, absoluteBounds)
      ) {
        return;
      }
      const selectableElements = [
        ...browserSelection.selectableElements,
        ...nativeSelectableElements,
      ];
      console.log('[InterpreterOverlay] Loaded target selection elements', {
        count: this.selectionElements.length,
        selectableCount: selectableElements.length,
        browserSelectableCount: browserSelection.selectableElements.length,
        nativeCuaSelectableCount: shouldLoadNativeCuaRefs ? nativeSelectableElements.length : 0,
        nativeAxObservedCount: axSelectableElements.length,
        nativeRefSource: shouldLoadNativeCuaRefs ? 'cua-get_ui_elements' : 'overlay-accessibility',
        sample: this.selectionElements.slice(0, 3).map((element) => ({
          id: element.id,
          role: element.role,
          label: element.label,
          bbox: element.bbox,
        })),
        targetPid: target.pid,
        targetWindowId: target.cgWindowId,
        accessibilityTarget: process.platform === 'win32' ? 'scope-intersection' : 'target-window',
        scopeBounds: absoluteBounds,
        displayBounds: display.boundsDIP,
      });
      const contextItems = mergeBrowserSelectionIntoTargetContextItems({
        contextItems: this.overlayState.contextItems,
        absoluteBounds,
        browser: browserSelection.browser,
        selectableElements,
        previewText: trimInputContextPreviewText(normalizedContext.formattedText),
      });
      this.send({ selectableElements, contextItems });
      // Ref hydration (native CUA/browser loads) can steal OS focus from the
      // prompt input after a region selection. If the user is still in input
      // mode without a ready input, pull focus back so typing works. Never
      // do this while a scope drag is in progress: focusing mid-drag breaks
      // the global gesture.
      if (
        this.overlayState.mode === 'input'
        && !this.overlayState.inputReady
        && !this.scopeSelectionInProgress
        && !this.globalScopeGesture
        && !this.regionDragCaptureActive
      ) {
        console.log('[InterpreterOverlay] refocusing prompt input after target ref load');
        this.overlay.focus();
        this.overlay.requestInputFocus();
      }
    } catch (error) {
      if (requestId !== this.selectionRequestId) {
        return;
      }
      this.selectionElements = [];
      this.scopedStructuredContext = null;
      this.send({ selectableElements: [] });
      console.error('[InterpreterOverlay] Failed to load target selection elements:', error);
      this.trackOverlayError('overlay_scope_context_failed', getErrorMessage(error));
    }
  }

  private hasStructuredContextForTarget(display: DisplayInfo, targetContext: OverlayRegionContextItem): boolean {
    return isStructuredContextReadyForTarget(this.scopedStructuredContext, display, targetContext);
  }

  private currentTargetIsActiveAppContext(): boolean {
    return getTargetContextItem(this.overlayState.contextItems)?.label.startsWith('Active app:') === true;
  }

  private resolveRegionSelectionRole(requestedRole: OverlayContextRole): OverlayContextRole {
    return getOverlayRegionSelectionRole(null, requestedRole, {
      currentTargetIsActiveApp: this.currentTargetIsActiveAppContext(),
    });
  }

  private async ensureStructuredContextForTarget(
    display: DisplayInfo,
    targetContext: OverlayRegionContextItem,
  ): Promise<void> {
    if (this.hasStructuredContextForTarget(display, targetContext)) {
      return;
    }

    await this.waitForMatchingTargetContextHydration(targetContext.bounds);
    if (this.hasStructuredContextForTarget(display, targetContext)) {
      return;
    }

    await this.loadSelectionElementsForTargetBounds(display, targetContext.bounds);

    if (!this.hasStructuredContextForTarget(display, targetContext)) {
      throw new Error('Overlay target context was not ready for the selected scope.');
    }
  }

  private getDisplayForTargetContext(targetContext: OverlayRegionContextItem): DisplayInfo {
    if (!this.capture) {
      throw new Error('Interpreter Overlay runtime is not active.');
    }
    return targetContext.displayId === null
      ? this.capture.getActiveDisplay()
      : this.capture.getDisplayById(String(targetContext.displayId));
  }

  private getCurrentTargetContextForBounds(bounds: Bounds): OverlayRegionContextItem | null {
    return this.overlayState.contextItems.find((item): item is OverlayRegionContextItem => (
      item.kind === 'region'
      && item.role === 'target'
      && boundsApproximatelyEqual(item.bounds, bounds)
    )) ?? null;
  }

  private async ensureExecutableContextForTarget(
    targetContext: OverlayRegionContextItem,
  ): Promise<OverlayRegionContextItem> {
    const display = this.getDisplayForTargetContext(targetContext);
    this.interactionDisplay = display;
    this.scopeBounds = targetContext.bounds;
    await this.waitForMatchingTargetContextHydration(targetContext.bounds);

    let currentTargetContext = this.getCurrentTargetContextForBounds(targetContext.bounds) ?? targetContext;
    if (hasExecutableTargetRefs(currentTargetContext)) {
      return currentTargetContext;
    }

    await this.loadSelectionElementsForTargetBounds(display, targetContext.bounds);
    currentTargetContext = this.getCurrentTargetContextForBounds(targetContext.bounds) ?? targetContext;
    if (!hasExecutableTargetRefs(currentTargetContext)) {
      throw new Error('Overlay target context did not produce executable browser or native CUA refs for the selected scope.');
    }
    return currentTargetContext;
  }

  /**
   * Awaits an in-flight initial target hydration for the same bounds instead of
   * starting a second concurrent full accessibility extraction (which would
   * also invalidate the in-flight one via selectionRequestId).
   */
  private async waitForMatchingTargetContextHydration(bounds: Bounds): Promise<void> {
    const pendingHydration = this.pendingTargetContextHydration;
    const pendingHydrationPromise = this.pendingTargetContextHydrationPromise;
    if (
      !pendingHydrationPromise
      || !pendingHydration
      || !boundsApproximatelyEqual(pendingHydration.absoluteBounds, bounds)
    ) {
      return;
    }

    await pendingHydrationPromise.catch(() => undefined);
  }

  private scheduleSelectionPreviewRefresh(localBounds: Bounds | null): void {
    if (!this.interactionDisplay || this.overlayState.mode !== 'input') {
      return;
    }

    if (process.platform === 'win32') {
      return;
    }

    this.pendingSelectionPreviewBounds = localBounds && hasMeaningfulScope(localBounds)
      ? toAbsoluteBounds(localBounds, this.interactionDisplay.boundsDIP)
      : null;

    if (this.selectionPreviewTimer || this.selectionPreviewInFlight) {
      return;
    }

    this.startSelectionPreviewTimer();
  }

  private clearSelectionPreviewRefresh(): void {
    if (this.selectionPreviewTimer) {
      clearTimeout(this.selectionPreviewTimer);
      this.selectionPreviewTimer = null;
    }
    this.pendingSelectionPreviewBounds = undefined;
  }

  private startSelectionPreviewTimer(): void {
    this.selectionPreviewTimer = setTimeout(() => {
      this.selectionPreviewTimer = null;
      const display = this.interactionDisplay;
      const bounds = this.pendingSelectionPreviewBounds ?? null;
      this.pendingSelectionPreviewBounds = undefined;
      if (!display || this.overlayState.mode !== 'input') {
        return;
      }
      this.selectionPreviewInFlight = true;
      void this.loadSelectionElementsForBounds(display, bounds).finally(() => {
        this.selectionPreviewInFlight = false;
        if (this.pendingSelectionPreviewBounds !== undefined && this.overlayState.mode === 'input') {
          this.startSelectionPreviewTimer();
        }
      });
    }, 180);
  }

  private resetOverlayVisualHealthTracking(): void {
    this.lastOverlayVisualHealth = null;
    this.lastInputOverlayControlHealth = null;
    this.lastOverlayVisualHealthAt = null;
    this.lastOverlayVisualBlankSince = null;
    this.lastOverlayVisualHealthSignature = null;
    this.overlayVisualExpectationAt = this.overlayShouldBeVisuallyPresent() ? Date.now() : null;
  }

  private startVisualHealthWatchdog(): void {
    if (this.visualHealthWatchdog) {
      return;
    }

    this.visualHealthWatchdog = setInterval(() => {
      void this.checkOverlayVisualHealth().catch((error) => {
        console.error('[InterpreterOverlay] Visual health watchdog failed:', error);
      });
    }, OVERLAY_VISUAL_HEALTH_CHECK_INTERVAL_MS);
  }

  private stopVisualHealthWatchdog(): void {
    if (!this.visualHealthWatchdog) {
      return;
    }

    clearInterval(this.visualHealthWatchdog);
    this.visualHealthWatchdog = null;
  }

  private overlayEmergencyStopTriggered(position: { x: number; y: number }): boolean {
    return position.x <= OVERLAY_EMERGENCY_STOP_CORNER_THRESHOLD_PX
      && position.y <= OVERLAY_EMERGENCY_STOP_CORNER_THRESHOLD_PX;
  }

  private shouldMonitorEmergencyStop(): boolean {
    return this.runtimeActive && this.debugRunState.status === 'running';
  }

  private syncEmergencyStopWatchdog(): void {
    if (!this.shouldMonitorEmergencyStop()) {
      this.stopEmergencyStopWatchdog();
      return;
    }

    this.startEmergencyStopWatchdog();
  }

  private startEmergencyStopWatchdog(): void {
    if (this.emergencyStopWatchdog) {
      return;
    }

    this.emergencyStopWatchdog = setInterval(() => {
      void this.checkEmergencyStopHotCorner().catch((error) => {
        console.error('[InterpreterOverlay] Emergency-stop watchdog failed:', error);
      });
    }, OVERLAY_EMERGENCY_STOP_CHECK_INTERVAL_MS);
  }

  private stopEmergencyStopWatchdog(): void {
    if (!this.emergencyStopWatchdog) {
      return;
    }

    clearInterval(this.emergencyStopWatchdog);
    this.emergencyStopWatchdog = null;
  }

  private async checkEmergencyStopHotCorner(): Promise<void> {
    if (!this.shouldMonitorEmergencyStop() || this.emergencyStopHandling) {
      return;
    }

    const position = await mouse.getPosition();
    if (!this.overlayEmergencyStopTriggered(position)) {
      return;
    }

    this.emergencyStopHandling = true;
    try {
      await this.handleAutomationEmergencyStop({ x: position.x, y: position.y });
    } finally {
      this.emergencyStopHandling = false;
    }
  }

  private overlayShouldBeVisuallyPresent(): boolean {
    return this.overlayState.mode !== 'idle';
  }

  private healthSatisfiesOverlayState(health: OverlayVisualHealth): boolean {
    if (this.overlayState.mode === 'idle') {
      return true;
    }

    if (!health.hasRenderedDom) {
      return false;
    }

    switch (this.overlayState.mode) {
      case 'input':
        if (health.hasVisibleInputControl) {
          return true;
        }

        if (health.editorBounds && health.primaryActionBounds) {
          return true;
        }

        return this.scopeSelectionInProgress && health.renderedMode === 'input';
      case 'review':
        return health.hasVisiblePill
          || health.hasVisibleReviewControl
          || health.hasVisibleMarker
          || health.hasVisibleInputControl;
      case 'working':
        return health.hasVisiblePill
          || health.hasVisibleMarker
          || health.hasVisibleInputControl;
    }
  }

  private noteOverlayVisualHealth(health: OverlayVisualHealth): void {
    if (health.source !== 'world') {
      this.lastAnyOverlayVisualHealthAt = Date.now();
    }
    const expectsStrictModeHealth =
      this.overlayState.mode === 'review'
      || this.overlayState.mode === 'working';
    if (
      health.source === 'world'
      && expectsStrictModeHealth
      && health.renderedMode !== this.overlayState.mode
    ) {
      return;
    }

    // The pinned world overlay is the authoritative visible surface only while
    // actions execute. The review approval pill always renders in the
    // display-sized chrome overlay, and a stale world report (for example an
    // empty world renderer heartbeating during input mode) must never replace
    // chrome health, or the blank watchdog recreates a perfectly healthy
    // React overlay window out from under the user.
    const worldOwnsVisibleSurface = this.overlayState.worldPinActive
      && this.overlayState.mode === 'working';
    if (health.source === 'world') {
      this.lastWorldOverlayVisualHealth = health;
      if (!worldOwnsVisibleSurface) {
        return;
      }
    } else if (worldOwnsVisibleSurface) {
      return;
    }

    this.lastOverlayVisualHealth = health;
    this.lastOverlayVisualHealthAt = Date.now();
    const inputPromptVisible = this.overlayVisualHealthHasVisibleInputPrompt(health);
    if (this.overlayState.mode === 'input' && inputPromptVisible && health.editorBounds) {
      this.lastInputOverlayControlHealth = health;
    }

    if (
      this.presentationTimings.cycleId > 0
      && this.overlayState.mode === 'input'
      && this.presentationTimings.reactVisibleAt === null
      && this.healthSatisfiesOverlayState(health)
    ) {
      this.notePresentationMilestone('reactVisibleAt', health.timestamp ?? Date.now());
    }

    if (
      this.presentationTimings.cycleId > 0
      && this.presentationTimings.closeRequestedAt !== null
      && this.presentationTimings.reactHiddenAt === null
      && !inputPromptVisible
    ) {
      this.notePresentationMilestone('reactHiddenAt', health.timestamp ?? Date.now(), {
        reason: this.presentationTimings.closeReason,
      });
    }

    if (!this.overlayShouldBeVisuallyPresent()) {
      this.lastOverlayVisualBlankSince = null;
      this.syncProgressiveBlurVisibility();
      return;
    }

    const healthy = this.healthSatisfiesOverlayState(health);
    const signature = JSON.stringify({
      source: health.source ?? 'chrome',
      mode: this.overlayState.mode,
      renderedMode: health.renderedMode,
      pillKind: health.pillKind,
      healthy,
      hasDebugVisualProbe: health.hasDebugVisualProbe ?? false,
      debugVisualProbeBounds: health.debugVisualProbeBounds ?? null,
      hasRenderedDom: health.hasRenderedDom,
      hasVisiblePill: health.hasVisiblePill,
      hasVisibleInputControl: health.hasVisibleInputControl,
      hasVisibleReviewControl: health.hasVisibleReviewControl,
      hasVisibleMarker: health.hasVisibleMarker,
      hasVisibleAffordance: health.hasVisibleAffordance,
      domNodeCount: health.domNodeCount,
    });

    if (signature !== this.lastOverlayVisualHealthSignature) {
      console.log('[InterpreterOverlay] visual health', {
        source: health.source ?? 'chrome',
        mode: this.overlayState.mode,
        renderedMode: health.renderedMode,
        pillKind: health.pillKind,
        healthy,
        hasDebugVisualProbe: health.hasDebugVisualProbe ?? false,
        debugVisualProbeBounds: health.debugVisualProbeBounds ?? null,
        hasRenderedDom: health.hasRenderedDom,
        hasVisiblePill: health.hasVisiblePill,
        hasVisibleInputControl: health.hasVisibleInputControl,
        hasVisibleReviewControl: health.hasVisibleReviewControl,
        hasVisibleMarker: health.hasVisibleMarker,
        hasVisibleAffordance: health.hasVisibleAffordance,
        domNodeCount: health.domNodeCount,
        contextChipCount: health.contextChipBounds?.length ?? 0,
        contextChipRemoveCount: health.contextChipBounds?.filter((chip) => chip.removeBounds).length ?? 0,
        stateDeliveryToHealthMs: this.lastInputStateDeliveredAt === null
          ? null
          : Math.max(0, Date.now() - this.lastInputStateDeliveredAt),
      });
      this.lastOverlayVisualHealthSignature = signature;
    }

    if (healthy) {
      this.lastOverlayVisualBlankSince = null;
    } else if (this.lastOverlayVisualBlankSince === null) {
      this.lastOverlayVisualBlankSince = Date.now();
    }

    this.syncProgressiveBlurVisibility();

    if (healthy) {
      return;
    }
  }

  private async checkOverlayVisualHealth(): Promise<void> {
    if (!this.runtimeActive) {
      this.lastOverlayVisualBlankSince = null;
      return;
    }

    if (this.overlay.isCaptureSuppressed()) {
      return;
    }

    if (this.visualHealthRecoveryInFlight) {
      return;
    }

    const now = Date.now();
    const rendererReady = this.overlay.isWindowReady() && !this.overlay.isWebContentsLoading();
    if (!rendererReady) {
      this.overlayRendererReadySince = null;
    } else if (this.overlayRendererReadySince === null) {
      this.overlayRendererReadySince = now;
    }
    const neverReportedForMs = this.lastAnyOverlayVisualHealthAt === null
      && this.overlayRendererReadySince !== null
      ? now - this.overlayRendererReadySince
      : null;
    const silentForMs = this.lastAnyOverlayVisualHealthAt === null
      ? null
      : now - this.lastAnyOverlayVisualHealthAt;
    const rendererStalled = rendererReady && (
      (neverReportedForMs !== null && neverReportedForMs >= OVERLAY_RENDERER_BOOT_MOUNT_GRACE_MS)
      || (silentForMs !== null && silentForMs >= OVERLAY_RENDERER_IDLE_SILENCE_MS)
    );
    if (rendererStalled && !this.overlayShouldBeVisuallyPresent()) {
      await this.recoverOverlayVisuals('boot-stall', {
        staleForMs: neverReportedForMs ?? silentForMs ?? 0,
      });
      return;
    }

    if (!this.overlayShouldBeVisuallyPresent()) {
      this.lastOverlayVisualBlankSince = null;
      return;
    }
    if (this.lastOverlayVisualHealthAt === null) {
      const waitingForInitialHealthMs = this.overlayVisualExpectationAt === null
        ? 0
        : now - this.overlayVisualExpectationAt;
      const initialGraceMs = this.overlay.isWindowReady() && !this.overlay.isWebContentsLoading()
        ? OVERLAY_VISUAL_HEALTH_WEDGED_GRACE_MS
        : OVERLAY_VISUAL_HEALTH_INITIAL_GRACE_MS;
      if (waitingForInitialHealthMs < initialGraceMs) {
        return;
      }

      await this.recoverOverlayVisuals('stale', { staleForMs: waitingForInitialHealthMs });
      return;
    }

    const staleForMs = now - this.lastOverlayVisualHealthAt;
    if (staleForMs >= OVERLAY_VISUAL_HEALTH_STALE_MS) {
      await this.recoverOverlayVisuals('stale', { staleForMs });
      return;
    }

    if (
      this.lastOverlayVisualBlankSince !== null
      && now - this.lastOverlayVisualBlankSince >= OVERLAY_VISUAL_HEALTH_BLANK_GRACE_MS
    ) {
      await this.recoverOverlayVisuals('blank', {
        blankForMs: now - this.lastOverlayVisualBlankSince,
      });
    }
  }

  private async recoverOverlayVisuals(
    reason: 'stale' | 'blank' | 'boot-stall',
    metrics: { staleForMs?: number; blankForMs?: number },
  ): Promise<void> {
    if (
      this.overlayState.mode === 'input'
      && reason === 'stale'
      && this.lastOverlayVisualHealth
      && this.healthSatisfiesOverlayState(this.lastOverlayVisualHealth)
    ) {
      console.warn('[InterpreterOverlay] Visual health stale recovery suppressed for healthy input overlay', {
        reason,
        metrics,
        mode: this.overlayState.mode,
      });
      this.lastOverlayVisualHealthAt = Date.now();
      this.lastOverlayVisualBlankSince = null;
      return;
    }

    if (this.overlayState.mode === 'review' || this.overlayState.mode === 'working') {
      console.warn('[InterpreterOverlay] Visual health recovery suppressed during active overlay run', {
        reason,
        metrics,
        mode: this.overlayState.mode,
      });
      this.lastOverlayVisualBlankSince = null;
      return;
    }

    const now = Date.now();
    if (
      this.lastVisualHealthRecoveryAt !== null
      && now - this.lastVisualHealthRecoveryAt < OVERLAY_VISUAL_HEALTH_RECOVERY_COOLDOWN_MS
    ) {
      return;
    }

    if (this.visualHealthRecoveryCount >= OVERLAY_VISUAL_HEALTH_MAX_RECOVERY_ATTEMPTS) {
      console.error('[InterpreterOverlay] Visual health recovery exhausted max attempts', {
        reason,
        metrics,
        attempts: this.visualHealthRecoveryCount,
      });
      this.stopVisualHealthWatchdog();
      return;
    }

    this.visualHealthRecoveryInFlight = true;
    this.visualHealthRecoveryCount += 1;
    this.lastVisualHealthRecoveryAt = now;

    const window = this.overlay.getWindow();
    console.error('[InterpreterOverlay] Visual health recovery triggered', {
      reason,
      metrics,
      attempt: this.visualHealthRecoveryCount,
      mode: this.overlayState.mode,
      overlayVisible: this.overlay.isVisible(),
      windowDestroyed: !window || window.isDestroyed(),
      hasWindow: Boolean(window),
      windowVisible: window?.isVisible() ?? false,
      windowFocused: window?.isFocused() ?? false,
      lastHealth: this.lastOverlayVisualHealth,
    });
    this.trackOverlayError('overlay_visual_health_failed', reason, {
      mode: this.overlayState.mode,
      ...metrics,
    });

    try {
      this.lastAnyOverlayVisualHealthAt = null;
      this.overlayRendererReadySince = null;
      this.overlay.recreate();

      if (this.overlay.isDestroyed()) {
        return;
      }

      const ready = await this.overlay.waitUntilReady();
      if (!ready) {
        console.warn('[InterpreterOverlay] Visual health recovery renderer load did not become ready before timeout');
      }

      if (this.overlay.isDestroyed()) {
        return;
      }

      this.lastSentOverlayStateSignature = null;
      this.visualHealthRecoveryCount = 0;
      this.resendRecoveredOverlayState();
    } finally {
      this.visualHealthRecoveryInFlight = false;
    }
  }

  private async handleOverlayRendererGone(details: Electron.RenderProcessGoneDetails): Promise<void> {
    if (!this.runtimeActive) {
      return;
    }

    console.error('[InterpreterOverlay] Renderer process gone; recreating overlay window', details);
    this.trackOverlayError('overlay_renderer_gone', details.reason, {
      exitCode: details.exitCode,
      mode: this.overlayState.mode,
    });

    try {
      this.overlay.create();
      const ready = await this.overlay.waitUntilReady();
      if (!ready) {
        console.warn('[InterpreterOverlay] Recreated overlay renderer did not become ready before timeout');
      }

      if (this.overlay.isDestroyed()) {
        return;
      }

      // Issue #1939 / Sentry ELECTRON-CX is a native renderer OOM in
      // Chromium/V8/Electron system allocator frames, with the crashed URL set to
      // the Interpreter Overlay renderer. That root OOM is outside this repo, so
      // this is an app-level mitigation: recreate the transient overlay renderer,
      // resend state, and restore input focus when applicable instead of leaving
      // the overlay dead. Keep the crash reportable and classified as renderer
      // OOM in electron/utils/codexSentry.ts.
      // Prior art: VS Code records render-process-gone with reason/exitCode
      // telemetry, while Signal Desktop ignores clean-exit and treats other
      // renderer exits as fatal.
      // Sources: https://github.com/microsoft/vscode/blob/main/src/vs/platform/windows/electron-main/windowImpl.ts#L812-L927
      // and https://github.com/signalapp/Signal-Desktop/blob/main/app/global_errors.main.ts#L65-L74
      this.resendRecoveredOverlayState();
    } catch (error) {
      console.error('[InterpreterOverlay] Failed to recover overlay renderer:', error);
      this.trackOverlayError('overlay_renderer_recovery_failed', getErrorMessage(error), {
        exitCode: details.exitCode,
        reason: details.reason,
        mode: this.overlayState.mode,
      });
    }
  }

  private resendRecoveredOverlayState(): void {
    this.lastSentOverlayStateSignature = null;
    this.resetOverlayVisualHealthTracking();
    this.send({});

    if (this.overlayState.mode === 'input') {
      this.overlay.focus();
      this.overlay.requestInputFocus();
    }
  }

  private trackVoiceCancelled(reason: 'dismiss' | 'escape' | 'submit' | 'scope_selection'): void {
    if (this.voiceRecordingStartedAt === null) {
      return;
    }

    this.trackOverlayEvent('overlay_voice_cancelled', {
      reason,
      durationMs: Date.now() - this.voiceRecordingStartedAt,
    });
    this.voiceRecordingStartedAt = null;
  }

  private buildVoiceDraft(segmentText: string): string {
    const normalizedSegment = normalizeVoiceText(segmentText);
    if (!normalizedSegment) {
      return appendOverlayDraftSegment(this.voiceDraftBase, this.voiceRecordingTranscript);
    }

    this.voiceRecordingTranscript = this.voiceRecordingTranscript
      ? mergeStreamingVoiceTranscript(this.voiceRecordingTranscript, normalizedSegment)
      : normalizedSegment;

    return appendOverlayDraftSegment(this.voiceDraftBase, this.voiceRecordingTranscript);
  }

  private startVoiceInput(source: 'hotkey' | 'button'): void {
    if (this.overlayState.mode !== 'input' || !this.stt || this.isVoiceInputActive) {
      console.log('[InterpreterOverlay] startVoiceInput skipped', {
        source,
        mode: this.overlayState.mode,
        hasStt: Boolean(this.stt),
        isVoiceInputActive: this.isVoiceInputActive,
      });
      return;
    }

    this.cancelVoiceTimer();
    this.voiceDraftBase = this.overlayState.transcript;
    this.voiceRecordingTranscript = '';
    this.isVoiceInputActive = true;
    this.voiceRecordingStoppedAt = null;
    this.voiceInputUsed = true;
    this.voiceRecordingStartedAt = Date.now();
    console.log('[InterpreterOverlay] startVoiceInput', {
      source,
      startedAt: this.voiceRecordingStartedAt,
    });
    this.trackOverlayEvent('overlay_voice_started', { source });
    this.send({ isRecording: true, amplitude: 0 });
    this.stt.startRecording();
    this.overlay.requestInputFocus();
  }

  private async buildOverlayWholeComputerState(input: {
    workspacePath: string | null;
    targetWindowSessionKey: string | null;
    targetContext: OverlayRegionContextItem | null;
    contextItems: OverlayContextItem[];
  }): Promise<OverlayWholeComputerState> {
    const interpreterWindows = listWindowSessions().map((session) => ({
      kind: 'interpreter-window' as const,
      windowSessionKey: session.sessionKey,
      workspacePath: session.workspacePath,
      windowId: session.windowId,
    }));
    const agentWindows = agentTabManager.listAgentWindowBindings().map((binding) => ({
      kind: 'agent-window' as const,
      windowSessionKey: binding.windowSessionKey ?? null,
      workspacePath: binding.workspacePath ?? null,
      agentId: binding.agentId,
      threadId: binding.threadId ?? null,
      activityLabel: binding.activity?.label ?? null,
      isRunning: binding.activity?.isRunning ?? null,
      lastMessagePreview: binding.activity?.lastMessagePreview ?? null,
    }));
    const browserControl = buildOverlayBrowserControlStateFromStatus(
      await getBrowserControlStatus(),
      30,
    );

    return {
      workspacePath: input.workspacePath,
      targetWindowSessionKey: input.targetWindowSessionKey,
      targetContextLabel: input.targetContext?.label ?? null,
      targetIdentityId: input.targetContext?.targetIdentity.id ?? null,
      overlayTarget: input.targetContext
        ? {
            label: input.targetContext.label,
            targetKind: input.targetContext.targetIdentity.kind,
            targetIdentityId: input.targetContext.targetIdentity.id,
            coordinateSpace: input.targetContext.targetIdentity.coordinateSpace,
            displayId: input.targetContext.targetIdentity.displayId,
            scaleFactor: input.targetContext.targetIdentity.scaleFactor,
            bounds: { ...input.targetContext.targetIdentity.bounds },
            capturedAt: input.targetContext.targetIdentity.capturedAt,
            appName: input.targetContext.targetIdentity.app?.name ?? null,
            appPid: input.targetContext.targetIdentity.app?.pid ?? null,
            appBundlePath: input.targetContext.targetIdentity.app?.bundlePath ?? null,
            nativeWindowId: input.targetContext.targetIdentity.window.nativeWindowId ?? null,
          }
        : null,
      contextItemCount: input.contextItems.length,
      referenceContextCount: input.contextItems.filter((item) => item.role === 'reference').length,
      windows: [...interpreterWindows, ...agentWindows],
      browserControl,
    };
  }

  private summarizeOverlayApproval(approval: QuestionRequest): NonNullable<OverlayState['globalApproval']> {
    const context = approval.context && typeof approval.context === 'object'
      ? approval.context as Record<string, unknown>
      : {};
    const title = typeof context.message === 'string' && context.message.trim()
      ? context.message.trim()
      : typeof context.description === 'string' && context.description.trim()
        ? context.description.trim()
        : approval.isSimpleApproval
          ? 'Approval needed'
          : approval.questions?.[0]?.header?.trim() || approval.questions?.[0]?.question?.trim() || 'Input needed';
    const detail = typeof context.warning === 'string' && context.warning.trim()
      ? context.warning.trim()
      : typeof context.command === 'string' && context.command.trim()
        ? context.command.trim()
        : typeof context.toolName === 'string' && context.toolName.trim()
          ? context.toolName.trim()
          : `${approval.serverId}:${approval.toolName}`;
    return {
      id: approval.id,
      title,
      detail,
      supportsSessionApproval: context.sessionAware === true,
    };
  }

  private refreshGlobalApprovalState(): void {
    const approval = approvalManager
      .getApprovalsForOverlayAgents({
        agentIds: this.overlayApprovalAgentIds,
        threadId: this.advancedVoice.advancedVoiceAgent?.threadId,
      })[0] ?? null;
    const nextApproval = approval ? this.summarizeOverlayApproval(approval) : null;
    const current = this.overlayState.globalApproval;
    if (
      current?.id === nextApproval?.id
      && current?.title === nextApproval?.title
      && current?.detail === nextApproval?.detail
      && current?.supportsSessionApproval === nextApproval?.supportsSessionApproval
    ) {
      return;
    }
    this.send({ globalApproval: nextApproval });
    if (!nextApproval) {
      this.advancedVoice.stopAdvancedVoiceApprovalBridgeIfIdle();
    }
  }

  private startGlobalApprovalPoller(): void {
    if (this.globalApprovalPollTimer) {
      return;
    }
    this.refreshGlobalApprovalState();
    this.globalApprovalPollTimer = setInterval(() => {
      this.refreshGlobalApprovalState();
    }, 150);
  }

  private stopGlobalApprovalPoller(): void {
    if (this.globalApprovalPollTimer) {
      clearInterval(this.globalApprovalPollTimer);
      this.globalApprovalPollTimer = null;
    }
    if (this.overlayState.globalApproval) {
      this.send({ globalApproval: null, ctrlPressed: false });
    }
  }

  private refreshAgentDashboardState(): void {
    const runningAgents = buildOverlayRunningAgents(agentTabManager.listAgentWindowBindings());
    const dashboardApprovals = buildOverlayDashboardApprovals(approvalManager.getApprovals());
    const runningAgentsChanged = JSON.stringify(this.overlayState.runningAgents) !== JSON.stringify(runningAgents);
    if (
      !runningAgentsChanged
      && JSON.stringify(this.overlayState.dashboardApprovals) === JSON.stringify(dashboardApprovals)
    ) {
      return;
    }
    this.send({ runningAgents, dashboardApprovals });
    if (runningAgentsChanged) {
      this.emitTrayStateChanged();
    }
  }

  private startAgentDashboardPoller(): void {
    if (this.agentDashboardPollTimer) {
      return;
    }
    this.refreshAgentDashboardState();
    this.agentDashboardPollTimer = setInterval(() => {
      this.refreshAgentDashboardState();
    }, 300);
  }

  private stopAgentDashboardPoller(): void {
    if (this.agentDashboardPollTimer) {
      clearInterval(this.agentDashboardPollTimer);
      this.agentDashboardPollTimer = null;
    }
    if (this.overlayState.runningAgents.length > 0 || this.overlayState.dashboardApprovals.length > 0) {
      const hadRunningAgents = this.overlayState.runningAgents.length > 0;
      this.send({ runningAgents: [], dashboardApprovals: [] });
      if (hadRunningAgents) {
        this.emitTrayStateChanged();
      }
    }
  }

  private clearAttachedOverlaySessionsForFreshStart(reason: string): void {
    this.engine?.endAttachedToolSession();
    overlaySessionManager.clearAll();
    this.activeAttachedSessionId = null;
    this.activeAttachedAgentId = null;
    this.overlayApprovalAgentIds.clear();
    console.log('[InterpreterOverlay] cleared attached overlay sessions for fresh start', {
      reason,
    });
  }

  private approveGlobalApproval(): void {
    const approval = this.overlayState.globalApproval;
    if (!approval) {
      return;
    }
    const result = approval.supportsSessionApproval
      ? { answers: { '0': 'approve' }, approvalMode: 'session' as const }
      : { answers: { '0': 'approve' } };
    const response = approvalManager.respond(approval.id, result);
    if (!response.success) {
      console.warn('[InterpreterOverlay] Failed to approve global approval', {
        id: approval.id,
        error: response.error,
      });
    }
    this.refreshGlobalApprovalState();
  }

  private denyGlobalApproval(): void {
    const approval = this.overlayState.globalApproval;
    if (!approval) {
      return;
    }
    const response = approvalManager.respond(approval.id, { answers: { '0': 'deny' } });
    if (!response.success) {
      console.warn('[InterpreterOverlay] Failed to deny global approval', {
        id: approval.id,
        error: response.error,
      });
    }
    this.refreshGlobalApprovalState();
  }

  private respondToDashboardApproval(
    approvalId: string,
    approved: boolean,
    rememberForSession = false,
  ): void {
    const response = approvalManager.respond(approvalId, approved
      ? {
          answers: { '0': 'approve' },
          ...(rememberForSession ? { approvalMode: 'session' as const } : {}),
        }
      : { answers: { '0': 'deny' } });
    if (!response.success) {
      console.warn('[InterpreterOverlay] Failed to respond to dashboard approval', {
        id: approvalId,
        approved,
        error: response.error,
      });
    }
    this.refreshGlobalApprovalState();
    this.refreshAgentDashboardState();
  }

  private async stopVoiceInput(): Promise<void> {
    if (this.overlayState.mode !== 'input' || !this.stt || !this.isVoiceInputActive) {
      return;
    }

    this.cancelVoiceTimer();
    this.isVoiceInputActive = false;
    this.send({ isRecording: false, amplitude: 0 });

    try {
      const result = await this.stt.stopRecording();
      const durationMs =
        this.voiceRecordingStartedAt === null ? undefined : Date.now() - this.voiceRecordingStartedAt;
      const nextTranscript = this.buildVoiceDraft(result.text);
      this.trackOverlayEvent('overlay_voice_finished', {
        durationMs,
        hasTranscript: Boolean(result.text),
        transcriptLength: result.text.length,
      });
      this.voiceRecordingStartedAt = null;
      this.voiceRecordingStoppedAt = Date.now();
      this.voiceDraftBase = nextTranscript;
      this.voiceRecordingTranscript = '';
      this.send({ transcript: nextTranscript });
    } catch (error) {
      console.error('[InterpreterOverlay] STT stop error:', error);
      this.trackOverlayError('overlay_voice_stop_failed', getErrorMessage(error));
      this.voiceRecordingStartedAt = null;
      this.voiceRecordingStoppedAt = Date.now();
    } finally {
      this.overlay.requestInputFocus();
    }
  }

  private handleRunFinished(result: AgentRunResult): void {
    const durationMs = this.runStartedAt === null ? undefined : Date.now() - this.runStartedAt;
    const inputMethod = this.lastRunInputMethod;
    this.runStartedAt = null;
    this.lastRunInputMethod = null;

    if (result.status === 'cancelled') {
      this.finishDebugRun('cancelled', result.finalText, result.reason ?? 'cancelled');
      this.trackOverlayEvent('overlay_run_cancelled', {
        durationMs,
        inputMethod,
      });
      this.send({
        mode: 'idle',
        action: null,
        ghosts: [],
        pill: { kind: 'hidden' },
        ctrlPressed: false,
        shiftPressed: false,
      });
      return;
    }

    if (result.status === 'failed') {
      const reason = classifyOverlayRunFailure(result.reason || result.finalText);
      this.finishDebugRun('failed', result.finalText, reason);
      this.trackOverlayError('overlay_run_failed', 'Overlay run failed', {
        durationMs,
        inputMethod,
        reason,
      });
      this.send({
        mode: 'idle',
        action: null,
        ghosts: [],
        pill: { kind: 'hidden' },
        ctrlPressed: false,
        shiftPressed: false,
      });
      return;
    }

    this.finishDebugRun('completed', result.finalText, result.reason ?? 'completed');
    this.trackOverlayEvent('overlay_run_completed', {
      durationMs,
      inputMethod,
      outputLength: result.finalText.length,
    });
    void this.recordOverlayFirstSuccessfulUse().catch((error) => {
      this.trackOverlayError('overlay_first_success_record_failed', getErrorMessage(error));
    });
    this.send({
      mode: 'idle',
      action: null,
      ghosts: [],
      pill: { kind: 'hidden' },
      ctrlPressed: false,
      shiftPressed: false,
    });
  }

  getOverlayState(): OverlayState {
    return { ...this.overlayState };
  }

  focusInputOverlay(): void {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    this.overlay.setFocusable(true);
    this.overlay.disableMouseEvents();
    this.showOverlayOnInteractionDisplay();
    this.overlay.focus();
    this.overlay.requestInputFocus();
  }

  pasteClipboardIntoInputOverlay(): void {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    this.overlay.pasteIntoInput();
  }

  replaceInputOverlayWithClipboard(): void {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    this.overlay.replaceInputWithClipboard();
  }

  setInputOverlayText(text: string): void {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    this.cancelVoiceTimer();
    this.send({ transcript: text });
  }

  async getTextControllerContextPromptForDebug(input: {
    text?: string;
    submittedContextItems?: OverlayContextItem[];
    attachments?: OverlayUserAttachment[];
    workspacePath?: string | null;
    targetWindowSessionKey?: string | null;
    profileId?: string;
  } = {}): Promise<{
    prompt: string;
    text: string;
    contextItemCount: number;
    referenceContextCount: number;
    targetContextId: string | null;
    targetContextLabel: string | null;
    targetIdentityId: string | null;
    wholeComputerState: OverlayWholeComputerState;
  }> {
    const profileId = input.profileId ?? await this.resolveOverlayTextAgentProfileId();
    const request = buildOverlayTextControllerRequest({
      text: input.text ?? this.overlayState.transcript,
      serviceContextItems: this.overlayState.contextItems,
      submittedContextItems: input.submittedContextItems,
      attachments: input.attachments,
      workspacePath: input.workspacePath ?? null,
      targetWindowSessionKey: input.targetWindowSessionKey ?? null,
      profileId,
      renderedProfileId: null,
      inputMethod: 'text',
      managedContext: this.overlayTextManagedContext,
    });
    const wholeComputerState = await this.buildOverlayWholeComputerState({
      workspacePath: request.workspacePath,
      targetWindowSessionKey: request.targetWindowSessionKey,
      targetContext: request.targetContext,
      contextItems: request.contextItems,
    });
    const prompt = buildOverlayTextControllerContextPrompt(request, {
      availableToolsText: buildOverlayTextControllerToolCatalogText(),
      wholeComputerState,
      customInstructions: await getCustomInstructions(),
    });
    return {
      prompt,
      text: request.text,
      contextItemCount: request.contextItems.length,
      referenceContextCount: request.contextItems.filter((item) => item.role === 'reference').length,
      targetContextId: request.targetContext?.id ?? null,
      targetContextLabel: request.targetContext?.label ?? null,
      targetIdentityId: request.targetContext?.targetIdentity.id ?? null,
      wholeComputerState,
    };
  }

  async submitInputOverlay(): Promise<void> {
    if (this.overlayState.mode !== 'input') {
      return;
    }
    const profileId = await this.resolveOverlayTextAgentProfileId();

    console.log('[InterpreterOverlay] submitting input overlay', {
      transcriptLength: this.overlayState.transcript.length,
      profileId,
    });
    // Fire-and-forget like the real renderer submit path: the submit handler
    // can legitimately run for the whole typed fast-path loop (including
    // reviewed batches), and callers such as the debug server must not block
    // on run completion.
    void this.handleOverlayAction({} as Electron.IpcMainEvent, {
      type: 'submit',
      text: this.overlayState.transcript,
      attachments: [],
      workspacePath: null,
      targetWindowSessionKey: null,
      profileId,
    }).catch((error) => {
      console.error('[InterpreterOverlay] submit input overlay failed:', error);
    });
  }

  addInputOverlayFileReferences(files: OverlayFileContextItem[]): void {
    if (this.overlayState.mode !== 'input' || files.length === 0) {
      return;
    }

    void this.handleOverlayAction({} as Electron.IpcMainEvent, {
      type: 'files-dropped',
      files,
    });
  }

  selectInputOverlayTargetScopeForDebug(bounds: Bounds): void {
    if (process.env.FORM_TESTS_MODE !== 'true') {
      throw new Error('selectInputOverlayTargetScopeForDebug is only available in form tests mode');
    }
    if (this.overlayState.mode !== 'input') {
      throw new Error('Input overlay is not open.');
    }

    void this.handleOverlayAction({} as Electron.IpcMainEvent, {
      type: 'region-selected',
      bounds,
      role: 'target',
    });
  }

  isOverlayVisible(): boolean {
    return this.overlay.isVisible();
  }

  async startProgrammaticRun(prompt: string, options?: { systemAddendum?: string }): Promise<void> {
    if (!this.runtimeActive || !this.engine) {
      throw new Error('Interpreter Overlay runtime is not active');
    }

    const display = this.interactionDisplay ?? this.capture?.getActiveDisplay() ?? null;
    resetAutomationDebugTrace();
    resetOverlayTranscriptDebugEvents();
    this.runStartedAt = Date.now();
    this.lastRunInputMethod = 'text';
    this.beginDebugRun();
    showProgrammaticRunNotification(prompt);

    try {
      await this.engine.startProgrammaticRun(prompt, {
        display: display ?? undefined,
        scopeBounds: this.scopeBounds,
        systemAddendum: options?.systemAddendum,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.runStartedAt = null;
      this.lastRunInputMethod = null;
      this.finishDebugRun('start_failed', message, 'start_failed');
      throw error;
    }
  }

  async simulateEscape(): Promise<void> {
    await this.handleEscape();
  }

  setNextRunSystemAddendum(systemAddendum: string | null): void {
    const trimmed = typeof systemAddendum === 'string' ? systemAddendum.trim() : '';
    this.nextRunSystemAddendum = trimmed || null;
  }

  async captureContext(): Promise<InterpreterOverlayCapturedContext> {
    return await this.captureContextForScope({
      displayId: this.interactionDisplay?.id,
      scopeBounds: this.scopeBounds,
    });
  }

  private async getOverlayBootstrapData(): Promise<OverlayBootstrapData> {
    await ensureFormTestsOverlayAgentProfile();

    const currentWorkspacePath = getCurrentWorkspace();
    const currentWorkspaceName = currentWorkspacePath
      ? path.basename(currentWorkspacePath) || currentWorkspacePath
      : null;
    const openSessions = listWindowSessions().filter(
      (record): record is typeof record & { workspacePath: string } => typeof record.workspacePath === 'string',
    );

    const openWorkspaces = buildOverlayOpenWorkspaceOptions(openSessions);

    const recentFolders = await getRecentFolders();
    const recentWorkspaces = recentFolders
      .filter((folder) => typeof folder.path === 'string' && folder.path.length > 0)
      .map((folder) => {
        const workspaceName = folder.name || path.basename(folder.path) || folder.path;
        return {
          workspacePath: folder.path,
          workspaceName,
          label: workspaceName,
          lastOpened: folder.lastOpened,
        };
      });

    const profilesResponse = await listProfiles();
    const profiles = addFormTestsOverlayAgentProfile(
      (profilesResponse.profiles as Profile[]).filter((profile) => !isTerminalProfile(profile)),
    );
    const profileOptions = buildOverlayProfileOptions(
      profiles,
      profilesResponse.defaultProfileId,
      this.currentSettings.preferredProfileId,
    );

    return {
      currentWorkspacePath,
      currentWorkspaceName,
      openWorkspaces,
      recentWorkspaces,
      profiles: profileOptions.profileOptions,
      defaultProfileId: profileOptions.defaultProfileId,
      preferredWorkspacePath: this.currentSettings.preferredWorkspacePath,
      preferredWorkspaceName: this.currentSettings.preferredWorkspacePath
        ? path.basename(this.currentSettings.preferredWorkspacePath) || this.currentSettings.preferredWorkspacePath
        : null,
      preferredNoWorkspace: this.currentSettings.preferredNoWorkspace,
      preferredProfileId: profileOptions.preferredProfileId,
    };
  }

  private async resolveOverlayTargetWindow(
    workspacePath: string | null,
    targetWindowSessionKey: string | null,
    options?: { background?: boolean },
  ): Promise<{
    workspacePath: string | null;
    targetWindowSessionKey: string;
    targetWindowId: number;
  }> {
    const explicitWindow = getWindowSessionByKey(targetWindowSessionKey);
    if (explicitWindow) {
      return {
        workspacePath: explicitWindow.workspacePath,
        targetWindowSessionKey: explicitWindow.sessionKey,
        targetWindowId: explicitWindow.windowId,
      };
    }

    const windowSessions = listWindowSessions();
    const matchingWindow = workspacePath === null
      ? windowSessions[0]
      : windowSessions.find((record) => record.workspacePath === workspacePath);
    if (matchingWindow) {
      return {
        workspacePath: matchingWindow.workspacePath,
        targetWindowSessionKey: matchingWindow.sessionKey,
        targetWindowId: matchingWindow.windowId,
      };
    }

    const createdWindow = await this.createWorkstationWindow({
      sourceWindowId: null,
      workspacePath,
      background: options?.background ?? true,
    });
    if (!createdWindow.success) {
      throw new Error(createdWindow.error);
    }

    return {
      workspacePath,
      targetWindowSessionKey: createdWindow.sessionKey,
      targetWindowId: createdWindow.windowId,
    };
  }

  private async resolveOverlayAgentProfile(profileId: string): Promise<Profile> {
    await ensureFormTestsOverlayAgentProfile();

    const profilesResponse = await listProfiles();
    const profiles = addFormTestsOverlayAgentProfile(
      (profilesResponse.profiles as Profile[]).filter((profile) => !isTerminalProfile(profile)),
    );
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new Error(`Interpreter profile "${profileId}" is no longer available.`);
    }
    return profile;
  }

  private async resolveOverlayAgentProfileByModelSetting(
    requested: string,
    missingMessage: string,
  ): Promise<Profile> {
    await ensureFormTestsOverlayAgentProfile();

    const profilesResponse = await listProfiles();
    const profiles = addFormTestsOverlayAgentProfile(
      (profilesResponse.profiles as Profile[]).filter((profile) => !isTerminalProfile(profile)),
    );
    const profile = profiles.find((candidate) => candidate.id === requested || candidate.modelId === requested);
    if (profile) {
      return profile;
    }
    throw new Error(missingMessage);
  }

  private async resolveHiddenAgentProfile(): Promise<Profile> {
    const modelTaskProfiles = resolveOverlayModelTaskProfileIds(this.effectiveSettings);
    return this.resolveOverlayAgentProfileByModelSetting(
      modelTaskProfiles.hiddenAgentProfileId,
      'No Interpreter agent profiles are available for hidden agents.',
    );
  }

  private async resolveOverlayTextAgentProfileId(): Promise<string> {
    await ensureFormTestsOverlayAgentProfile();

    const profilesResponse = await listProfiles();
    const profiles = addFormTestsOverlayAgentProfile(
      (profilesResponse.profiles as Profile[]).filter((profile) => !isTerminalProfile(profile)),
    );
    const profileOptions = buildOverlayProfileOptions(
      profiles,
      profilesResponse.defaultProfileId,
      this.currentSettings.preferredProfileId,
    );
    const profileId = profileOptions.preferredProfileId ?? profileOptions.defaultProfileId;
    if (!profileId) {
      throw new Error('No Interpreter agent profiles are available for overlay text control.');
    }
    return profileId;
  }

  private async buildOverlaySystemPrompt(
    session: OverlaySessionRecord,
    systemAddendum?: string | null,
  ): Promise<string> {
    const captureBounds = session.initialContext.captureBoundsDIP
      ?? session.scopeBoundsDIP
      ?? session.initialContext.displayBoundsDIP
      ?? null;
    const basePrompt = buildOverlayMainAgentSystemPrompt({
      mode: session.initialContext.agentMode,
      grantedSquare: formatOverlayBounds(captureBounds),
      displayId: session.displayId,
      elementCount: session.initialContext.elementCount,
      initialScreenshotPath: session.initialContext.screenshotPath?.trim() || null,
    });
    return appendOverlayPromptExtras(basePrompt, {
      systemAddendum,
      customInstructions: await getCustomInstructions(),
    });
  }

  private buildOverlayLaunchMessage(
    prompt: string,
    initialContext: Pick<
      InterpreterOverlayCapturedContext,
      'formattedText' | 'screenshotPath' | 'targetIdentity' | 'currentSelectionContext'
    >,
    targetContext: OverlayRegionContextItem | null,
    attachmentMentions: string[] = [],
  ): string {
    const screenshotMention = this.buildOverlayScreenshotFileMention(
      initialContext.screenshotPath,
      targetContext,
    );
    const promptBody = prependOverlayMentions(
      prompt,
      [screenshotMention, ...attachmentMentions].filter(
        (mention): mention is string => Boolean(mention),
      ),
    );
    const userRequest = `<user_request>
${promptBody}
</user_request>`;
    const contextText = initialContext.formattedText.trim();
    if (!contextText) {
      return userRequest;
    }
    return `${contextText}\n\n${userRequest}`;
  }

  private buildOverlayScreenshotFileMention(
    screenshotPath: string | undefined,
    targetContext: OverlayRegionContextItem | null,
  ): string | null {
    const trimmedPath = screenshotPath?.trim();
    if (!trimmedPath) {
      return null;
    }

    const label = targetContext?.label ?? 'Screen contents';
    const safePath = trimmedPath.replace(/>/g, '%3E');
    return `@[${label}](<${safePath}>)`;
  }

  private async persistOverlayUserAttachmentMentions(
    userAttachments: OverlayUserAttachment[],
  ): Promise<string[]> {
    if (userAttachments.length === 0) {
      return [];
    }

    await fs.mkdir(OVERLAY_CONTEXT_TMP_DIR, { recursive: true });

    const mentions: string[] = [];
    for (const attachment of userAttachments) {
      if (attachment.kind === 'file' && attachment.filePath) {
        mentions.push(formatOverlayFileMention(attachment.name || path.basename(attachment.filePath), attachment.filePath));
        continue;
      }
      if (!attachment.dataUrl) {
        continue;
      }
      const { mimeType, buffer } = parseBase64DataUrl(attachment.dataUrl);
      const extension = getImageExtensionForAttachment(
        attachment.name,
        attachment.mimeType || mimeType,
      );
      const stem = sanitizeFilenameSegment(
        path.basename(attachment.name, path.extname(attachment.name)),
      ) || 'overlay-image';
      const filePath = path.join(
        OVERLAY_CONTEXT_TMP_DIR,
        `overlay-input-${Date.now()}-${randomUUID()}-${stem}${extension}`,
      );
      await fs.writeFile(filePath, buffer);
      mentions.push(formatOverlayFileMention(attachment.name || path.basename(filePath), filePath));
    }

    return mentions;
  }

  private buildNormalAgentAttachmentsFromContextItems(
    contextItems: OverlayContextItem[],
  ): OverlayUserAttachment[] {
    const regionImageAttachments = contextItems.flatMap((item): OverlayUserAttachment[] => {
      if (item.kind === 'region' && item.role === 'reference' && item.previewImageDataUrl) {
        return [{
          id: `${item.id}-image`,
          kind: 'image',
          name: item.label,
          mimeType: 'image/png',
          dataUrl: item.previewImageDataUrl,
        }];
      }
      return [];
    });
    const fileImageAttachments = contextItems.flatMap((item): OverlayUserAttachment[] => {
      if (item.kind === 'file' && item.mimeType.startsWith('image/') && (item.dataUrl || item.filePath)) {
        return [{
          id: item.id,
          kind: 'image',
          name: item.name,
          mimeType: item.mimeType,
          dataUrl: item.dataUrl,
          filePath: item.filePath ?? undefined,
          sizeBytes: item.sizeBytes,
        }];
      }
      return [];
    });
    const contextFileAttachments = contextItems.flatMap((item): OverlayUserAttachment[] => {
      if (item.kind !== 'file' || item.mimeType.startsWith('image/')) {
        return [];
      }
      return [{
        id: item.id,
        kind: 'file',
        name: item.name,
        mimeType: item.mimeType,
        filePath: item.filePath ?? undefined,
        dataUrl: item.dataUrl,
        sizeBytes: item.sizeBytes,
      }];
    });
    return [...regionImageAttachments, ...fileImageAttachments, ...contextFileAttachments];
  }

  private readonly handleOverlayGetBootstrap = async (): Promise<OverlayBootstrapData> => {
    return await this.getOverlayBootstrapData();
  };

  private readonly handleOverlayListSkills = async (
    _event: Electron.IpcMainInvokeEvent,
    request?: { workspacePath?: string | null },
  ): Promise<OverlaySkillsResponse> => {
    try {
      return {
        success: true,
        data: await getSkills(request?.workspacePath ?? null),
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  };

  private readonly handleOverlayChooseWorkspaceFolder = async (): Promise<Electron.OpenDialogReturnValue> => {
    const overlayWindow = this.overlay.getWindow();
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      buttonLabel: 'Select Workspace',
    };

    if (overlayWindow) {
      return await dialog.showOpenDialog(overlayWindow, dialogOptions);
    }

    return await dialog.showOpenDialog(dialogOptions);
  };

  private readonly handleOverlaySetSelectionPreferences = async (
    _event: Electron.IpcMainInvokeEvent,
    preferences?: { workspacePath?: string | null; noWorkspace?: boolean; profileId?: string | null },
  ): Promise<void> => {
    const preferredWorkspacePath = typeof preferences?.workspacePath === 'string'
      ? preferences.workspacePath
      : null;
    const preferredNoWorkspace = preferences?.noWorkspace === true;
    const preferredProfileId = typeof preferences?.profileId === 'string'
      ? preferences.profileId
      : null;

    if (
      this.currentSettings.preferredWorkspacePath === preferredWorkspacePath
      && this.currentSettings.preferredNoWorkspace === preferredNoWorkspace
      && this.currentSettings.preferredProfileId === preferredProfileId
    ) {
      return;
    }

    const nextSettings = await setInterpreterOverlaySettings({
      ...this.currentSettings,
      preferredWorkspacePath,
      preferredNoWorkspace,
      preferredProfileId,
    });
    this.currentSettings = nextSettings;
    this.effectiveSettings = {
      ...this.effectiveSettings,
      preferredWorkspacePath: nextSettings.preferredWorkspacePath,
      preferredNoWorkspace: nextSettings.preferredNoWorkspace,
      preferredProfileId: nextSettings.preferredProfileId,
    };
  };

  async createAgentToolSession(
    options: Omit<OverlaySessionCreateOptions, 'displayId' | 'scopeBoundsDIP' | 'initialContext'> & {
      targetContext?: OverlayRegionContextItem | null;
    },
  ): Promise<OverlaySessionRecord> {
    if (!this.runtimeActive || !this.capture) {
      throw new Error('Interpreter Overlay runtime is not active');
    }

    const display = this.interactionDisplay ?? this.capture.getActiveDisplay();
    const initialContext = await this.captureContextForScope({
      displayId: display.id,
      scopeBounds: this.scopeBounds,
      persistScreenshotToTmp: true,
      targetContext: options.targetContext,
      targetWindowSessionKey: options.windowSessionKey,
    });
    this.engine?.endAttachedToolSession();
    overlaySessionManager.clearAll();
    this.engine?.startAttachedToolSession({
      display,
      scopeBounds: this.scopeBounds,
      formattedText: initialContext.formattedText,
      elements: mergeSelectedContextRefsIntoRunEngineElements(
        initialContext.elements,
        initialContext.currentSelectionContext,
      ),
      screenshotBase64: initialContext.screenshotBase64 ?? null,
      targetIdentity: initialContext.targetIdentity ?? null,
    });
    const session = overlaySessionManager.createSession({
      agentId: options.agentId,
      callerToken: options.callerToken,
      workspacePath: options.workspacePath,
      windowSessionKey: options.windowSessionKey,
      displayId: display.id,
      scopeBoundsDIP: this.scopeBounds,
      initialContext,
      targetContext: options.targetContext ?? null,
    });
    this.activeAttachedSessionId = session.id;
    this.activeAttachedAgentId = session.agentId;
    return session;
  }

  async showInputOverlayForDebug(): Promise<void> {
    if (process.env.FORM_TESTS_MODE !== 'true') {
      throw new Error('showInputOverlayForDebug is only available in form tests mode');
    }
    await this.showInputMode(true);
  }

  dismissInputOverlayForDebug(): void {
    if (process.env.FORM_TESTS_MODE !== 'true') {
      throw new Error('dismissInputOverlayForDebug is only available in form tests mode');
    }
    this.notePresentationCloseRequested('debug_attached_cli_session');
    this.send({
      ...DEFAULT_OVERLAY_STATE,
      screenshot: null,
      transcript: '',
      isRecording: false,
      amplitude: 0,
      ctrlPressed: false,
      shiftPressed: false,
    });
    this.resetOverlayInputTracking();
  }

  private async captureContextForScope(options: {
    displayId?: string | null;
    scopeBounds?: Bounds | null;
    persistScreenshotToTmp?: boolean;
    targetContext?: OverlayRegionContextItem | null;
    targetWindowSessionKey?: string | null;
  }): Promise<InterpreterOverlayCapturedContext> {
    if (!this.runtimeActive || !this.capture) {
      throw new Error('Interpreter Overlay runtime is not active');
    }

    const display = options.displayId
      ? this.capture.getDisplayById(options.displayId)
      : this.interactionDisplay ?? this.capture.getActiveDisplay();
    const captureBounds = OVERLAY_VISION_MODE
      ? { ...display.boundsDIP }
      : getDisplayViewport(display, options.scopeBounds ?? null);
    if (!captureBounds) {
      throw new Error('Selected scope is outside the active display');
    }
    const { base64 } = await this.capture.captureDisplay(
      display,
      OVERLAY_VISION_MODE ? undefined : captureBounds,
    );
    let normalizedStructuredContext: {
      formattedText: string;
      elements: ScreenElement[];
    } = {
      formattedText: '',
      elements: [],
    };

    if (overlaySupportsAccessibilityContext()) {
      const segmentedResult = await performSegmentedOCR(
        Buffer.from(base64, 'base64'),
        display.scaleFactor,
        { scopeBounds: captureBounds },
      );
      normalizedStructuredContext = normalizeStructuredContext(
        segmentedResult.formattedText,
        segmentedResult.elements,
      );
    }
    const screenshotPath = options.persistScreenshotToTmp
      ? await this.writeContextScreenshotToTmp(base64)
      : undefined;
    const targetBounds = options.scopeBounds ?? captureBounds;
    const capturedTargetContext = options.targetContext
      ? await this.buildCapturedTargetContext({
          targetContext: options.targetContext,
          display,
          targetBounds,
          targetWindowSessionKey: options.targetWindowSessionKey ?? null,
        })
      : null;
    const targetIdentity = capturedTargetContext?.targetIdentity ?? buildOverlayTargetIdentity({
      kind: getOverlayRegionScopeKind(targetBounds, display),
      bounds: targetBounds,
      display,
      targetWindowSessionKey: options.targetWindowSessionKey ?? null,
    });
    const currentSelectionContext = capturedTargetContext?.currentSelectionContext ?? buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: normalizedStructuredContext.elements.map((element) => ({
        id: element.id,
        role: element.role,
        label: element.label,
        bounds: { ...element.bbox },
      })),
    });

    return {
      agentMode: INTERPRETER_OVERLAY_AGENT_MODE,
      formattedText: normalizedStructuredContext.formattedText,
      elementCount: normalizedStructuredContext.elements.length,
      elements: normalizedStructuredContext.elements,
      screenshotBase64: base64,
      screenshotPath,
      displayScaleFactor: display.scaleFactor,
      displayBoundsDIP: display.boundsDIP,
      captureBoundsDIP: captureBounds,
      targetIdentity,
      currentSelectionContext,
    };
  }

  private async buildCapturedTargetContext(input: {
    targetContext: OverlayRegionContextItem;
    display: DisplayInfo;
    targetBounds: Bounds;
    targetWindowSessionKey: string | null;
  }): Promise<Pick<InterpreterOverlayCapturedContext, 'targetIdentity' | 'currentSelectionContext'>> {
    const refreshedSelectableElements = await this.loadAttachedTargetSelectableElements(input);
    return buildAttachedTargetContextSnapshot({
      targetContext: input.targetContext,
      display: input.display,
      targetBounds: input.targetBounds,
      targetWindowSessionKey: input.targetWindowSessionKey,
      refreshedSelectableElements,
    });
  }

  private async loadAttachedTargetSelectableElements(input: {
    targetContext: OverlayRegionContextItem;
    display: DisplayInfo;
    targetBounds: Bounds;
  }): Promise<OverlaySelectionElement[] | null> {
    const nativeRefresh = getNativeCuaSelectionRefreshRequest(input.targetContext);
    if (!nativeRefresh) {
      return null;
    }
    const mode = resolveCuaAccessPolicyMode(
      await getCuaAccessPolicy(),
      nativeRefresh.appName,
      'inspect',
    );
    if (mode !== 'all') {
      throw new Error(`Cannot refresh selected native CUA target refs for ${nativeRefresh.appName}: inspect policy is ${mode}`);
    }
    return await loadCuaRegionSelectionElements({
      agentId: createOverlayAgentId(),
      workspacePath: getCurrentWorkspace(),
      profileId: null,
      appName: nativeRefresh.appName,
      targetIdentity: nativeRefresh.targetIdentity,
      regionBounds: input.targetBounds,
      display: input.display,
    });
  }

  private async writeContextScreenshotToTmp(base64: string): Promise<string> {
    const filePath = path.join(OVERLAY_CONTEXT_TMP_DIR, `overlay-scope-${Date.now()}-${randomUUID()}.png`);
    await fs.mkdir(OVERLAY_CONTEXT_TMP_DIR, { recursive: true });
    await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
    return filePath;
  }

  private getSessionDisplay(session: OverlaySessionRecord): DisplayInfo {
    if (!this.capture) {
      throw new Error('Interpreter Overlay runtime is not active');
    }
    return this.capture.getDisplayById(session.displayId);
  }

  private showAttachedToolDrawings(session: OverlaySessionRecord, request: OverlayDrawingRequest): void {
    const display = this.getSessionDisplay(session);
    this.interactionDisplay = display;
    const actions = request.annotations.map((annotation, index): ReviewAction => {
      const id = `overlay-drawing-${annotation.id ?? index + 1}-${randomUUID()}`;
      return {
        id,
        type: 'click',
        description: annotation.label ?? annotation.id ?? `Drawing ${index + 1}`,
        detail: 'overlay drawing',
        bounds: toLocalBounds(annotation.bounds, display.boundsDIP),
        hasBounds: true,
        showLabel: Boolean(annotation.label),
      };
    });

    this.activeOverlayDrawingIds = new Set(actions.map((action) => action.id));
    this.send({
      mode: 'working',
      action: actions[0] ?? null,
      ghosts: actions.slice(1),
      pill: { kind: 'hidden' },
      scopeBounds: session.scopeBoundsDIP ? toLocalBounds(session.scopeBoundsDIP, display.boundsDIP) : null,
      ctrlPressed: false,
      shiftPressed: false,
    });
  }

  private clearAttachedToolDrawings(): void {
    const currentIds = [
      this.overlayState.action?.id,
      ...this.overlayState.ghosts.map((ghost) => ghost.id),
    ].filter((id): id is string => Boolean(id));
    const currentStateIsDrawing = currentIds.length > 0
      && currentIds.every((id) => this.activeOverlayDrawingIds.has(id));
    this.activeOverlayDrawingIds.clear();
    if (!currentStateIsDrawing) {
      return;
    }
    this.send({
      mode: 'idle',
      action: null,
      ghosts: [],
      pill: { kind: 'hidden' },
      ctrlPressed: false,
      shiftPressed: false,
    });
  }

  private setAutomationPreferredTargetWindow(windowSessionKey: string | null): void {
    if (!this.automation) {
      return;
    }

    if (!windowSessionKey) {
      this.automation.setPreferredWindowActivator(null);
      return;
    }

    this.automation.setPreferredWindowActivator(async () => {
      const targetWindowSession = getWindowSessionByKey(windowSessionKey);
      const targetWindow = targetWindowSession
        ? BrowserWindow.fromId(targetWindowSession.windowId)
        : null;

      if (!targetWindow || targetWindow.isDestroyed()) {
        console.warn('[InterpreterOverlay] Preferred target window missing during attached tool activation', {
          windowSessionKey,
        });
        return false;
      }

      targetWindow.show();
      targetWindow.focus();
      return true;
    });
  }

  private buildOverlayAgentLaunchManagedToolCall(input: {
    agentId?: string | null;
    target: 'overlay_target' | 'workspace';
    profileId: string;
    workspacePath: string | null;
    targetWindowSessionKey: string | null;
    allowedToolCount: number;
    initialElementCount: number | null;
    activate: boolean;
    resultText: string | null;
    permissionResultText?: string | null;
  }): OverlayTextControllerManagedToolCall {
    return {
      serverId: 'builtin-agent-windows',
      toolName: 'launch_agent_window',
      args: {
        ...(input.agentId ? { agent_id: input.agentId } : {}),
        target: input.target,
        profile_id: input.profileId,
        workspace_path: input.workspacePath,
        target_window_session_key: input.targetWindowSessionKey,
        allowed_tool_count: input.allowedToolCount,
        initial_element_count: input.initialElementCount,
        activate: input.activate,
        completion_disposition: 'keep_open',
      },
      resultText: input.resultText,
      permissionResultText: input.permissionResultText ?? null,
    };
  }

  private async syncAttachedToolContext(
    session: OverlaySessionRecord,
  ): Promise<InterpreterOverlayCapturedContext> {
    this.requireAttachedToolSession(session);
    // Attached overlay actions should activate the user's target window by
    // coordinates, not surface the workstation window in front of everything.
    this.setAutomationPreferredTargetWindow(null);
    this.interactionDisplay = this.getSessionDisplay(session);
    const liveScopeBounds = this.getLiveAttachedScopeBounds(session);
    session.scopeBoundsDIP = liveScopeBounds;
    this.scopeBounds = liveScopeBounds;
    const context = await this.captureContextForScope({
      displayId: session.displayId,
      scopeBounds: liveScopeBounds,
      persistScreenshotToTmp: true,
      targetWindowSessionKey: session.windowSessionKey,
      targetContext: session.targetContext,
    });
    this.engine?.startAttachedToolSession({
      display: this.getSessionDisplay(session),
      scopeBounds: liveScopeBounds,
      formattedText: context.formattedText,
      elements: mergeSelectedContextRefsIntoRunEngineElements(
        context.elements,
        context.currentSelectionContext,
      ),
      screenshotBase64: context.screenshotBase64 ?? null,
      targetIdentity: context.targetIdentity ?? null,
    });
    return context;
  }

  private async executeAttachedToolWithRunEngine(
    session: OverlaySessionRecord,
    tool: ToolCall,
  ): Promise<ToolExecutionResult | undefined> {
    this.requireAttachedToolSession(session);
    if (!this.engine) {
      throw new Error('Interpreter Overlay runtime is not active');
    }

    this.setAutomationPreferredTargetWindow(null);
    this.interactionDisplay = this.getSessionDisplay(session);
    const liveScopeBounds = this.getLiveAttachedScopeBounds(session);
    session.scopeBoundsDIP = liveScopeBounds;
    this.scopeBounds = liveScopeBounds;
    if (!this.overlayState.worldPinActive) {
      await this.beginPinningWorldOverlayToTarget();
    }
    const result = await this.engine.runAttachedToolCall(tool, {
      display: this.interactionDisplay,
      scopeBounds: liveScopeBounds,
    });
    this.requireAttachedToolSession(session);
    if (!result.success) {
      if (result.result?.kind === 'text' && result.result.isError) {
        // Staged batch actions rejected by validation before execution: raise
        // the typed rejection so the bridge reports an explicit invalid-action
        // status instead of a completed batch with no observed change.
        throw new OverlayInvalidBatchActionError(result.error || `Interpreter Overlay ${tool.name} rejected the staged actions.`);
      }
      throw new Error(result.error || `Interpreter Overlay ${tool.name} failed.`);
    }
    return result.result;
  }

  private async executeNativeCuaOverlayToolCall(
    session: OverlaySessionRecord,
    toolCall: NativeCuaOverlayToolCall | null,
    options: { reviewedOverlayAction?: boolean } = {},
  ): Promise<boolean> {
    if (!toolCall) {
      return false;
    }
    const result = await callInterpreterTool(
      toolCall.serverId,
      toolCall.toolName,
      toolCall.args,
      undefined,
      buildOverlayToolManagerIdentity({
        agentId: session.agentId,
        workspacePath: session.workspacePath,
        profileId: null,
        overlayReviewedAction: options.reviewedOverlayAction === true,
      }),
      { includeHiddenBuiltins: true },
    ) as ToolCallResponse;
    if (result.isError) {
      const message = result.content
        .map((item) => (typeof item.text === 'string' ? item.text : null))
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(message || `Interpreter Overlay native CUA ${toolCall.toolName} failed.`);
    }
    return true;
  }

  private async executeNativeCuaToolCallForActiveOverlaySession(
    toolCall: NativeCuaOverlayToolCall,
  ): Promise<void> {
    const session = overlaySessionManager.getSessionForAgent(this.activeAttachedAgentId ?? undefined);
    await this.executeNativeCuaOverlayToolCall(session, toolCall, { reviewedOverlayAction: true });
  }

  private async executeBrowserPageOverlayToolCall(
    session: OverlaySessionRecord,
    toolCall: BrowserPageOverlayToolCall | null,
  ): Promise<boolean> {
    if (!toolCall) {
      return false;
    }
    const result = await callInterpreterTool(
      toolCall.serverId,
      toolCall.toolName,
      toolCall.args,
      undefined,
      buildOverlayToolManagerIdentity({
        agentId: session.agentId,
        workspacePath: session.workspacePath,
        profileId: null,
      }),
      { includeHiddenBuiltins: true },
    ) as ToolCallResponse;
    if (result.isError) {
      const message = result.content
        .map((item) => (typeof item.text === 'string' ? item.text : null))
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(message || `Interpreter Overlay browser page ${toolCall.toolName} failed.`);
    }
    return true;
  }

  private async executeBrowserPageToolCallForActiveOverlaySession(
    toolCall: BrowserPageOverlayToolCall,
  ): Promise<void> {
    const session = overlaySessionManager.getSessionForAgent(this.activeAttachedAgentId ?? undefined);
    await this.executeBrowserPageOverlayToolCall(session, toolCall);
  }

  private getLiveAttachedScopeBounds(session: OverlaySessionRecord): Bounds | null {
    if (
      this.activeAttachedSessionId === session.id
      && this.overlayState.worldPinActive
      && this.scopeBounds
    ) {
      return { ...this.scopeBounds };
    }

    return session.scopeBoundsDIP ? { ...session.scopeBoundsDIP } : null;
  }

  private requireAttachedToolSession(session: OverlaySessionRecord): void {
    if (!this.runtimeActive || !this.engine) {
      throw new Error('Interpreter Overlay runtime is not active');
    }

    if (this.activeAttachedSessionId !== session.id) {
      throw new Error('This overlay session is no longer attached.');
    }
  }

  private async detachAttachedToolSession(
    session: OverlaySessionRecord,
    reason: 'agent_detach' | 'agent_complete',
  ): Promise<void> {
    this.requireAttachedToolSession(session);
    this.setAutomationPreferredTargetWindow(null);
    this.engine?.endAttachedToolSession();
    this.activeAttachedSessionId = null;
    this.activeAttachedAgentId = null;
    this.notePresentationCloseRequested(reason);
    if (this.overlayState.mode === 'idle' && this.pinnedTarget) {
      // The send() state machine unpins the world overlay on the
      // working/review -> idle transition. A completed run can land here with
      // the state already idle (the run engine settles to idle after the last
      // batch), so close the world pin explicitly or it stays glued to the
      // target forever.
      this.resetOverlaySelectionState();
      this.scopeSelectionInProgress = false;
      this.endPinningWorldOverlay(WORLD_OVERLAY_CLOSE_FADE_MS);
    }
    this.send({
      ...DEFAULT_OVERLAY_STATE,
      screenshot: null,
      transcript: '',
      isRecording: false,
      amplitude: 0,
      ctrlPressed: false,
      shiftPressed: false,
    });
    this.resetOverlayInputTracking();
    this.runStartedAt = null;
    this.lastRunInputMethod = null;
    if (this.debugRunState.status === 'running') {
      this.finishDebugRun(
        'completed',
        reason === 'agent_complete'
          ? 'Interpreter Overlay session completed.'
          : 'Interpreter Overlay session detached.',
        reason,
      );
    }
  }

  private async handleAutomationEmergencyStop(position: { x: number; y: number }): Promise<void> {
    console.warn('[InterpreterOverlay] Emergency stop triggered', {
      position,
      mode: this.overlayState.mode,
      activeAttachedSessionId: this.activeAttachedSessionId,
      runStatus: this.debugRunState.status,
    });
    this.trackOverlayEvent('overlay_emergency_stopped', {
      x: position.x,
      y: position.y,
      mode: this.overlayState.mode,
      activeAttachedSessionId: this.activeAttachedSessionId ?? undefined,
    });
    this.engine?.endAttachedToolSession();
    overlaySessionManager.clearAll();
    this.activeAttachedSessionId = null;
    this.activeAttachedAgentId = null;
    this.cancelVoiceTimer();
    if (this.isVoiceInputActive) {
      this.stt?.abortRecording();
      this.isVoiceInputActive = false;
    }
    this.notePresentationCloseRequested('emergency_stop');
    this.send({
      ...DEFAULT_OVERLAY_STATE,
      screenshot: null,
      transcript: '',
      isRecording: false,
      amplitude: 0,
      ctrlPressed: false,
      shiftPressed: false,
    });
    this.resetOverlayInputTracking();
    this.runStartedAt = null;
    this.lastRunInputMethod = null;
    if (this.debugRunState.status === 'running') {
      this.finishDebugRun(
        'cancelled',
        'Interpreter Overlay emergency stop triggered at screen origin (0,0).',
        'emergency_stop',
      );
    }
    this.engine?.handleEscape();
  }

  getAgentDebugContext(): InterpreterOverlayAgentDebugContext {
    const engineContext = this.engine?.getDebugContext() ?? {
      initialUserText: null,
      latestStructuredText: null,
      latestStructuredSnapshot: null,
    };
    return {
      ...engineContext,
      finalText: this.debugRunState.finalText,
      runStatus: this.debugRunState.status,
      runReason: this.debugRunState.reason,
      automationDebugTrace: getAutomationDebugTrace(),
      transcriptDebugTrace: getOverlayTranscriptDebugEvents(),
    };
  }

  forceResetForDebug(reason = 'debug_reset'): void {
    console.warn('[InterpreterOverlay] force reset requested', {
      reason,
      mode: this.overlayState.mode,
      activeAttachedSessionId: this.activeAttachedSessionId,
      runStatus: this.debugRunState.status,
    });
    this.setAutomationPreferredTargetWindow(null);
    this.engine?.endAttachedToolSession();
    overlaySessionManager.clearAll();
    this.activeAttachedSessionId = null;
    this.activeAttachedAgentId = null;
    this.cancelVoiceTimer();
    if (this.isVoiceInputActive) {
      this.stt?.abortRecording();
      this.isVoiceInputActive = false;
    }
    this.advancedVoice.stopAdvancedVoiceInput();
    this.clearWorldOverlayCloseTimer();
    this.clearProgressiveBlurCloseTimer();
    this.progressiveBlurHandoffPending = false;
    this.progressiveBlurClosePending = false;
    this.overlay.setWorldTargetMovedListener(null);
    this.overlay.unpinWorld();
    this.pinnedTarget = null;
    this.worldTargetBounds = null;
    this.overlay.disableMouseEvents();
    this.overlay.setFocusable(false);
    this.overlay.hide();
    this.notePresentationCloseRequested(reason);
    this.send({
      ...DEFAULT_OVERLAY_STATE,
      screenshot: null,
      transcript: '',
      isRecording: false,
      amplitude: 0,
      ctrlPressed: false,
      shiftPressed: false,
    });
    this.resetOverlayInputTracking();
    this.resetOverlaySelectionState();
    this.scopeSelectionInProgress = false;
    this.runStartedAt = null;
    this.lastRunInputMethod = null;
    if (this.debugRunState.status === 'running') {
      this.finishDebugRun('cancelled', 'Interpreter Overlay force reset requested.', reason);
    }
  }

  removeInputOverlayContextItemForDebug(id: string): void {
    if (process.env.FORM_TESTS_MODE !== 'true') {
      throw new Error('removeInputOverlayContextItemForDebug is only available in form tests mode');
    }
    this.removeOverlayContextItem(id);
  }

  async applySettingsForDebug(settings: InterpreterOverlaySettings): Promise<void> {
    if (process.env.FORM_TESTS_MODE !== 'true') {
      throw new Error('applySettingsForDebug is only available in form tests mode');
    }
    await this.applySettings(settings);
  }

  private async applySettings(settings: InterpreterOverlaySettings): Promise<void> {
    this.currentSettings = this.benchmarkMode
      ? {
          ...settings,
          enabled: true,
        }
      : settings;
    const currentAccountUserId = getCurrentOverlayAccountUserId();
    const accountScopedSettings = resolveOverlaySettingsForCurrentAccount(
      this.currentSettings,
      currentAccountUserId,
    );
    this.accessState = await getInterpreterOverlayAccessState();
    if (
      !this.benchmarkMode
      && accountScopedSettings.enabled
      && !this.accessState.allowed
    ) {
      const disabledSettings = await setInterpreterOverlaySettings({
        ...this.currentSettings,
        enabled: false,
        permissionSetupPending: false,
      });
      this.currentSettings = disabledSettings;
    }

    const effectiveAccountScopedSettings = resolveOverlaySettingsForCurrentAccount(
      this.currentSettings,
      currentAccountUserId,
    );
    this.effectiveSettings = resolveEffectiveOverlaySettings(
      effectiveAccountScopedSettings,
      this.accessState,
      this.benchmarkMode,
    );
    if (this.effectiveSettings.enabled && !this.baseUrl) {
      console.warn(
        '[InterpreterOverlay] Disabled because this distribution does not configure an overlay server',
      );
      this.effectiveSettings = {
        ...this.effectiveSettings,
        enabled: false,
      };
    }

    console.log('[InterpreterOverlay] applySettings', {
      configuredEnabled: this.currentSettings.enabled,
      effectiveEnabled: this.effectiveSettings.enabled,
      accountUserId: this.currentSettings.accountUserId,
      currentAccountUserId,
      accessAllowed: this.accessState.allowed,
      accessReason: this.accessState.reason,
      hotkey: this.effectiveSettings.hotkey,
    });

    if (this.effectiveSettings.enabled) {
      await this.activateRuntime();
    } else {
      this.deactivateRuntime();
    }

    this.refreshHotkeyRegistration();
  }

  private async activateRuntime(): Promise<void> {
    if (this.runtimeActive) {
      return;
    }

    this.overlay.create();
    if (process.platform === 'darwin' || process.platform === 'win32') {
      // Keep the desktop overlay renderer alive and visible-at-0-opacity before
      // the first hotkey. A fully hidden BrowserWindow can take seconds to
      // process the first input-mode state after show(), which blocks typing.
      this.overlay.hide();
      // Pre-create and load the world overlay renderer too, so the first
      // hotkey open does not pay its renderer load (it otherwise loads lazily
      // on the first input-ready).
      this.overlay.prepareWorldOnDisplay(screen.getPrimaryDisplay());
    }
    if (process.platform === 'darwin' && this.appSuspensionBlockerId === null) {
      // App Nap suspends the idle transparent overlay's renderer (its timers
      // and IPC handling stop entirely), so the first hotkey open finds a
      // frozen renderer. The occlusion/backgrounding Chromium switches do not
      // cover this; the power save blocker does.
      this.appSuspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    void this.progressiveBlur.start().catch((error) => {
      console.error('[InterpreterOverlay] Progressive blur warmup failed:', error);
    });

    const vision = new ServerClient({
      baseUrl: this.baseUrl,
      getAccessToken: getInterpreterOverlayAccessToken,
    });
    const capture = new Capture({
      beforeCapture: async () => {
        if (OVERLAY_VISION_MODE) {
          await this.overlay.suppressForCapture();
        }
      },
      afterCapture: async () => {
        if (OVERLAY_VISION_MODE) {
          await this.overlay.restoreAfterCapture();
        }
      },
    });
    const agent = createRemoteAgent({
      baseURL: this.baseUrl,
      getAccessToken: getInterpreterOverlayAccessToken,
      model: DEFAULT_INTERPRETER_OVERLAY_MODEL,
    });
    const auto = new Automation({
      onEmergencyStop: (position) => {
        void this.handleAutomationEmergencyStop(position);
      },
      nativeCuaExecutor: {
        click: async (target) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaClickToolCallForTarget(target),
          );
        },
        clickPoint: async (target) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaPointClickToolCallForTarget(target),
          );
        },
        setValue: async (target, value) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaSetValueToolCallForTarget(target, value),
          );
        },
        typeText: async (target, text) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaTypeTextToolCallForTarget(target, text),
          );
        },
        typeAppWindowText: async (target, text) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaAppWindowTypeTextToolCallForTarget(target, text),
          );
        },
        selectOption: async (target, option) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaSelectOptionToolCallForTarget(target, option),
          );
        },
        scroll: async (target, direction, pages) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaScrollToolCallForTarget(target, direction, pages),
          );
        },
        scrollAppWindow: async (target, direction, pages) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaAppWindowScrollToolCallForTarget(target, direction, pages),
          );
        },
        pressKey: async (target, key) => {
          await this.executeNativeCuaToolCallForActiveOverlaySession(
            buildNativeCuaPressKeyToolCallForTarget(target, key),
          );
        },
      },
      browserPageExecutor: {
        click: async (target) => {
          await this.executeBrowserPageToolCallForActiveOverlaySession(
            buildBrowserPageClickToolCallForTarget(target),
          );
        },
        type: async (target, text) => {
          await this.executeBrowserPageToolCallForActiveOverlaySession(
            buildBrowserPageTypeToolCallForTarget(target, text),
          );
        },
        select: async (target, value) => {
          await this.executeBrowserPageToolCallForActiveOverlaySession(
            buildBrowserPageSelectToolCallForTarget(target, value),
          );
        },
        scroll: async (target, direction, amount) => {
          await this.executeBrowserPageToolCallForActiveOverlaySession(
            buildBrowserPageScrollToolCallForTarget(target, direction, amount),
          );
        },
      },
    });
    const input = new Input({
      // macOS uiohook worker startup aborts the Electron process under Playwright
      // test boot, and the headless suite does not rely on overlay global hooks.
      enableGlobalHook: SHOULD_ENABLE_OVERLAY_GLOBAL_HOOK,
    });
    const stt = createServerSTT({
      baseURL: this.baseUrl,
      getAccessToken: getInterpreterOverlayAccessToken,
    });
    const ui = this.createUIAdapter();

    this.capture = capture;
    this.input = input;
    this.stt = stt;
    this.automation = auto;
    overlaySessionManager.setDriver({
      captureContext: async (session): Promise<OverlaySessionCapturedContext> => {
        return await this.syncAttachedToolContext(session);
      },
      computerBatch: async (session, request): Promise<ToolExecutionResult | undefined> => {
        return await this.executeAttachedToolWithRunEngine(session, {
          name: 'computer_batch',
          params: request,
        });
      },
      click: async (session, request): Promise<void> => {
        if (await this.executeBrowserPageOverlayToolCall(
          session,
          buildBrowserPageOverlayClickToolCall(session, request),
        )) {
          return;
        }
        if (await this.executeNativeCuaOverlayToolCall(
          session,
          buildNativeCuaOverlayClickToolCall(session, request),
        )) {
          return;
        }
        await this.executeAttachedToolWithRunEngine(session, {
          name: 'click',
          params: request,
        });
      },
      type: async (session, request): Promise<void> => {
        if (await this.executeNativeCuaOverlayToolCall(
          session,
          buildNativeCuaOverlayTypeToolCall(session, request),
        )) {
          return;
        }
        await this.executeAttachedToolWithRunEngine(session, {
          name: 'type',
          params: request,
        });
      },
      hotkey: async (session, request): Promise<void> => {
        await this.executeAttachedToolWithRunEngine(session, {
          name: 'hotkey',
          params: request,
        });
      },
      scroll: async (session, request): Promise<void> => {
        if (await this.executeBrowserPageOverlayToolCall(
          session,
          buildBrowserPageOverlayScrollToolCall(session, request),
        )) {
          return;
        }
        if (await this.executeNativeCuaOverlayToolCall(
          session,
          buildNativeCuaOverlayScrollToolCall(session, request),
        )) {
          return;
        }
        await this.executeAttachedToolWithRunEngine(session, {
          name: 'scroll',
          params: request,
        });
      },
      showDrawings: async (session, request): Promise<void> => {
        this.showAttachedToolDrawings(session, request);
      },
      clearDrawings: async (): Promise<void> => {
        this.clearAttachedToolDrawings();
      },
      detach: async (session): Promise<void> => {
        await this.detachAttachedToolSession(session, 'agent_detach');
      },
      complete: async (session): Promise<void> => {
        await this.detachAttachedToolSession(session, 'agent_complete');
      },
    });

    this.engine = new RunEngine({
      vision,
      capture,
      agent,
      auto,
      ui,
      input,
      clock: { now: () => Date.now() },
      ids: { uuid: () => randomUUID() },
      config: {
        MAX_TOOL_CALLS_PER_RUN: (
          INTERPRETER_OVERLAY_AGENT_MODE === 'ax'
            ? (this.benchmarkMode || FORM_TESTS_MODE ? 96 : 50)
            : (this.benchmarkMode || FORM_TESTS_MODE ? 256 : 128)
        ),
        conversationAppendMs: 15000,
        autoAccept: this.benchmarkMode,
        resolveControlPolicyMode: async (appName) => (
          resolveCuaAccessPolicyMode(await getCuaAccessPolicy(), appName, 'control')
        ),
      },
    });
    this.engine.onAgentDone((result) => {
      this.handleRunFinished(result);
    });

    input.onCtrlDown(() => {
      this.lastControlDownAt = Date.now();
      this.lastControlHoldDurationMs = null;
      this.lastControlUpAt = null;
      if (this.overlayState.globalApproval) {
        this.send({ ctrlPressed: true });
        return;
      }
      if (this.overlayState.mode === 'review') {
        this.send({ ctrlPressed: true });
        this.engine?.handleCtrlDown();
      }
    });

    input.onCtrlSpaceDown(() => {
      if (!isControlSpaceHotkey(this.effectiveSettings.hotkey) || this.overlayState.mode === 'input') {
        return;
      }

      this.lastCtrlSpaceDownAt = Date.now();
      this.lastCtrlSpaceHoldDurationMs = null;
      this.lastCtrlSpaceUpAt = null;
      console.log('[InterpreterOverlay] Hotkey pressed via input hook', {
        hotkey: this.effectiveSettings.hotkey,
      });
      void this.showInputMode(true);
    });

    input.onCtrlSpaceUp(() => {
      const now = Date.now();
      if (this.lastCtrlSpaceDownAt !== null) {
        this.lastCtrlSpaceHoldDurationMs = Math.max(0, now - this.lastCtrlSpaceDownAt);
      }
      this.lastCtrlSpaceUpAt = now;
      if (this.overlayState.mode === 'input') {
        void this.handleInputModifierRelease();
      }
    });

    input.onCtrlUp(async () => {
      const now = Date.now();
      if (this.lastControlDownAt !== null) {
        this.lastControlHoldDurationMs = Math.max(0, now - this.lastControlDownAt);
      }
      this.lastControlUpAt = now;
      this.lastControlDownAt = null;

      if (this.overlayState.globalApproval) {
        this.send({ ctrlPressed: false });
        this.approveGlobalApproval();
        return;
      }

      if (this.overlayState.mode === 'input') {
        await this.handleInputModifierRelease();
        return;
      }

      if (this.overlayState.mode === 'review') {
        this.send({ ctrlPressed: false });
        this.engine?.handleCtrlUp(this.overlayState.shiftPressed);
      }
    });

    input.onShiftDown(() => {
      if (this.overlayState.mode === 'review') {
        this.send({ shiftPressed: true });
        this.engine?.handleShiftDown();
      }
    });

    input.onShiftUp(() => {
      if (this.overlayState.shiftPressed) {
        this.send({ shiftPressed: false });
      }
      this.engine?.handleShiftUp();
    });

    input.onEsc(() => {
      void this.handleEscape();
    });

    input.onPasteShortcut?.(() => {
      if (this.overlayState.mode !== 'input') {
        return;
      }

      const overlayWindow = this.overlay.getWindow();
      if (overlayWindow?.isFocused()) {
        return;
      }

      this.overlay.pasteIntoInput();
    });

    input.onSubmitShortcut?.(() => {
      if (this.overlayState.mode !== 'input') {
        return;
      }

      void this.submitInputOverlay().catch((error) => {
        console.error('[InterpreterOverlay] Failed to submit input overlay:', error);
      });
    });

    input.onMouseDown?.((point) => {
      this.handleGlobalMouseDown(point);
    });

    input.onMouseMove?.((point) => {
      this.handleGlobalMouseMove(point);
    });

    input.onMouseUp?.((point) => {
      this.handleGlobalMouseUp(point);
    });

    stt.onPartialTranscript?.((text) => {
      if (this.overlayState.mode !== 'input' || !this.isVoiceInputActive) {
        return;
      }

      this.send({ transcript: this.buildVoiceDraft(text) });
    });

    stt.onAmplitude?.((amplitude) => {
      this.send({ amplitude });
    });

    ipcMain.on(CHANNELS.ACTION, this.handleOverlayAction);
    ipcMain.handle(CHANNELS.GET_BOOTSTRAP, this.handleOverlayGetBootstrap);
    ipcMain.handle(CHANNELS.LIST_SKILLS, this.handleOverlayListSkills);
    ipcMain.handle(CHANNELS.CHOOSE_WORKSPACE_FOLDER, this.handleOverlayChooseWorkspaceFolder);
    ipcMain.handle(CHANNELS.SET_SELECTION_PREFERENCES, this.handleOverlaySetSelectionPreferences);
    ipcMain.handle(CHANNELS.ADVANCED_VOICE_CREATE_CALL, this.advancedVoice.createCallIpcHandler);
    ipcMain.handle(CHANNELS.ADVANCED_VOICE_TOOL_CALL, this.advancedVoice.toolCallIpcHandler);
    ipcMain.handle(CHANNELS.ADVANCED_VOICE_TEST_AUDIO, this.advancedVoice.testAudioIpcHandler);
    ipcMain.handle(CHANNELS.ADVANCED_VOICE_AUDIO_EVENT, this.advancedVoice.audioEventIpcHandler);
    this.send({ ...DEFAULT_OVERLAY_STATE });
    this.startVisualHealthWatchdog();
    this.runtimeActive = true;
    this.startAgentDashboardPoller();
    this.syncEmergencyStopWatchdog();
    console.log('[InterpreterOverlay] runtime activated', {
      hotkey: this.effectiveSettings.hotkey,
      globalHookEnabled: SHOULD_ENABLE_OVERLAY_GLOBAL_HOOK,
    });
  }

  private deactivateRuntime(): void {
    if (!this.runtimeActive) {
      return;
    }

    if (this.appSuspensionBlockerId !== null) {
      powerSaveBlocker.stop(this.appSuspensionBlockerId);
      this.appSuspensionBlockerId = null;
    }
    this.clearProgressiveBlurCloseTimer();
    this.clearWorldOverlayCloseTimer();
    this.cancelVoiceTimer();
    this.isVoiceInputActive = false;
    this.stt?.abortRecording();
    this.stt = null;
    this.progressiveBlur.dispose();
    ipcMain.removeListener(CHANNELS.ACTION, this.handleOverlayAction);
    ipcMain.removeHandler(CHANNELS.GET_BOOTSTRAP);
    ipcMain.removeHandler(CHANNELS.LIST_SKILLS);
    ipcMain.removeHandler(CHANNELS.CHOOSE_WORKSPACE_FOLDER);
    ipcMain.removeHandler(CHANNELS.SET_SELECTION_PREFERENCES);
    ipcMain.removeHandler(CHANNELS.ADVANCED_VOICE_CREATE_CALL);
    ipcMain.removeHandler(CHANNELS.ADVANCED_VOICE_TOOL_CALL);
    ipcMain.removeHandler(CHANNELS.ADVANCED_VOICE_TEST_AUDIO);
    ipcMain.removeHandler(CHANNELS.ADVANCED_VOICE_AUDIO_EVENT);

    this.automation?.setPreferredWindowActivator(null);
    this.engine?.dispose();
    this.engine = null;
    this.capture = null;
    this.automation = null;
    overlaySessionManager.setDriver(null);
    this.activeAttachedSessionId = null;
    this.activeAttachedAgentId = null;
    this.input?.dispose();
    this.input = null;
    this.acceptCallbacks.length = 0;
    this.acceptAllCallbacks.length = 0;
    this.acceptAllSessionCallbacks.length = 0;
    this.rejectCallbacks.length = 0;
    this.stopVisualHealthWatchdog();
    this.stopEmergencyStopWatchdog();
    this.stopAgentDashboardPoller();
    this.overlay.close();
    this.overlayState = { ...DEFAULT_OVERLAY_STATE };
    this.lastSentOverlayStateSignature = null;
    this.resetOverlayInputTracking();
    this.resetOverlaySelectionState();
    this.scopeSelectionInProgress = false;
    this.progressiveBlurHandoffPending = false;
    this.progressiveBlurClosePending = false;
    this.resetOverlayVisualHealthTracking();
    this.runStartedAt = null;
    this.lastRunInputMethod = null;
    this.presentationTimings = {
      cycleId: 0,
      source: null,
      phase: 'idle',
      closeReason: null,
      openRequestedAt: null,
      reactVisibleAt: null,
      inputReadyAt: null,
      activeAppTargetAttachedAt: null,
      closeRequestedAt: null,
      reactHiddenAt: null,
      blurShowCommandAt: null,
      blurShownAt: null,
      blurHideCommandAt: null,
      blurHiddenAt: null,
    };
    this.debugRunState = {
      id: this.debugRunState.id,
      status: 'idle',
      reason: null,
      finalText: null,
      startedAt: null,
      finishedAt: null,
    };
    this.inputOpeningInFlight = false;
    this.onboardingVoiceRuntimeActivated = false;
    this.syncEmergencyStopWatchdog();
    this.runtimeActive = false;
  }

  private refreshHotkeyRegistration(): void {
    const nextHotkey = this.effectiveSettings.enabled && this.runtimeActive
      ? this.effectiveSettings.hotkey
      : null;

    if (this.registeredHotkey && this.registeredHotkey !== nextHotkey) {
      globalShortcut.unregister(this.registeredHotkey);
      this.registeredHotkey = null;
    }

    if (!nextHotkey) {
      this.emitTrayStateChanged();
      return;
    }

    if (this.registeredHotkey === nextHotkey && globalShortcut.isRegistered(nextHotkey)) {
      this.emitTrayStateChanged();
      return;
    }

    const registered = globalShortcut.register(nextHotkey, () => {
      void this.showInputMode(true);
    });

    if (!registered) {
      console.warn(`[InterpreterOverlay] Failed to register ${nextHotkey}`);
      this.registeredHotkey = null;
      this.emitTrayStateChanged();
      return;
    }

    this.registeredHotkey = nextHotkey;
    this.emitTrayStateChanged();
  }

  private unregisterHotkey(): void {
    if (!this.registeredHotkey) {
      this.emitTrayStateChanged();
      return;
    }

    globalShortcut.unregister(this.registeredHotkey);
    this.registeredHotkey = null;
    this.emitTrayStateChanged();
  }

  private createUIAdapter(): UIPort {
    return {
      set: (uiState: UIState): void => {
        if (this.overlayState.mode === 'input') {
          return;
        }

        let mode: OverlayState['mode'] = this.overlayState.mode;
        let action: ReviewAction | null = null;
        let ghosts: ReviewAction[] = [];
        this.overlayHiddenForExecution = false;
        const display = this.interactionDisplay;

        if (display) {
          if (uiState.active) {
            action = toReviewAction(uiState.active, display, this.scopeBounds);
          }
          ghosts = uiState.ghosts.map((ghost) =>
            toReviewAction(ghost, display, this.scopeBounds),
          );
        }

        if (uiState.executing || uiState.pill.kind === 'loading') {
          mode = 'working';
        } else if (uiState.active) {
          mode = 'review';
        } else if (this.debugRunState.status === 'running') {
          mode = 'working';
        } else if (uiState.pill.kind === 'hidden') {
          mode = 'idle';
        }
        const renderedPill = mode === 'working' && uiState.pill.kind === 'review'
          ? { kind: 'loading' as const }
          : uiState.pill;

        this.send({
          mode,
          action,
          ghosts,
          pill: renderedPill,
          ctrlPressed: uiState.ctrlPressed,
          shiftPressed: uiState.shiftPressed,
        });
      },

      blur: (): void => {
        this.overlay.setFocusable(false);
        this.overlay.disableMouseEvents();
      },

      onAccept: (callback: () => void): void => {
        this.acceptCallbacks.push(callback);
      },

      onAcceptAll: (callback: () => void): void => {
        this.acceptAllCallbacks.push(callback);
      },

      onAcceptAllSession: (callback: () => void): void => {
        this.acceptAllSessionCallbacks.push(callback);
      },

      onReject: (callback: () => void): void => {
        this.rejectCallbacks.push(callback);
      },
    };
  }

  private send(partial: Partial<OverlayState>): void {
    const previousState = this.overlayState;
    let nextState: OverlayState = {
      ...previousState,
      ...partial,
    };

    if (!this.advancedVoice.isAdvancedVoiceInputActive && nextState.advancedVoiceActive) {
      nextState = {
        ...nextState,
        advancedVoiceActive: false,
      };
    }

    if (!this.advancedVoice.isAdvancedVoiceInputActive && !this.isVoiceInputActive && nextState.isRecording) {
      nextState = {
        ...nextState,
        isRecording: false,
        amplitude: 0,
      };
    }

    const enteringAdvancedVoice = partial.advancedVoiceActive === true && nextState.advancedVoiceActive === true;
    if (nextState.mode === 'idle' && previousState.mode !== 'idle') {
      const shouldDeferWorldOverlayClose = previousState.worldPinActive && this.pinnedTarget !== null;
      this.progressiveBlurHandoffPending = false;
      if (enteringAdvancedVoice || nextState.advancedVoiceActive) {
        nextState = {
          ...nextState,
          scopeBounds: previousState.scopeBounds,
          draftScopeBounds: null,
          selectableElements: previousState.selectableElements,
          contextItems: previousState.contextItems,
          targetContextId: previousState.targetContextId,
          worldPinActive: previousState.worldPinActive,
          worldTargetBounds: previousState.worldTargetBounds,
          worldPinClosing: false,
        };
      } else if (this.activeAttachedSessionId !== null || this.runStartedAt !== null) {
        // A just-submitted run passes through a transient idle while the
        // input presentation closes, before its attached tool session exists.
        // Dropping the world pin and scope here is what killed the thinking
        // sheen: keep them alive whenever a run is in flight.
        nextState = {
          ...nextState,
          scopeBounds: previousState.scopeBounds,
          draftScopeBounds: null,
          selectableElements: previousState.selectableElements,
          contextItems: previousState.contextItems,
          targetContextId: previousState.targetContextId,
          worldPinActive: previousState.worldPinActive,
          worldTargetBounds: previousState.worldTargetBounds,
          worldPinClosing: false,
        };
      } else if (shouldDeferWorldOverlayClose) {
        this.clearWorldOverlayCloseTimer();
        this.resetOverlaySelectionState();
        this.scopeSelectionInProgress = false;
        this.endPinningWorldOverlay(WORLD_OVERLAY_CLOSE_FADE_MS);
        nextState = {
          ...previousState,
          action: null,
          ghosts: [],
          pill: { kind: 'hidden' },
          ctrlPressed: false,
          shiftPressed: false,
          worldPinClosing: true,
        };
      } else {
        this.resetOverlaySelectionState();
        this.scopeSelectionInProgress = false;
        this.endPinningWorldOverlay();
        nextState = {
          ...nextState,
          scopeBounds: null,
          draftScopeBounds: null,
          selectableElements: [],
        };
      }
    }

    if (nextState.mode === 'idle') {
      this.overlayVisualExpectationAt = null;
    } else if (previousState.mode === 'idle' || this.overlayVisualExpectationAt === null) {
      this.overlayVisualExpectationAt = Date.now();
    }

    if (previousState.mode !== 'input' && nextState.mode === 'input') {
      this.clearCachedInputVisualHealth();
    }

    if (previousState.mode === 'input' && nextState.mode !== 'input') {
      this.inputStripRequestId += 1;
      this.clearInputFocusRetryTimers();
    }

    if (
      (previousState.mode === 'review' || previousState.mode === 'working')
      && nextState.mode === 'working'
      && nextState.action === null
      && previousState.action !== null
      && this.activeAttachedSessionId === null
    ) {
      nextState = {
        ...nextState,
        action: previousState.action,
        ghosts: nextState.ghosts.length > 0
          ? nextState.ghosts
          : (previousState.ghosts.length > 0 ? previousState.ghosts : [previousState.action]),
        };
    }

    if (nextState.mode !== 'input' && nextState.inputReady) {
      nextState = {
        ...nextState,
        inputReady: false,
      };
    }

    this.progressiveBlurHandoffPending = false;

    this.overlayState = nextState;

    const statePresentationChanged =
      previousState.mode !== nextState.mode
      || previousState.action?.id !== nextState.action?.id
      || previousState.pill.kind !== nextState.pill.kind;
    if (statePresentationChanged) {
      this.lastWorldOverlayVisualHealth = null;
      this.lastOverlayVisualHealth = null;
      this.lastOverlayVisualHealthSignature = null;
    }

    const hideForExecutingAction = this.overlayHiddenForExecution;
    const renderedState: OverlayState = {
      ...this.overlayState,
      displayScaleFactor: this.interactionDisplay?.scaleFactor ?? this.overlayState.displayScaleFactor,
      displayWorkArea: this.getWindowLocalWorkArea() ?? this.overlayState.displayWorkArea,
      tracePrimaryColor: this.tracePrimaryColor,
      worldTargetBounds: this.overlayState.worldPinActive ? this.worldTargetBounds : null,
      debugExecutionSentinel: DEBUG_EXECUTION_SENTINEL
        && this.overlayState.worldPinActive
        && this.overlayState.scopeBounds !== null
        && this.overlayState.mode !== 'idle',
      ctrlPressed: this.overlayState.mode === 'review' && !hideForExecutingAction ? this.overlayState.ctrlPressed : false,
      shiftPressed: this.overlayState.mode === 'review' && !hideForExecutingAction ? this.overlayState.shiftPressed : false,
    };
    const renderedStateSignature = JSON.stringify(renderedState);
    const isInputMode = renderedState.mode === 'input';
    const hasAgentDashboard = renderedState.runningAgents.length > 0 || renderedState.dashboardApprovals.length > 0;
    console.log('[InterpreterOverlay] send', {
      mode: this.overlayState.mode,
      visualMode: renderedState.mode,
      isInputMode,
      runningAgentCount: renderedState.runningAgents.length,
      dashboardApprovalCount: renderedState.dashboardApprovals.length,
      inputReady: renderedState.inputReady,
      selectableElementCount: renderedState.selectableElements.length,
      hasAction: !!renderedState.action,
      ctrlPressed: renderedState.ctrlPressed,
      shiftPressed: renderedState.shiftPressed,
      hideForExecutingAction,
      progressiveBlurHandoffPending: this.progressiveBlurHandoffPending,
      progressiveBlurClosePending: this.progressiveBlurClosePending,
    });

    this.setMainWindowFocusSuppressed(hideForExecutingAction);
    this.overlay.setFocusable(isInputMode);

    // Leaving input mode always ends an in-flight region-drag capture.
    if (this.regionDragCaptureActive && !isInputMode) {
      this.regionDragCaptureActive = false;
    }
    // Input mode captures the mouse fully: macOS routes an entire drag
    // session to whichever app received the initial mousedown, so a region
    // drag that starts click-through cannot be reclaimed mid-gesture and
    // system-selects content in the app underneath. The open input surface is
    // the explicit input control the click-through contract allows to
    // capture; working/idle modes stay click-through.
    if (isInputMode) {
      this.overlay.enableMouseEvents();
    } else if (!this.regionDragCaptureActive) {
      this.overlay.disableMouseEvents();
    }

    this.syncProgressiveBlurVisibility();

    if (renderedState.mode !== 'idle' || hasAgentDashboard) {
      this.showOverlayOnInteractionDisplay();
    }
    if (!isInputMode && hasAgentDashboard) {
      this.overlay.setFocusable(true);
    }

    const window = this.overlay.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }

    const sendState = () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
      }
      if (this.lastSentOverlayStateSignature === renderedStateSignature) {
        return;
      }
      this.lastSentOverlayStateSignature = renderedStateSignature;
      if (renderedState.mode === 'input') {
        this.lastInputStateDeliveredAt = Date.now();
        console.log('[InterpreterOverlay] input state delivered', {
          cycleId: this.presentationTimings.cycleId,
          inputReady: renderedState.inputReady,
          webContentsLoading: window.webContents.isLoading(),
          openToDeliveryMs: this.presentationTimings.openRequestedAt === null
            ? null
            : Date.now() - this.presentationTimings.openRequestedAt,
        });
      }
      window.webContents.send(CHANNELS.STATE, renderedState);
      // Mirror the same state to the world overlay renderer so it can draw the
      // spatial layers (scope frame, attached pill, markers) inside its own
      // pinned BrowserWindow.
      this.overlay.sendWorldState(renderedState);
    };

    if (window.webContents.isLoading()) {
      this.lastSentOverlayStateSignature = null;
      if (renderedState.mode === 'input') {
        console.log('[InterpreterOverlay] input state waiting for renderer load', {
          cycleId: this.presentationTimings.cycleId,
          openToWaitMs: this.presentationTimings.openRequestedAt === null
            ? null
            : Date.now() - this.presentationTimings.openRequestedAt,
        });
      }
      window.webContents.once('did-finish-load', sendState);
      return;
    }

    sendState();
  }

  private setMainWindowFocusSuppressed(suppressed: boolean): void {
    if (this.mainWindowFocusSuppressed === suppressed) {
      return;
    }

    const overlayWindow = this.overlay.getWindow();
    const mainWindow = BrowserWindow.getAllWindows().find((window) => window !== overlayWindow) ?? null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      this.mainWindowFocusSuppressed = suppressed;
      return;
    }

    mainWindow.setFocusable(!suppressed);
    this.mainWindowFocusSuppressed = suppressed;
    console.log('[InterpreterOverlay] setMainWindowFocusSuppressed', { suppressed });
  }

  private cancelVoiceTimer(): void {
    if (this.voiceRecordingTimer) {
      clearTimeout(this.voiceRecordingTimer);
      this.voiceRecordingTimer = null;
    }
    this.voiceRecordingTimerGeneration += 1;
  }

  private clearProgressiveBlurCloseTimer(): void {
    if (!this.progressiveBlurCloseTimer) {
      return;
    }

    clearTimeout(this.progressiveBlurCloseTimer);
    this.progressiveBlurCloseTimer = null;
  }

  private clearWorldOverlayCloseTimer(): void {
    if (!this.worldOverlayCloseTimer) {
      if (this.worldOverlayFinalizeTimer) {
        clearTimeout(this.worldOverlayFinalizeTimer);
        this.worldOverlayFinalizeTimer = null;
      }
      return;
    }

    clearTimeout(this.worldOverlayCloseTimer);
    this.worldOverlayCloseTimer = null;
    if (this.worldOverlayFinalizeTimer) {
      clearTimeout(this.worldOverlayFinalizeTimer);
      this.worldOverlayFinalizeTimer = null;
    }
  }

  private scheduleWorldOverlayIdleCleanup(): void {
    this.clearWorldOverlayCloseTimer();
    this.worldOverlayCloseTimer = setTimeout(() => {
      this.worldOverlayCloseTimer = null;
      this.resetOverlaySelectionState();
      this.scopeSelectionInProgress = false;
      this.endPinningWorldOverlay(WORLD_OVERLAY_CLOSE_FADE_MS);
    }, WORLD_OVERLAY_CLOSE_FADE_MS);
  }

  private scheduleProgressiveBlurClose(): void {
    this.clearProgressiveBlurCloseTimer();
    this.progressiveBlurClosePending = true;
    this.syncProgressiveBlurVisibility();
    this.progressiveBlurCloseTimer = setTimeout(() => {
      this.progressiveBlurCloseTimer = null;
      this.progressiveBlurClosePending = false;
      this.syncProgressiveBlurVisibility();
    }, PROGRESSIVE_BLUR_CLOSE_DELAY_MS);
  }

  private async showInputMode(
    fromHotkey: boolean,
    options?: { loadSelectionElements?: boolean; allowDisabledRuntime?: boolean },
  ): Promise<void> {
    if (!this.accessState.allowed) {
      this.trackOverlayEvent('overlay_access_denied', {
        source: fromHotkey ? 'hotkey' : 'tray',
        reason: this.accessState.reason,
      });
      const unavailable = getOverlayUnavailableDialog(this.accessState);
      await dialog.showMessageBox({
        type: 'info',
        title: 'Interpreter Overlay',
        message: unavailable.message,
        detail: unavailable.detail,
        buttons: ['OK'],
      });
      return;
    }

    if (
      (!this.effectiveSettings.enabled && options?.allowDisabledRuntime !== true)
      || !this.capture
      || !this.stt
    ) {
      return;
    }

    if (
      INTERPRETER_OVERLAY_INPUT_DESIGN === 'pill'
      && (this.overlayState.mode === 'working' || this.overlayState.mode === 'review')
    ) {
      await this.handleEscape();
    }

    if (this.overlayState.mode === 'input' || this.inputOpeningInFlight) {
      return;
    }

    this.inputOpeningInFlight = true;
    try {
      this.clearProgressiveBlurCloseTimer();
      this.clearWorldOverlayCloseTimer();
      this.progressiveBlurClosePending = false;
      if (this.pinnedTarget) {
        this.endPinningWorldOverlay();
      }

      const display = this.capture.getActiveDisplay();
      this.cancelVoiceTimer();
      this.isVoiceInputActive = false;
      this.advancedVoice.isAdvancedVoiceInputActive = false;
      this.inputOpenedAt = Date.now();
      this.hotkeyInputOpenedAt = fromHotkey ? this.inputOpenedAt : null;
      this.voiceRecordingStartedAt = null;
      this.voiceInputUsed = false;
      this.lastOpenSource = fromHotkey ? 'hotkey' : 'tray';
      this.lastRemovedTargetContext = null;
      this.tracePrimaryColor = chooseTracePrimaryColor();
      this.beginPresentationTiming(this.lastOpenSource);
      if (fromHotkey) {
        this.clearAttachedOverlaySessionsForFreshStart('hotkey_open');
      }
      this.resetOverlaySelectionState();
      const hotkeyContextRequestId = ++this.hotkeyContextRequestId;
      this.scopeSelectionInProgress = false;
      this.interactionDisplay = display;
      this.pendingActiveAppTargetAttach = null;

      this.overlay.setFocusable(true);
      this.overlay.disableMouseEvents();
      this.showOverlayOnInteractionDisplay();
      const lastReportAgeMs = this.lastAnyOverlayVisualHealthAt === null
        ? null
        : Date.now() - this.lastAnyOverlayVisualHealthAt;
      if (lastReportAgeMs !== null && lastReportAgeMs > OVERLAY_RENDERER_OPEN_STALE_MS) {
        // The renderer demonstrably stopped reporting before this open. Do not
        // make the user wait out the wedge grace staring at the blur.
        void this.recoverOverlayVisuals('boot-stall', { staleForMs: lastReportAgeMs });
      }

      this.send({
        mode: 'input',
        action: null,
        screenshot: null,
        transcript: '',
        inputReady: false,
        isRecording: false,
        amplitude: 0,
        ctrlPressed: false,
        shiftPressed: false,
        scopeBounds: null,
        selectableElements: [],
        contextItems: [],
        targetContextId: null,
        activeRegionRole: 'target',
      });
      this.scheduleInputFocusRetries(this.presentationTimings.cycleId, display.id);
      const activeAppTargetAttach = fromHotkey
        ? wait(ACTIVE_APP_TARGET_ATTACH_AFTER_INPUT_DELAY_MS)
            .then(() => this.attachActiveAppTargetContext(display, hotkeyContextRequestId, this.inputOpenedAt ?? Date.now()))
            .finally(() => {
              if (this.pendingActiveAppTargetAttach === activeAppTargetAttach) {
                this.pendingActiveAppTargetAttach = null;
              }
            })
        : null;
      this.pendingActiveAppTargetAttach = activeAppTargetAttach;
      if (!fromHotkey && options?.loadSelectionElements !== false) {
        void this.loadSelectionElementsForDisplay(display);
      }

      if (fromHotkey && !DISABLE_VOICE_TIMER && process.platform !== 'win32') {
        const voiceDelayMs = this.effectiveSettings.advancedVoiceEnabled
          ? ADVANCED_VOICE_DELAY_MS
          : VOICE_DELAY_MS;
        const hotkeyOpenedAt = this.hotkeyInputOpenedAt;
        const controlHoldStartedAt = this.lastCtrlSpaceDownAt ?? this.lastControlDownAt ?? hotkeyOpenedAt;
        const hotkeyHoldMs = hotkeyOpenedAt === null
          ? null
          : Math.max(0, Date.now() - hotkeyOpenedAt);
        const controlHoldMs = controlHoldStartedAt === null
          ? null
          : Math.max(0, Date.now() - controlHoldStartedAt);
        const controlReleasedAfterHotkeyOpen = hotkeyOpenedAt !== null
          && this.lastControlUpAt !== null
          && this.lastControlUpAt >= hotkeyOpenedAt;
        const completedChordHoldMs = this.lastCtrlSpaceHoldDurationMs ?? this.lastControlHoldDurationMs;
        const completedHoldAfterOpenMs = completedHotkeyHoldAfterInputOpenMs(
          hotkeyOpenedAt,
          this.lastControlUpAt,
        );
        const completedHoldLongEnough = controlReleasedAfterHotkeyOpen
          && completedChordHoldMs !== null
          && completedChordHoldMs >= voiceDelayMs;
        const completedHoldAfterOpenLongEnough = completedHoldAfterOpenMs !== null
          && completedHoldAfterOpenMs >= voiceDelayMs;
        const activeHoldAlreadyLongEnough = (
          hotkeyHoldMs !== null
          && hotkeyHoldMs >= voiceDelayMs
          && !controlReleasedAfterHotkeyOpen
        ) || (completedHoldLongEnough && completedHoldAfterOpenLongEnough);
        const activeHotkeyHold = hotkeyHoldIsActive({
          controlDownAt: this.lastControlDownAt,
          controlUpAt: this.lastControlUpAt,
          chordDownAt: this.lastCtrlSpaceDownAt,
          chordUpAt: this.lastCtrlSpaceUpAt,
        });
        console.log('[InterpreterOverlay] hotkey timed voice decision', {
          advancedVoiceEnabled: this.effectiveSettings.advancedVoiceEnabled,
          voiceDelayMs,
          hotkeyHoldMs,
          controlHoldMs,
          controlReleasedAfterHotkeyOpen,
          completedHoldLongEnough,
          completedHoldAfterOpenMs,
          completedHoldAfterOpenLongEnough,
          lastControlHoldDurationMs: this.lastControlHoldDurationMs,
          lastCtrlSpaceHoldDurationMs: this.lastCtrlSpaceHoldDurationMs,
          lastControlUpAgeMs: this.lastControlUpAt === null ? null : Date.now() - this.lastControlUpAt,
          lastCtrlSpaceUpAgeMs: this.lastCtrlSpaceUpAt === null ? null : Date.now() - this.lastCtrlSpaceUpAt,
          activeControlHoldMs: this.lastControlDownAt === null ? null : Date.now() - this.lastControlDownAt,
          activeHoldAlreadyLongEnough,
          activeHotkeyHold,
        });
        const startTimedVoice = () => {
          void (async () => {
            if (this.effectiveSettings.advancedVoiceEnabled) {
              await this.waitForPendingActiveAppTargetAttach('timed voice start');
              this.advancedVoice.startAdvancedVoiceInput('hotkey');
              return;
            }
            this.startVoiceInput('hotkey');
          })();
        };
        if (activeHoldAlreadyLongEnough) {
          setTimeout(startTimedVoice, 0);
        } else if (!activeHotkeyHold) {
          console.log('[InterpreterOverlay] skipped timed voice scheduling after short hotkey tap', {
            advancedVoiceEnabled: this.effectiveSettings.advancedVoiceEnabled,
            voiceDelayMs,
            hotkeyHoldMs,
            controlHoldMs,
            controlReleasedAfterHotkeyOpen,
            lastControlHoldDurationMs: this.lastControlHoldDurationMs,
            lastCtrlSpaceHoldDurationMs: this.lastCtrlSpaceHoldDurationMs,
            lastControlUpAgeMs: this.lastControlUpAt === null ? null : Date.now() - this.lastControlUpAt,
            lastCtrlSpaceUpAgeMs: this.lastCtrlSpaceUpAt === null ? null : Date.now() - this.lastCtrlSpaceUpAt,
          });
        } else {
          const activeControlHoldMs = controlHoldStartedAt === null
            ? 0
            : Math.max(0, Date.now() - controlHoldStartedAt);
          const remainingVoiceDelayMs = Math.max(0, voiceDelayMs - activeControlHoldMs);
          const timerGeneration = this.voiceRecordingTimerGeneration;
          const inputCycleId = this.presentationTimings.cycleId;
          console.log('[InterpreterOverlay] scheduled timed voice start', {
            advancedVoiceEnabled: this.effectiveSettings.advancedVoiceEnabled,
            remainingVoiceDelayMs,
            timerGeneration,
            inputCycleId,
          });
          this.voiceRecordingTimer = setTimeout(() => {
            if (
              timerGeneration !== this.voiceRecordingTimerGeneration
              || inputCycleId !== this.presentationTimings.cycleId
              || this.overlayState.mode !== 'input'
            ) {
              console.log('[InterpreterOverlay] skipped timed voice start after state change', {
                timerGeneration,
                currentTimerGeneration: this.voiceRecordingTimerGeneration,
                inputCycleId,
                currentInputCycleId: this.presentationTimings.cycleId,
                mode: this.overlayState.mode,
              });
              return;
            }
            this.voiceRecordingTimer = null;
            const latestHotkeyOpenedAt = this.hotkeyInputOpenedAt;
            const releasedAfterHotkeyOpen = latestHotkeyOpenedAt !== null
              && this.lastControlUpAt !== null
              && this.lastControlUpAt >= latestHotkeyOpenedAt;
            const completedHoldWasLongEnough = releasedAfterHotkeyOpen
              && (this.lastCtrlSpaceHoldDurationMs ?? this.lastControlHoldDurationMs) !== null
              && (this.lastCtrlSpaceHoldDurationMs ?? this.lastControlHoldDurationMs)! >= voiceDelayMs;
            const completedHoldAfterOpenMs = completedHotkeyHoldAfterInputOpenMs(
              latestHotkeyOpenedAt,
              this.lastControlUpAt,
            );
            const completedHoldAfterOpenLongEnough = completedHoldAfterOpenMs !== null
              && completedHoldAfterOpenMs >= voiceDelayMs;
            const now = Date.now();
            const activeControlHoldLongEnough = this.lastControlDownAt !== null
              && (this.lastControlUpAt === null || this.lastControlUpAt < this.lastControlDownAt)
              && now - this.lastControlDownAt >= voiceDelayMs;
            const stillHoldingHotkeyLongEnough = timedVoiceHoldIsLongEnough({
              inputOpenedAt: latestHotkeyOpenedAt,
              now,
              voiceDelayMs,
              releasedAfterInputOpen: releasedAfterHotkeyOpen,
              activeControlHoldLongEnough,
              completedHoldWasLongEnough,
              completedHoldAfterOpenLongEnough,
            });
            if (!stillHoldingHotkeyLongEnough) {
              console.log('[InterpreterOverlay] skipped timed voice start after short hotkey tap', {
                advancedVoiceEnabled: this.effectiveSettings.advancedVoiceEnabled,
                voiceDelayMs,
                hotkeyHoldMs: latestHotkeyOpenedAt === null ? null : Math.max(0, now - latestHotkeyOpenedAt),
                activeControlHoldMs: this.lastControlDownAt === null ? null : Math.max(0, now - this.lastControlDownAt),
                releasedAfterHotkeyOpen,
                completedHoldWasLongEnough,
                completedHoldAfterOpenMs,
                completedHoldAfterOpenLongEnough,
                lastControlHoldDurationMs: this.lastControlHoldDurationMs,
                lastCtrlSpaceHoldDurationMs: this.lastCtrlSpaceHoldDurationMs,
                lastControlUpAgeMs: this.lastControlUpAt === null ? null : now - this.lastControlUpAt,
                lastCtrlSpaceUpAgeMs: this.lastCtrlSpaceUpAt === null ? null : now - this.lastCtrlSpaceUpAt,
              });
              return;
            }
            startTimedVoice();
          }, remainingVoiceDelayMs);
        }
      }

      this.overlay.requestInputFocus();

      this.trackOverlayEvent('overlay_opened', {
        source: this.lastOpenSource,
      });

      this.pendingInitialHotkeyContextAttach = fromHotkey
        ? { display, requestId: hotkeyContextRequestId, startedAt: this.inputOpenedAt }
        : null;

      // Screenshot strip capture is intentionally disabled; the renderer uses a
      // pure bottom readability ramp instead of showing duplicated app content.
      this.inputStripRequestId += 1;
    } finally {
      this.inputOpeningInFlight = false;
    }
  }

  private async waitForPendingActiveAppTargetAttach(reason: string): Promise<void> {
    const pending = this.pendingActiveAppTargetAttach;
    if (!pending) {
      return;
    }

    const startedAt = Date.now();
    await pending.catch((error) => {
      console.warn('[InterpreterOverlay] active-app target attachment failed', { reason, error });
    });
    console.log('[InterpreterOverlay] active-app target attachment settled before continuing', {
      reason,
      durationMs: Date.now() - startedAt,
      hasTarget: this.overlayState.targetContextId !== null,
    });
  }

  private async handleInputModifierRelease(): Promise<void> {
    if (this.overlayState.mode !== 'input') {
      return;
    }

    const completedHoldDurationMs = this.lastCtrlSpaceHoldDurationMs ?? this.lastControlHoldDurationMs;
    if (this.effectiveSettings.advancedVoiceEnabled) {
      if (this.advancedVoice.isAdvancedVoiceInputActive) {
        return;
      }

      if (
        process.platform !== 'win32'
        && completedHoldDurationMs !== null
        && completedHoldDurationMs >= ADVANCED_VOICE_DELAY_MS
        && completedHotkeyHoldAfterInputOpenMs(this.hotkeyInputOpenedAt, this.lastControlUpAt) !== null
        && completedHotkeyHoldAfterInputOpenMs(this.hotkeyInputOpenedAt, this.lastControlUpAt)! >= ADVANCED_VOICE_DELAY_MS
      ) {
        this.cancelVoiceTimer();
        await this.waitForPendingActiveAppTargetAttach('control release');
        this.advancedVoice.startAdvancedVoiceInput('hotkey');
        return;
      }
    } else if (
      process.platform !== 'win32'
      && completedHoldDurationMs !== null
      && completedHoldDurationMs >= VOICE_DELAY_MS
      && completedHotkeyHoldAfterInputOpenMs(this.hotkeyInputOpenedAt, this.lastControlUpAt) !== null
      && completedHotkeyHoldAfterInputOpenMs(this.hotkeyInputOpenedAt, this.lastControlUpAt)! >= VOICE_DELAY_MS
      && !this.isVoiceInputActive
    ) {
      this.cancelVoiceTimer();
      this.startVoiceInput('hotkey');
      return;
    }

    this.cancelVoiceTimer();
    await this.stopVoiceInput();
  }

  private async handleEscape(): Promise<void> {
    if (this.advancedVoice.isAdvancedVoiceInputActive) {
      this.advancedVoice.stopAdvancedVoiceInput();
      this.send({
        ...DEFAULT_OVERLAY_STATE,
        screenshot: null,
      });
      this.resetOverlayInputTracking();
      return;
    }

    if (this.overlayState.mode === 'idle') {
      return;
    }

    if (this.overlayHiddenForExecution) {
      console.log('[InterpreterOverlay] Ignoring Escape while overlay is hidden for action execution');
      return;
    }

    this.cancelVoiceTimer();

    if (this.isVoiceInputActive) {
      this.trackVoiceCancelled('escape');
      this.stt?.abortRecording();
      this.isVoiceInputActive = false;
    }

    this.advancedVoice.stopAdvancedVoiceInput();

    if (this.overlayState.mode === 'input') {
      this.trackOverlayEvent('overlay_dismissed', {
        reason: 'escape',
        inputMethod: this.voiceInputUsed ? 'voice' : 'text',
        durationMs: this.inputOpenedAt === null ? undefined : Date.now() - this.inputOpenedAt,
      });
      this.notePresentationCloseRequested('escape');
      this.send({
        ...DEFAULT_OVERLAY_STATE,
        screenshot: null,
        transcript: '',
        isRecording: false,
        amplitude: 0,
      });
      this.resetOverlayInputTracking();
      return;
    }

    this.engine?.handleEscape();
  }

  private isPrimaryMouseButton(button: number): boolean {
    return button === 0 || button === 1;
  }

  private normalizeGlobalHookPoint(point: { x: number; y: number; coordinateSpace?: 'dip' | 'physical' }): { x: number; y: number } {
    if (point.coordinateSpace === 'dip') {
      return { x: point.x, y: point.y };
    }

    const display = this.interactionDisplay;
    if (!display) {
      return { x: point.x, y: point.y };
    }

    const scaleFactor = display.scaleFactor || 1;
    return {
      x: display.boundsDIP.x + ((point.x - (display.boundsDIP.x * scaleFactor)) / scaleFactor),
      y: display.boundsDIP.y + ((point.y - (display.boundsDIP.y * scaleFactor)) / scaleFactor),
    };
  }

  private isPointInsideOverlayControl(point: { x: number; y: number; coordinateSpace?: 'dip' | 'physical' }): boolean {
    const health = this.overlayState.mode === 'input'
      ? (this.lastInputOverlayControlHealth ?? this.lastOverlayVisualHealth)
      : this.lastOverlayVisualHealth;
    if (!health || !this.interactionDisplay) {
      return false;
    }

    const normalizedPoint = this.normalizeGlobalHookPoint(point);
    const localPoint = {
      x: normalizedPoint.x - this.interactionDisplay.boundsDIP.x,
      y: normalizedPoint.y - this.interactionDisplay.boundsDIP.y,
    };
    const controlBounds = [
      health.editorBounds,
      health.primaryActionBounds,
      health.workspaceTriggerBounds,
      health.profileTriggerBounds,
      ...(health.contextChipBounds ?? []).flatMap((chip) => [chip.bounds, chip.removeBounds]),
      ...(health.workspaceOptionBounds ?? []).map((option) => option.bounds),
      ...(health.profileOptionBounds ?? []).map((option) => option.bounds),
    ].filter((bounds): bounds is Bounds => Boolean(bounds));

    return controlBounds.some((bounds) => (
      localPoint.x >= bounds.x
      && localPoint.x <= bounds.x + bounds.width
      && localPoint.y >= bounds.y
      && localPoint.y <= bounds.y + bounds.height
    ));
  }

  private getContextChipRemoveIdAtPoint(point: { x: number; y: number; coordinateSpace?: 'dip' | 'physical' }): string | null {
    const health = this.overlayState.mode === 'input'
      ? (this.lastInputOverlayControlHealth ?? this.lastOverlayVisualHealth)
      : this.lastOverlayVisualHealth;
    if (!health || !this.interactionDisplay) {
      return null;
    }

    const normalizedPoint = this.normalizeGlobalHookPoint(point);
    const localPoint = {
      x: normalizedPoint.x - this.interactionDisplay.boundsDIP.x,
      y: normalizedPoint.y - this.interactionDisplay.boundsDIP.y,
    };
    const matchingChip = (health.contextChipBounds ?? []).find((chip) => {
      const bounds = chip.removeBounds;
      return !!bounds
        && localPoint.x >= bounds.x
        && localPoint.x <= bounds.x + bounds.width
        && localPoint.y >= bounds.y
        && localPoint.y <= bounds.y + bounds.height;
    });
    return matchingChip?.id ?? null;
  }

  private removeOverlayContextItem(id: string): void {
    if (this.overlayState.mode !== 'input') {
      return;
    }
    this.suppressRegionSelectionUntil = Date.now() + 3000;
    this.globalScopeGesture = null;
    this.scopeSelectionInProgress = false;
    this.sendDragPreview(null);
    const isRemovingTargetContext = id.startsWith('overlay-region-target-')
      || this.overlayState.contextItems.some((item) => item.id === id && item.role === 'target');
    const removedTargetContext = isRemovingTargetContext
      ? getTargetContextItem(this.overlayState.contextItems)
      : null;
    const nextContextItems = this.overlayState.contextItems.filter((item) => (
      item.id !== id
      && !(isRemovingTargetContext && item.role === 'target')
    ));
    console.log('[InterpreterOverlay] remove context item', {
      id,
      isRemovingTargetContext,
      before: this.overlayState.contextItems.map((item) => ({
        id: item.id,
        kind: item.kind,
        role: item.kind === 'region' ? item.role : undefined,
      })),
      after: nextContextItems.map((item) => ({
        id: item.id,
        kind: item.kind,
        role: item.kind === 'region' ? item.role : undefined,
      })),
    });
    if (removedTargetContext) {
      this.lastRemovedTargetContext = removedTargetContext;
    }
    const nextTarget = getTargetContextItem(nextContextItems);
    this.scopeBounds = nextTarget?.bounds ?? null;
    this.selectionElements = [];
    this.scopedStructuredContext = null;
    this.send({
      contextItems: nextContextItems,
      targetContextId: nextTarget?.id ?? null,
      scopeBounds: nextTarget && this.interactionDisplay
        ? toLocalBounds(nextTarget.bounds, this.interactionDisplay.boundsDIP)
        : null,
      selectableElements: nextTarget?.selectableElements ?? [],
      activeRegionRole: nextTarget
        ? this.resolveRegionSelectionRole('reference')
        : 'target',
    });
  }

  private handleGlobalMouseDown(point: { x: number; y: number; button: number; coordinateSpace?: 'dip' | 'physical' }): void {
    if (this.isPrimaryMouseButton(point.button) && this.interactionDisplay) {
      const normalizedPoint = this.normalizeGlobalHookPoint(point);
      if (hitsOverlayDrawingAction({
        action: this.overlayState.action,
        ghosts: this.overlayState.ghosts,
        activeDrawingIds: this.activeOverlayDrawingIds,
        displayOrigin: this.interactionDisplay.boundsDIP,
        absolutePoint: normalizedPoint,
      })) {
        this.clearAttachedToolDrawings();
        this.globalScopeGesture = null;
        this.clearGlobalScopeGestureTimeout();
        return;
      }
    }

    if (this.overlayState.mode === 'review' && this.isPrimaryMouseButton(point.button) && this.interactionDisplay) {
      const hit = getWorldReviewControlHitFromGlobalPoint(
        point,
        this.interactionDisplay.boundsDIP,
        this.interactionDisplay.scaleFactor,
        this.lastWorldOverlayVisualHealth?.reviewControlBounds ?? null,
      );
      if (hit === 'accept') {
        const normalizedPoint = this.normalizeGlobalHookPoint(point);
        console.log('[InterpreterOverlay] accepted pinned review control click', {
          x: Math.round(normalizedPoint.x),
          y: Math.round(normalizedPoint.y),
        });
        for (const callback of this.acceptCallbacks) {
          callback();
        }
        this.globalScopeGesture = null;
        this.clearGlobalScopeGestureTimeout();
        return;
      }
      if (hit === 'reject') {
        const normalizedPoint = this.normalizeGlobalHookPoint(point);
        console.log('[InterpreterOverlay] rejected pinned review control click', {
          x: Math.round(normalizedPoint.x),
          y: Math.round(normalizedPoint.y),
        });
        for (const callback of this.rejectCallbacks) {
          callback();
        }
        this.globalScopeGesture = null;
        this.clearGlobalScopeGestureTimeout();
        return;
      }
      const normalizedPoint = this.normalizeGlobalHookPoint(point);
      console.log('[InterpreterOverlay] pinned review control click missed', {
        rawX: Math.round(point.x),
        rawY: Math.round(point.y),
        coordinateSpace: point.coordinateSpace ?? 'physical',
        x: Math.round(normalizedPoint.x),
        y: Math.round(normalizedPoint.y),
        displayX: this.interactionDisplay.boundsDIP.x,
        displayY: this.interactionDisplay.boundsDIP.y,
        displayScaleFactor: this.interactionDisplay.scaleFactor,
        reviewControlBounds: this.lastWorldOverlayVisualHealth?.reviewControlBounds ?? null,
      });
    }

    if (this.overlayState.mode === 'input' && this.isPrimaryMouseButton(point.button)) {
      const contextChipRemoveId = this.getContextChipRemoveIdAtPoint(point);
      if (contextChipRemoveId) {
        this.removeOverlayContextItem(contextChipRemoveId);
        return;
      }
    }

    if (
      this.overlayState.mode !== 'input'
      || !this.isPrimaryMouseButton(point.button)
      || Date.now() < this.suppressRegionSelectionUntil
      || this.isPointInsideOverlayControl(point)
    ) {
      this.globalScopeGesture = null;
      this.clearGlobalScopeGestureTimeout();
      return;
    }

    const normalizedPoint = this.normalizeGlobalHookPoint(point);
    this.clearGlobalScopeGestureTimeout();
    const gestureStartedAt = Date.now();
    this.globalScopeGesture = {
      startX: normalizedPoint.x,
      startY: normalizedPoint.y,
      lastX: normalizedPoint.x,
      lastY: normalizedPoint.y,
      role: this.resolveRegionSelectionRole(this.overlayState.activeRegionRole),
      loggedFirstMove: false,
      startedAt: gestureStartedAt,
      lastActivityAt: gestureStartedAt,
    };
    this.scopeSelectionInProgress = true;
    this.syncProgressiveBlurVisibility();
    this.scheduleGlobalScopeGestureTimeout(gestureStartedAt);
    console.log('[InterpreterOverlay] global scope selection started', {
      x: Math.round(normalizedPoint.x),
      y: Math.round(normalizedPoint.y),
    });
  }

  private handleGlobalMouseMove(point: { x: number; y: number; coordinateSpace?: 'dip' | 'physical' }): void {
    if (!this.globalScopeGesture || this.overlayState.mode !== 'input' || !this.interactionDisplay) {
      return;
    }

    const normalizedPoint = this.normalizeGlobalHookPoint(point);
    this.globalScopeGesture.lastX = normalizedPoint.x;
    this.globalScopeGesture.lastY = normalizedPoint.y;
    this.globalScopeGesture.lastActivityAt = Date.now();
    if (!this.globalScopeGesture.loggedFirstMove) {
      this.globalScopeGesture.loggedFirstMove = true;
      console.log('[InterpreterOverlay] global scope selection moved', {
        x: Math.round(normalizedPoint.x),
        y: Math.round(normalizedPoint.y),
      });
    }
    this.scheduleGlobalScopeGestureTimeout(this.globalScopeGesture.lastActivityAt);
    if (
      !this.regionDragCaptureActive
      && Math.hypot(
        normalizedPoint.x - this.globalScopeGesture.startX,
        normalizedPoint.y - this.globalScopeGesture.startY,
      ) >= REGION_DRAG_CAPTURE_THRESHOLD_DIP
    ) {
      // The drag is now unambiguously a region selection. Capture the mouse
      // for the remainder of the drag so it stops driving the app underneath;
      // releaseRegionDragCapture restores click-through on mouseup, stale
      // gesture cleanup, and mode exit.
      this.regionDragCaptureActive = true;
      this.overlay.enableMouseEvents();
    }
    const absoluteBounds = normalizeDragBounds(
      { x: this.globalScopeGesture.startX, y: this.globalScopeGesture.startY },
      { x: normalizedPoint.x, y: normalizedPoint.y },
    );
    const localBounds = clampBoundsToBounds(
      toLocalBounds(absoluteBounds, this.interactionDisplay.boundsDIP),
      {
        x: 0,
        y: 0,
        width: this.interactionDisplay.boundsDIP.width,
        height: this.interactionDisplay.boundsDIP.height,
      },
    );
    this.sendDragPreview(hasMeaningfulScope(localBounds) ? localBounds : null);
  }

  private releaseRegionDragCapture(): void {
    if (!this.regionDragCaptureActive) {
      return;
    }
    this.regionDragCaptureActive = false;
    this.overlay.disableMouseEvents();
  }

  private handleGlobalMouseUp(point: { x: number; y: number; button: number; coordinateSpace?: 'dip' | 'physical' }): void {
    const gesture = this.globalScopeGesture;
    this.globalScopeGesture = null;
    this.clearGlobalScopeGestureTimeout();
    // The drag is over either way; the overlay must never stay captured past
    // mouseup, including the early-return paths below.
    this.releaseRegionDragCapture();

    if (
      !gesture
      || this.overlayState.mode !== 'input'
      || !this.interactionDisplay
      || !this.isPrimaryMouseButton(point.button)
    ) {
      if (gesture) {
        console.log('[InterpreterOverlay] ignored global scope selection mouse up', {
          mode: this.overlayState.mode,
          hasInteractionDisplay: Boolean(this.interactionDisplay),
          button: point.button,
          isPrimary: this.isPrimaryMouseButton(point.button),
          sawMove: gesture.loggedFirstMove,
        });
      }
      return;
    }

    this.scopeSelectionInProgress = false;
    this.overlay.setFocusable(true);
    this.overlay.disableMouseEvents();
    this.syncProgressiveBlurVisibility();
    this.sendDragPreview(null);

    if (Date.now() < this.suppressRegionSelectionUntil) {
      console.log('[InterpreterOverlay] ignored global scope selection after context chip removal');
      return;
    }

    const normalizedPoint = this.normalizeGlobalHookPoint(point);
    const absoluteBounds = normalizeDragBounds(
      { x: gesture.startX, y: gesture.startY },
      { x: normalizedPoint.x, y: normalizedPoint.y },
    );
    const localBounds = clampBoundsToBounds(
      toLocalBounds(absoluteBounds, this.interactionDisplay.boundsDIP),
      {
        x: 0,
        y: 0,
        width: this.interactionDisplay.boundsDIP.width,
        height: this.interactionDisplay.boundsDIP.height,
      },
    );

    if (!hasMeaningfulScope(localBounds)) {
      return;
    }

    console.log('[InterpreterOverlay] global scope selected', {
      x: Math.round(localBounds.x),
      y: Math.round(localBounds.y),
      width: Math.round(localBounds.width),
      height: Math.round(localBounds.height),
      role: gesture.role,
      existingContextItems: this.overlayState.contextItems.map((item) => ({
        id: item.id,
        kind: item.kind,
        role: item.kind === 'region' ? item.role : undefined,
      })),
    });

    this.cancelVoiceTimer();
    if (this.isVoiceInputActive) {
      this.trackVoiceCancelled('scope_selection');
      this.stt?.abortRecording();
      this.isVoiceInputActive = false;
      this.send({ isRecording: false, amplitude: 0 });
    }

    this.lastGlobalScopeSelectedAt = Date.now();
    const selectedRole = gesture.role;
    this.lastGlobalScopeLocalBounds = localBounds;
    const selectedAbsoluteBounds = toAbsoluteBounds(localBounds, this.interactionDisplay.boundsDIP);
    if (selectedRole === 'target') {
      this.scopeBounds = selectedAbsoluteBounds;
      this.selectionElements = [];
      this.scopedStructuredContext = null;
    }
    this.clearSelectionPreviewRefresh();
    this.scopeSelectionInProgress = false;
    const nextRegionContext = createOverlayRegionContextItem({
      role: selectedRole,
      bounds: selectedAbsoluteBounds,
      display: this.interactionDisplay,
    });
    const existingContextItems = this.overlayState.contextItems ?? [];
    const nextContextItems = selectedRole === 'target'
      ? [
          nextRegionContext,
          ...existingContextItems.filter((item) => item.role !== 'target'),
        ]
      : [...existingContextItems, nextRegionContext];
    if (selectedRole === 'target') {
      this.send({ selectableElements: [] });
    }
    this.send({
      scopeBounds: selectedRole === 'target' ? localBounds : this.overlayState.scopeBounds,
      draftScopeBounds: null,
      contextItems: nextContextItems,
      targetContextId: selectedRole === 'target'
        ? nextRegionContext.id
        : this.overlayState.targetContextId,
      activeRegionRole: 'reference',
    });
    this.overlay.disableMouseEvents();
    this.overlay.focus();
    this.overlay.requestInputFocus();
    // The drag gesture and target-context hydration can briefly move OS focus
    // off the prompt input. Re-run the focus retry ladder so typing works
    // immediately after every region selection.
    this.scheduleInputFocusRetries(this.presentationTimings.cycleId, this.interactionDisplay.id);
    if (selectedRole === 'target') {
      void this.loadSelectionElementsForTargetBounds(this.interactionDisplay, selectedAbsoluteBounds);
    } else {
      void this.refreshRegionContextEvidence(nextRegionContext.id, this.interactionDisplay, selectedAbsoluteBounds);
    }
  }

  private clearGlobalScopeGestureTimeout(): void {
    if (!this.globalScopeGestureTimeout) {
      return;
    }
    clearTimeout(this.globalScopeGestureTimeout);
    this.globalScopeGestureTimeout = null;
  }

  private scheduleGlobalScopeGestureTimeout(expectedLastActivityAt: number): void {
    this.clearGlobalScopeGestureTimeout();
    const timeoutMs = this.globalScopeGesture?.loggedFirstMove
      ? GLOBAL_SCOPE_GESTURE_ACTIVE_STALE_TIMEOUT_MS
      : GLOBAL_SCOPE_GESTURE_STALE_TIMEOUT_MS;
    this.globalScopeGestureTimeout = setTimeout(() => {
      const gesture = this.globalScopeGesture;
      if (!gesture || gesture.lastActivityAt !== expectedLastActivityAt) {
        return;
      }
      this.globalScopeGesture = null;
      this.globalScopeGestureTimeout = null;
      this.scopeSelectionInProgress = false;
      this.releaseRegionDragCapture();
      this.sendDragPreview(null);
      if (this.overlayState.mode === 'input') {
        this.overlay.setFocusable(true);
        this.overlay.disableMouseEvents();
      }
      this.syncProgressiveBlurVisibility();
      console.warn('[InterpreterOverlay] cancelled stale global scope selection', {
        idleMs: Date.now() - gesture.lastActivityAt,
        durationMs: Date.now() - gesture.startedAt,
        role: gesture.role,
        sawMove: gesture.loggedFirstMove,
      });
    }, timeoutMs);
  }

  private sendDragPreview(bounds: Bounds | null): void {
    const window = this.overlay.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }

    window.webContents.send(CHANNELS.DRAG_PREVIEW, {
      bounds,
      color: this.tracePrimaryColor,
    });
  }

  private readonly handleOverlayAction = async (_event: Electron.IpcMainEvent, action: OverlayAction): Promise<void> => {
    switch (action.type) {
      case 'accept':
        for (const callback of this.acceptCallbacks) {
          callback();
        }
        break;

      case 'accept-all':
        for (const callback of this.acceptAllCallbacks) {
          callback();
        }
        break;

      case 'accept-all-session':
        for (const callback of this.acceptAllSessionCallbacks) {
          callback();
        }
        break;

      case 'reject':
        for (const callback of this.rejectCallbacks) {
          callback();
        }
        break;

      case 'dismiss':
        this.cancelVoiceTimer();
        if (this.isVoiceInputActive) {
          this.trackVoiceCancelled('dismiss');
          this.stt?.abortRecording();
          this.isVoiceInputActive = false;
        }
        this.trackOverlayEvent('overlay_dismissed', {
          reason: 'dismiss',
          inputMethod: this.voiceInputUsed ? 'voice' : 'text',
          durationMs: this.inputOpenedAt === null ? undefined : Date.now() - this.inputOpenedAt,
        });
        this.notePresentationCloseRequested('dismiss');
        this.send({
          ...DEFAULT_OVERLAY_STATE,
          screenshot: null,
          transcript: '',
          isRecording: false,
          amplitude: 0,
        });
        this.resetOverlayInputTracking();
        break;

      case 'draft-changed':
        if (this.overlayState.mode !== 'input') {
          break;
        }
        this.cancelVoiceTimer();
        // Track the latest text draft for debug snapshots and recovery without
        // echoing every keystroke back into the renderer while the user types.
        this.overlayState = {
          ...this.overlayState,
          transcript: action.text,
        };
        break;

      case 'scope-selection-started':
        this.cancelVoiceTimer();
        this.scopeSelectionInProgress = true;
        if (this.isVoiceInputActive) {
          this.trackVoiceCancelled('scope_selection');
          this.stt?.abortRecording();
          this.isVoiceInputActive = false;
          this.send({ isRecording: false, amplitude: 0 });
        }
        this.syncProgressiveBlurVisibility();
        break;

      case 'scope-selection-ended':
        this.scopeSelectionInProgress = false;
        this.syncProgressiveBlurVisibility();
        break;

      case 'scope-draft-changed':
        if (!this.interactionDisplay || this.overlayState.mode !== 'input') {
          break;
        }
        this.scheduleSelectionPreviewRefresh(action.bounds);
        break;

      case 'scope-selected':
      case 'region-selected':
        if (!this.interactionDisplay || this.overlayState.mode !== 'input') {
          break;
        }

        if (Date.now() < this.suppressRegionSelectionUntil) {
          console.log('[InterpreterOverlay] ignored renderer region selection after context chip removal', {
            type: action.type,
          });
          break;
        }

        if (
          this.lastGlobalScopeSelectedAt !== null
          && Date.now() - this.lastGlobalScopeSelectedAt < 10000
        ) {
          console.log('[InterpreterOverlay] ignored duplicate renderer scope-selected after global scope selection', {
            incoming: {
              x: Math.round(action.bounds.x),
              y: Math.round(action.bounds.y),
              width: Math.round(action.bounds.width),
              height: Math.round(action.bounds.height),
            },
            current: this.lastGlobalScopeLocalBounds
              ? {
                  x: Math.round(this.lastGlobalScopeLocalBounds.x),
                  y: Math.round(this.lastGlobalScopeLocalBounds.y),
                  width: Math.round(this.lastGlobalScopeLocalBounds.width),
                  height: Math.round(this.lastGlobalScopeLocalBounds.height),
                }
              : null,
          });
          break;
        }

        this.cancelVoiceTimer();
        if (this.isVoiceInputActive) {
          this.trackVoiceCancelled('scope_selection');
          this.stt?.abortRecording();
          this.isVoiceInputActive = false;
          this.send({ isRecording: false, amplitude: 0 });
        }

        const clampedLocalBounds = clampBoundsToBounds(action.bounds, {
          x: 0,
          y: 0,
          width: this.interactionDisplay.boundsDIP.width,
          height: this.interactionDisplay.boundsDIP.height,
        });

        if (!hasMeaningfulScope(clampedLocalBounds)) {
          break;
        }

        this.clearSelectionPreviewRefresh();
        const requestedRole = action.type === 'region-selected'
          ? (action.role ?? this.overlayState.activeRegionRole)
          : this.overlayState.activeRegionRole;
        const selectedRole = this.resolveRegionSelectionRole(requestedRole);
        if (
          selectedRole === 'target'
          && this.overlayState.activeRegionRole !== 'target'
          && this.overlayState.targetContextId
        ) {
          console.log('[InterpreterOverlay] ignored stale renderer target scope-selected after target context commit', {
            incoming: {
              x: Math.round(action.bounds.x),
              y: Math.round(action.bounds.y),
              width: Math.round(action.bounds.width),
              height: Math.round(action.bounds.height),
            },
            activeRegionRole: this.overlayState.activeRegionRole,
            targetContextId: this.overlayState.targetContextId,
          });
          break;
        }
        const selectedAbsoluteBounds = toAbsoluteBounds(clampedLocalBounds, this.interactionDisplay.boundsDIP);
        if (selectedRole === 'target') {
          this.scopeBounds = selectedAbsoluteBounds;
          this.selectionElements = [];
          this.scopedStructuredContext = null;
        }
        this.scopeSelectionInProgress = false;
        const nextRegionContext = createOverlayRegionContextItem({
          role: selectedRole,
          bounds: selectedAbsoluteBounds,
          display: this.interactionDisplay,
        });
        const existingContextItems = this.overlayState.contextItems ?? [];
        const nextContextItems = selectedRole === 'target'
          ? [
              nextRegionContext,
              ...existingContextItems.filter((item) => item.role !== 'target'),
            ]
          : [...existingContextItems, nextRegionContext];
        if (selectedRole === 'target') {
          this.send({ selectableElements: [] });
        }
        console.log('[InterpreterOverlay] renderer region selected', {
          type: action.type,
          role: selectedRole,
          bounds: {
            x: Math.round(clampedLocalBounds.x),
            y: Math.round(clampedLocalBounds.y),
            width: Math.round(clampedLocalBounds.width),
            height: Math.round(clampedLocalBounds.height),
          },
          existingContextItems: existingContextItems.map((item) => ({
            id: item.id,
            kind: item.kind,
            role: item.kind === 'region' ? item.role : undefined,
          })),
        });
        this.send({
          scopeBounds: selectedRole === 'target' ? clampedLocalBounds : this.overlayState.scopeBounds,
          contextItems: nextContextItems,
          targetContextId: selectedRole === 'target'
            ? nextRegionContext.id
            : this.overlayState.targetContextId,
          activeRegionRole: 'reference',
        });
        if (selectedRole === 'target') {
          void this.loadSelectionElementsForTargetBounds(this.interactionDisplay, selectedAbsoluteBounds);
        } else {
          void this.refreshRegionContextEvidence(nextRegionContext.id, this.interactionDisplay, selectedAbsoluteBounds);
        }
        break;

      case 'clear-input-context':
        if (this.overlayState.mode !== 'input') {
          break;
        }
        this.scopeBounds = null;
        this.selectionElements = [];
        this.scopedStructuredContext = null;
        this.overlayTextManagedContext = null;
        this.send({
          scopeBounds: null,
          selectableElements: [],
          contextItems: [],
          targetContextId: null,
          activeRegionRole: 'target',
        });
        break;

      case 'remove-context-item': {
        if (this.overlayState.mode !== 'input') {
          break;
        }
        this.removeOverlayContextItem(action.id);
        break;
      }

      case 'set-active-region-role':
        if (this.overlayState.mode !== 'input') {
          break;
        }
        this.send({ activeRegionRole: action.role });
        break;

      case 'files-dropped': {
        if (this.overlayState.mode !== 'input') {
          break;
        }
        try {
          const files = await Promise.all(action.files.map(normalizeOverlayFileContextItem));
          this.send({ contextItems: [...this.overlayState.contextItems, ...files] });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[InterpreterOverlay] Dropped file rejected', { error: message });
          await dialog.showMessageBox({
            type: 'warning',
            title: 'Interpreter Overlay',
            message: 'File could not be added.',
            detail: message,
            buttons: ['OK'],
          });
        }
        break;
      }

      case 'input-focus-change':
        if (this.overlayState.mode === 'input' && this.overlayState.inputReady !== action.focused) {
          if (action.focused) {
            this.notePresentationMilestone('inputReadyAt', Date.now());
          }
          this.send({ inputReady: action.focused });
          if (action.focused) {
            this.attachPendingInitialHotkeyContextAfterInputReady();
            this.prepareWorldOverlayAfterInputReady();
            setTimeout(() => this.startPendingTargetContextHydration('input ready'), 0);
          }
        }
        break;

      case 'renderer-ready':
      case 'request-state-sync':
        this.lastSentOverlayStateSignature = null;
        this.send({});
        break;

      case 'toggle-voice-recording':
        if (this.overlayState.mode !== 'input') {
          break;
        }

        if (this.isVoiceInputActive) {
          await this.stopVoiceInput();
          break;
        }

        if (this.effectiveSettings.advancedVoiceEnabled) {
          this.advancedVoice.startAdvancedVoiceInput('button');
          break;
        }

        if (!this.stt) {
          break;
        }

        this.startVoiceInput('button');
        break;

      case 'stop-advanced-voice':
        this.advancedVoice.stopAdvancedVoiceInput();
        this.send({
          ...DEFAULT_OVERLAY_STATE,
          screenshot: null,
        });
        this.resetOverlayInputTracking();
        break;

      case 'approve-global-approval':
        this.approveGlobalApproval();
        break;

      case 'deny-global-approval':
        this.denyGlobalApproval();
        break;

      case 'reveal-agent-window':
        agentTabManager.requestAgentWindowReveal(action.agentId);
        this.refreshAgentDashboardState();
        break;

      case 'stop-agent-window':
        agentTabManager.requestAgentWindowStop(action.agentId);
        this.refreshAgentDashboardState();
        break;

      case 'send-agent-window-message': {
        const message = action.message.trim();
        if (!message) {
          break;
        }
        agentTabManager.requestAgentWindowMessage({
          agentId: action.agentId,
          message,
        });
        this.refreshAgentDashboardState();
        break;
      }

      case 'approve-dashboard-approval':
        this.respondToDashboardApproval(action.approvalId, true, action.rememberForSession === true);
        break;

      case 'deny-dashboard-approval':
        this.respondToDashboardApproval(action.approvalId, false);
        break;

      case 'visual-health':
        this.noteOverlayVisualHealth(action.health);
        break;

      case 'submit':
        if (this.overlayState.mode !== 'input') {
          console.warn('[InterpreterOverlay] Ignoring submit outside input mode', {
            mode: this.overlayState.mode,
            textLength: action.text.trim().length,
          });
          break;
        }

        this.cancelVoiceTimer();
        if (this.isVoiceInputActive) {
          this.trackVoiceCancelled('submit');
          this.stt?.abortRecording();
          this.isVoiceInputActive = false;
        }

        const hasControllableTargetContext = this.overlayState.contextItems.some((item) => (
          item.kind === 'region' && item.role === 'target'
        ));
        await this.waitForPendingHotkeyContext('submit', {
          awaitTargetHydration: hasControllableTargetContext,
        });
        const systemAddendum = this.nextRunSystemAddendum;
        this.nextRunSystemAddendum = null;
        const inputMethod: OverlayRunInputMethod = this.voiceInputUsed ? 'voice' : 'text';
        let textControllerRequest = buildOverlayTextControllerRequest({
          text: action.text,
          serviceContextItems: this.overlayState.contextItems,
          submittedContextItems: action.contextItems,
          attachments: action.attachments,
          workspacePath: action.workspacePath,
          targetWindowSessionKey: action.targetWindowSessionKey,
          profileId: action.profileId,
          renderedProfileId: null,
          inputMethod,
          managedContext: this.overlayTextManagedContext,
        });
        if (textControllerRequest.targetContext) {
          await this.ensureExecutableContextForTarget(textControllerRequest.targetContext);
          textControllerRequest = buildOverlayTextControllerRequest({
            text: action.text,
            serviceContextItems: this.overlayState.contextItems,
            submittedContextItems: action.contextItems,
            attachments: action.attachments,
            workspacePath: action.workspacePath,
            targetWindowSessionKey: action.targetWindowSessionKey,
            profileId: action.profileId,
            renderedProfileId: null,
            inputMethod,
            managedContext: this.overlayTextManagedContext,
          });
        }
        const trimmedText = textControllerRequest.text;
        const contextItems = textControllerRequest.contextItems;
        const targetContext = textControllerRequest.targetContext;
        const userAttachments = textControllerRequest.attachments;
        const effectiveProfileId = textControllerRequest.profileId;
        const wholeComputerState = await this.buildOverlayWholeComputerState({
          workspacePath: textControllerRequest.workspacePath,
          targetWindowSessionKey: textControllerRequest.targetWindowSessionKey,
          targetContext,
          contextItems,
        });
        const customInstructions = await getCustomInstructions();
        if (!textControllerRequest.hasUserInput) {
          this.overlayTextManagedContext = null;
          this.send({ ...DEFAULT_OVERLAY_STATE, screenshot: null });
          this.resetOverlayInputTracking();
          break;
        }

        if (isExecutableOverlayTextControllerDirectCommand(textControllerRequest.directCommand)) {
          const agentId = createOverlayAgentId();
          this.trackOverlayEvent('overlay_direct_command_submitted', {
            inputMethod,
            toolName: textControllerRequest.directCommand.toolName,
            workspacePath: textControllerRequest.workspacePath ?? undefined,
          });
          this.runStartedAt = Date.now();
          this.lastRunInputMethod = inputMethod;
          this.lastWorkspaceAgentLaunch = null;
          this.beginDebugRun();
          this.notePresentationCloseRequested('submit');
          this.send({
            mode: 'working',
            action: null,
            ghosts: [],
            pill: { kind: 'loading' },
            screenshot: null,
            transcript: '',
            isRecording: false,
            amplitude: 0,
            ctrlPressed: false,
            shiftPressed: false,
          });
          this.resetOverlayInputTracking();

          try {
            const directCommandProfile = textControllerRequest.directCommand.toolName === 'call_hidden_agent'
              ? await this.resolveHiddenAgentProfile()
              : null;
            const directCommandProfileId = directCommandProfile
              ? directCommandProfile.id
              : textControllerRequest.profileId;
            const result = await executeOverlayTextControllerDirectCommand(
              textControllerRequest.directCommand,
              {
                agentId,
                workspacePath: textControllerRequest.workspacePath,
                profileId: directCommandProfileId,
                ...(directCommandProfile
                  ? {
                      modelConfig: profileToModelConfig(directCommandProfile, {
                        reasoningEffort: directCommandProfile.reasoningEffort,
                      }),
                    }
                  : {}),
                targetWindowSessionKey: textControllerRequest.targetWindowSessionKey,
                targetContext,
                contextItems,
                conversationContext: buildOverlayTextControllerContextPrompt(textControllerRequest, {
                  availableToolsText: buildOverlayTextControllerToolCatalogText(),
                  wholeComputerState,
                  customInstructions,
                }),
              },
            );
            console.log('[InterpreterOverlay] direct command completed', {
              toolName: textControllerRequest.directCommand.toolName,
              textLength: result.text.length,
            });
            this.overlayTextManagedContext = recordOverlayTextControllerDirectCommandResult({
              managedContext: textControllerRequest.managedContext,
              request: textControllerRequest,
              toolResultText: result.text,
              toolCalls: [result.toolCall],
              now: Date.now(),
            });
            this.runStartedAt = null;
            this.lastRunInputMethod = null;
            this.finishDebugRun('completed', result.text, 'direct_command_completed');
            this.send({ ...DEFAULT_OVERLAY_STATE });
          } catch (error) {
            const message = getErrorMessage(error);
            const directCommandPermissionResultText = error instanceof OverlayTextDirectCommandExecutionError
              ? error.toolCall.permissionResultText
              : /\b(?:permission|denied|approval)\b/i.test(message) ? message : null;
            console.error('[InterpreterOverlay] direct command failed:', error);
            this.trackOverlayError('overlay_direct_command_failed', message, {
              inputMethod,
              toolName: textControllerRequest.directCommand.toolName,
            });
            this.overlayTextManagedContext = recordOverlayTextControllerDirectCommandResult({
              managedContext: textControllerRequest.managedContext,
              request: textControllerRequest,
              toolResultText: `Error: ${message}`,
              toolCalls: error instanceof OverlayTextDirectCommandExecutionError
                ? [{
                    ...error.toolCall,
                    resultText: `Error: ${message}`,
                    permissionResultText: directCommandPermissionResultText,
                  }]
                : undefined,
              permissionResultText: directCommandPermissionResultText,
              now: Date.now(),
            });
            this.runStartedAt = null;
            this.lastRunInputMethod = null;
            this.finishDebugRun('failed', message, 'direct_command_failed');
            await this.showInputMode(false);
            this.send({
              pill: { kind: 'error', message },
            });
          }
          break;
        }

        const promptAssembledAt = Date.now();
        const availableToolsText = buildOverlayTextControllerToolCatalogText();
        const effectivePrompt = buildOverlayTextControllerContextPrompt(textControllerRequest, {
          availableToolsText,
          wholeComputerState,
          customInstructions,
        });
        const normalAgentUserAttachments = [
          ...this.buildNormalAgentAttachmentsFromContextItems(contextItems),
          ...userAttachments,
        ];

        console.log('[InterpreterOverlay] submit context summary', {
          submittedContextItemCount: action.contextItems?.length ?? 0,
          serviceContextItemCount: this.overlayState.contextItems.length,
          mergedContextItemCount: contextItems.length,
          fileContextItemCount: contextItems.filter((item) => item.kind === 'file').length,
          normalAgentAttachmentCount: normalAgentUserAttachments.length,
        });
        console.log('[InterpreterOverlay] [SUBMIT_TIMING] prompt assembled', {
          iso: new Date(promptAssembledAt).toISOString(),
          promptChars: effectivePrompt.length,
          toolCatalogChars: availableToolsText.length,
          userTextChars: trimmedText.length,
        });

        this.trackOverlayEvent('overlay_run_submitted', {
          inputMethod,
          textLength: trimmedText.length,
          attachmentCount: userAttachments.length,
          source: this.lastOpenSource,
          profileId: effectiveProfileId,
          workspacePath: action.workspacePath ?? undefined,
          contextItemCount: contextItems.length,
          referenceContextCount: contextItems.filter((item) => item.role === 'reference').length,
          inputDurationMs: this.inputOpenedAt === null ? undefined : Date.now() - this.inputOpenedAt,
        });
        this.runStartedAt = Date.now();
        this.lastRunInputMethod = inputMethod;
        this.lastWorkspaceAgentLaunch = null;
        this.beginDebugRun();

        await this.beginPinningWorldOverlayToTarget();
        this.notePresentationCloseRequested('submit');
        this.send({
          mode: 'working',
          action: null,
          ghosts: [],
          pill: { kind: 'loading' },
          screenshot: null,
          transcript: '',
          isRecording: false,
          amplitude: 0,
          ctrlPressed: false,
          shiftPressed: false,
        });
        this.resetOverlayInputTracking();

        try {
          const agentId = createOverlayAgentId();
          const callerToken = createOverlayCallerToken();
          const selectedProfile = await this.resolveOverlayAgentProfile(effectiveProfileId);
          const imageMentions = await this.persistOverlayUserAttachmentMentions(normalAgentUserAttachments);
          const targetWindow = await this.resolveOverlayTargetWindow(
            action.workspacePath,
            action.targetWindowSessionKey,
            { background: !targetContext },
          );

          if (!targetContext) {
            await startAgentTask({
              agentId,
              callerToken,
              mode: 'headed',
              message: prependOverlayMentions(effectivePrompt, imageMentions),
              modelConfig: profileToModelConfig(selectedProfile, {
                reasoningEffort: selectedProfile.reasoningEffort,
              }),
              workspace: targetWindow.workspacePath ?? undefined,
              activate: false,
              targetWindowSessionKey: targetWindow.targetWindowSessionKey,
              toolProfileId: selectedProfile.id,
            });
            this.overlayTextManagedContext = recordOverlayTextControllerAgentLaunchResult({
              managedContext: textControllerRequest.managedContext,
              request: textControllerRequest,
              launch: {
                agentId,
                target: 'workspace',
                profileId: selectedProfile.id,
                workspacePath: targetWindow.workspacePath,
                targetWindowSessionKey: targetWindow.targetWindowSessionKey,
                allowedToolCount: 0,
                initialElementCount: null,
              },
              toolCalls: [this.buildOverlayAgentLaunchManagedToolCall({
                agentId,
                target: 'workspace',
                profileId: selectedProfile.id,
                workspacePath: targetWindow.workspacePath,
                targetWindowSessionKey: targetWindow.targetWindowSessionKey,
                allowedToolCount: 0,
                initialElementCount: null,
                activate: false,
                resultText: 'Started visible Interpreter agent.',
              })],
              now: Date.now(),
            });
            this.runStartedAt = null;
            this.lastRunInputMethod = null;
            this.finishDebugRun('completed', '', 'background_agent_started');
            this.send({ ...DEFAULT_OVERLAY_STATE });
            break;
          }

          let agentLaunchPrompt = effectivePrompt;
          if (trimmedText && hasExecutableTargetRefs(targetContext)) {
            const fastPath = await this.attemptOverlayTypedFastPathSubmit({
              agentId,
              callerToken,
              targetContext,
              contextItems,
              userText: trimmedText,
              selectedProfile,
              workspacePath: targetWindow.workspacePath,
              windowSessionKey: targetWindow.targetWindowSessionKey,
            });
            if (fastPath.handled) {
              break;
            }
            if (fastPath.handoffSummary) {
              agentLaunchPrompt = [
                effectivePrompt,
                '<fast_path_handoff>',
                'A fast typed controller attempted this request first against the selected target and handed off. Its conversation summary:',
                fastPath.handoffSummary,
                '</fast_path_handoff>',
              ].join('\n\n');
            }
          }

          // The handoff/launch path must not inherit a dead target silently:
          // if the committed target window is gone, the agent prompt carries
          // the observation explicitly so the agent knows the refs are dead.
          const closedTargetMessage = await committedTargetWindowClosedMessage(targetContext);
          if (closedTargetMessage) {
            console.warn('[InterpreterOverlay] [FAST_PATH] dead-target-observation', {
              at: 'agent_handoff',
              message: closedTargetMessage,
            });
            agentLaunchPrompt = [
              agentLaunchPrompt,
              '<target_window_closed>',
              closedTargetMessage,
              '</target_window_closed>',
            ].join('\n\n');
          }

          const session = await this.createAgentToolSession({
            agentId,
            callerToken,
            workspacePath: targetWindow.workspacePath,
            windowSessionKey: targetWindow.targetWindowSessionKey,
            targetContext,
          });

          await startAgentTask({
            agentId,
            callerToken,
            mode: 'headed',
            message: this.buildOverlayLaunchMessage(
              agentLaunchPrompt,
              session.initialContext,
              targetContext,
              imageMentions,
            ),
            system: await this.buildOverlaySystemPrompt(session, systemAddendum),
            modelConfig: profileToModelConfig(selectedProfile, {
              reasoningEffort: selectedProfile.reasoningEffort,
            }),
            workspace: targetWindow.workspacePath ?? undefined,
            activate: true,
            targetWindowSessionKey: targetWindow.targetWindowSessionKey,
            allowedToolNames: OVERLAY_AGENT_ALLOWED_TOOL_NAMES,
            toolProfileId: selectedProfile.id,
          });
          this.overlayTextManagedContext = recordOverlayTextControllerAgentLaunchResult({
            managedContext: textControllerRequest.managedContext,
            request: textControllerRequest,
            launch: {
              agentId,
              target: 'overlay_target',
              profileId: selectedProfile.id,
              workspacePath: targetWindow.workspacePath,
              targetWindowSessionKey: targetWindow.targetWindowSessionKey,
              allowedToolCount: OVERLAY_AGENT_ALLOWED_TOOL_NAMES.length,
              initialElementCount: session.initialContext.elementCount,
            },
            toolCalls: [this.buildOverlayAgentLaunchManagedToolCall({
              agentId,
              target: 'overlay_target',
              profileId: selectedProfile.id,
              workspacePath: targetWindow.workspacePath,
              targetWindowSessionKey: targetWindow.targetWindowSessionKey,
              allowedToolCount: OVERLAY_AGENT_ALLOWED_TOOL_NAMES.length,
              initialElementCount: session.initialContext.elementCount,
              activate: true,
              resultText: 'Started visible Interpreter agent.',
            })],
            now: Date.now(),
          });

          this.lastWorkspaceAgentLaunch = {
            agentId,
            callerToken,
            overlaySessionId: session.id,
            profileId: selectedProfile.id,
            workspacePath: targetWindow.workspacePath,
            targetWindowSessionKey: targetWindow.targetWindowSessionKey,
            targetWindowId: targetWindow.targetWindowId,
            scopeBoundsDIP: session.scopeBoundsDIP,
            startupAttachmentCount: 0,
            initialElementCount: session.initialContext.elementCount,
            hasInitialScreenshot: Boolean(session.initialContext.screenshotPath),
            initialScreenshotPath: session.initialContext.screenshotPath ?? null,
            launchedAt: Date.now(),
          };
          this.send({
            ...DEFAULT_OVERLAY_STATE,
            screenshot: null,
            transcript: '',
            isRecording: false,
            amplitude: 0,
            ctrlPressed: false,
            shiftPressed: false,
          });
          showOverlayAgentNotification({
            body: buildProgrammaticRunNotificationBody(
              trimmedText || 'Interpreter Overlay request',
            ),
            targetWindowId: targetWindow.targetWindowId,
            showMainWindow: this.showMainWindow,
          });
        } catch (error) {
          const message = getErrorMessage(error);
          console.error('[InterpreterOverlay] Failed to launch workspace agent from overlay:', error);
          this.trackOverlayError('overlay_agent_launch_failed', message, {
            inputMethod,
            profileId: effectiveProfileId,
          });
          this.overlayTextManagedContext = recordOverlayTextControllerAgentFailureResult({
            managedContext: textControllerRequest.managedContext,
            request: textControllerRequest,
            toolResultText: `Error: ${message}`,
            permissionResultText: /\b(?:permission|denied|approval)\b/i.test(message) ? message : null,
            toolCalls: [this.buildOverlayAgentLaunchManagedToolCall({
              target: targetContext ? 'overlay_target' : 'workspace',
              profileId: effectiveProfileId,
              workspacePath: action.workspacePath,
              targetWindowSessionKey: action.targetWindowSessionKey,
              allowedToolCount: targetContext ? OVERLAY_AGENT_ALLOWED_TOOL_NAMES.length : 0,
              initialElementCount: null,
              activate: Boolean(targetContext),
              resultText: `Error: ${message}`,
              permissionResultText: /\b(?:permission|denied|approval)\b/i.test(message) ? message : null,
            })],
            now: Date.now(),
          });
          this.lastWorkspaceAgentLaunch = null;
          this.engine?.endAttachedToolSession();
          overlaySessionManager.clearAll();
          this.activeAttachedSessionId = null;
          this.activeAttachedAgentId = null;
          this.runStartedAt = null;
          this.lastRunInputMethod = null;
          this.finishDebugRun('failed', message, 'overlay_agent_launch_failed');
          await this.showInputMode(false);
          this.send({
            pill: { kind: 'error', message },
          });
        }
        break;
    }
  };

  /**
   * Resolve the model profile driving the typed fast controller loop. Under
   * the scenario harness this is the form-tests overlay LLM preset built from
   * FORM_TESTS_INTERPRETER_OVERLAY_LLM_* env; otherwise it is the overlay
   * preferred text profile.
   */
  private async resolveOverlayFastLoopProfile(): Promise<Profile> {
    if (FORM_TESTS_MODE) {
      return createFormTestsAdvancedVoiceAgentProfile();
    }
    const modelTaskProfiles = resolveOverlayModelTaskProfileIds(this.effectiveSettings);
    const profileId = modelTaskProfiles.preferredTextProfileId;
    if (!profileId) {
      throw new Error('No overlay preferred text profile is configured for the fast text controller.');
    }
    return await this.resolveOverlayAgentProfile(profileId);
  }

  /**
   * Typed fast controller loop: the realtime advanced-voice control loop, in
   * text. The fast model gets the same context packet and the same two bridge
   * tools as the realtime voice bridge (computer_batch + call_hidden_agent),
   * executes them through the same shared bridge executor with RunEngine
   * review, sees the touched-window diff in batch tool results, and
   * iterates until done. Returns handled=true when the loop owned the submit
   * (including loud post-execution failures); handled=false hands off to the
   * normal agent path, optionally with a conversation summary for the agent
   * prompt.
   */
  private async attemptOverlayTypedFastPathSubmit(options: {
    agentId: string;
    callerToken: string;
    targetContext: OverlayRegionContextItem;
    contextItems: OverlayContextItem[];
    userText: string;
    selectedProfile: Profile;
    workspacePath: string | null;
    windowSessionKey: string | null;
  }): Promise<{ handled: boolean; handoffSummary: string | null }> {
    const loopStartedAt = Date.now();
    // Dead target at submit: the loop still starts, and the lap-1 user
    // content carries the observation as data. The model decides the outcome.
    const closedAtSubmitMessage = await committedTargetWindowClosedMessage(options.targetContext);
    if (closedAtSubmitMessage) {
      console.warn('[InterpreterOverlay] [FAST_PATH] dead-target-observation', {
        at: 'submit',
        message: closedAtSubmitMessage,
      });
    }
    const contextPacketText = [
      buildOverlayContextPacketText(options.contextItems),
      ...(closedAtSubmitMessage
        ? [`<target_window_error>\n${closedAtSubmitMessage}\n</target_window_error>`]
        : []),
    ].join('\n\n');
    // Selected-context evidence for the harness: the packet size and the
    // selectable ref ids the first user message carries. The scenario driver
    // asserts these against the refs it observed in the committed selection.
    const packetRefIds = (options.targetContext.snapshot.selectableRefs.length > 0
      ? options.targetContext.snapshot.selectableRefs
      : options.targetContext.selectableElements ?? []
    ).map((ref) => ref.id);
    console.log('[InterpreterOverlay] [FAST_PATH] loop-start', {
      iso: new Date(loopStartedAt).toISOString(),
      userTextChars: options.userText.length,
      contextItemCount: options.contextItems.length,
      packetChars: contextPacketText.length,
      packetRefIdCount: packetRefIds.length,
      packetRefIds: packetRefIds.slice(0, 400).join(','),
      deadTargetObservation: closedAtSubmitMessage !== null,
    });

    let transport: ReturnType<typeof createOverlayTextControllerLoopChatTransport>;
    try {
      transport = createOverlayTextControllerLoopChatTransport(
        await this.resolveOverlayFastLoopProfile(),
      );
    } catch (error) {
      console.log(`[InterpreterOverlay] [FAST_PATH] handoff to agent: transport unavailable: ${getErrorMessage(error)}`);
      return { handled: false, handoffSummary: null };
    }

    const selectedModelConfig = profileToModelConfig(options.selectedProfile, {
      reasoningEffort: options.selectedProfile.reasoningEffort,
    });
    let fastPathSession: OverlaySessionRecord | null = null;
    const ensureFastPathSession = async (): Promise<OverlaySessionRecord> => {
      if (!fastPathSession) {
        fastPathSession = await this.createAgentToolSession({
          agentId: options.agentId,
          callerToken: options.callerToken,
          workspacePath: options.workspacePath,
          windowSessionKey: options.windowSessionKey,
          targetContext: options.targetContext,
        });
      }
      return fastPathSession;
    };
    const releaseFastPathSession = (): void => {
      if (!fastPathSession) {
        return;
      }
      this.engine?.endAttachedToolSession();
      overlaySessionManager.clearAll();
      this.activeAttachedSessionId = null;
      this.activeAttachedAgentId = null;
      fastPathSession = null;
    };

    let lastDelegatedAssistantText: string | null = null;
    let result: Awaited<ReturnType<typeof runOverlayTextControllerLoop>>;
    try {
      result = await runOverlayTextControllerLoop({
        contextPacketText,
        userText: options.userText,
        targetWindowClosedMessage: closedAtSubmitMessage,
        transport,
        executeComputerBatch: async (argumentsJson) => {
          // The shared bridge turns a dead committed target into a
          // target_window_closed tool result instead of executing, so a
          // session only exists once the target is live.
          const session = await ensureFastPathSession();
          const output = await callOverlayComputerBatchBridgeTool({
            argumentsJson,
            agentId: session.agentId,
            workspacePath: options.workspacePath,
            profileId: options.selectedProfile.id,
            modelConfig: selectedModelConfig,
            targetContext: options.targetContext,
            callSelectedTargetBatch: async (params) => {
              const stagedAt = Date.now();
              console.log('[InterpreterOverlay] [FAST_PATH] batch-staged', {
                iso: new Date(stagedAt).toISOString(),
                actionCount: params.actions.length,
                sessionId: session.id,
                submitToStagedMs: stagedAt - loopStartedAt,
                actionsJson: JSON.stringify(params.actions).slice(0, 12000),
              });
              const batchOutcome = await overlaySessionManager.computerBatch(session.agentId, params);
              const touchedWindowDiffText = formatTouchedWindowDiff(batchOutcome.touchedWindowDiff);
              console.log('[InterpreterOverlay] [FAST_PATH] batch-diff', {
                iso: new Date().toISOString(),
                changed: batchOutcome.touchedWindowDiff.changed,
                windowCount: batchOutcome.touchedWindowDiff.windows.length,
                diff: touchedWindowDiffText.slice(0, 12000),
              });
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    status: 'completed_after_review',
                    actionCount: params.actions.length,
                    outputPreview: formatOverlaySelectedTargetBatchResult(batchOutcome.result).slice(0, 4000),
                    touched_window_diff: touchedWindowDiffText,
                  }),
                }],
              };
            },
          });
          try {
            const parsedOutput = JSON.parse(output) as { status?: unknown };
            if (parsedOutput.status !== 'completed') {
              console.warn('[InterpreterOverlay] [FAST_PATH] batch-output', {
                iso: new Date().toISOString(),
                status: parsedOutput.status,
                output: output.slice(0, 4000),
              });
            }
          } catch {
            console.warn('[InterpreterOverlay] [FAST_PATH] batch-output unparsable', {
              iso: new Date().toISOString(),
              output: output.slice(0, 4000),
            });
          }
          return output;
        },
        executeCallHiddenAgent: async (argumentsJson) => {
          const parsed = JSON.parse(argumentsJson || '{}') as {
            message?: unknown;
            system?: unknown;
            timeout_ms?: unknown;
          };
          const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
          if (!message) {
            throw new Error('call_hidden_agent requires a message.');
          }
          // A delegated agent must not inherit a dead committed target
          // silently: no dispatch, the tool result carries the observation
          // and the controller model decides the outcome.
          const closedMessage = await committedTargetWindowClosedMessage(options.targetContext);
          if (closedMessage) {
            console.warn('[InterpreterOverlay] [FAST_PATH] dead-target-observation', {
              at: 'call_hidden_agent',
              message: closedMessage,
            });
            return JSON.stringify({ status: 'target_window_closed', message: closedMessage });
          }
          const hiddenProfile = await this.resolveHiddenAgentProfile();
          // The hidden agent queries the live selected overlay context and
          // stages its own reviewed screen actions over its normal CLI tool
          // surface, so the live overlay session must exist before dispatch.
          // The voice transport does the same via
          // ensureAdvancedVoiceOverlayToolSession.
          const session = await ensureFastPathSession();
          const dispatchedAt = Date.now();
          console.log('[InterpreterOverlay] [FAST_PATH] hidden-agent-dispatch', {
            iso: new Date(dispatchedAt).toISOString(),
            submitToDispatchMs: dispatchedAt - loopStartedAt,
            messageChars: message.length,
            message: message.slice(0, 2000),
          });
          const hiddenResult = await callHiddenAgentTool.handler({
            message: [
              buildReferenceContextPrompt(options.contextItems, message),
              OVERLAY_HIDDEN_AGENT_REPORT_CONTRACT,
            ].join('\n\n'),
            ...(typeof parsed.system === 'string' ? { system: parsed.system } : {}),
            ...(typeof parsed.timeout_ms === 'number' ? { timeout_ms: parsed.timeout_ms } : {}),
            ...buildOverlaySelectedContextToolArgs(options.targetContext, options.contextItems),
          }, buildOverlayBuiltinToolIdentity({
            agentId: session.agentId,
            workspacePath: options.workspacePath,
            modelConfig: profileToModelConfig(hiddenProfile, {
              reasoningEffort: hiddenProfile.reasoningEffort,
            }),
          }));
          // The hidden agent is awaited, so its completion report-back enters
          // the loop conversation as this tool result - the typed mirror of
          // the voice path's delegated completion notice. Keep the last
          // user-visible text for read_agent_assistant_messages check-ins.
          const output = hiddenResult.content[0]?.text ?? '';
          console.log('[InterpreterOverlay] [FAST_PATH] hidden-agent-report', {
            iso: new Date().toISOString(),
            durationMs: Date.now() - dispatchedAt,
            isError: hiddenResult.isError === true,
            outputChars: output.length,
            output: output.slice(0, 4000),
          });
          try {
            const hiddenPayload = JSON.parse(output) as { assistant_text?: unknown };
            if (typeof hiddenPayload.assistant_text === 'string' && hiddenPayload.assistant_text.trim()) {
              lastDelegatedAssistantText = hiddenPayload.assistant_text.trim();
            }
          } catch {
            // Non-JSON hidden-agent output (e.g. a thrown-error message) has
            // no user-visible assistant text to record.
          }
          return appendOverlayHiddenAgentReportInstruction(output);
        },
        executeQueryAttachments: async (argumentsJson) => {
          // Mirror the voice bridge: attachment query failures return an
          // Error: line into the conversation instead of aborting the loop.
          try {
            return await queryOverlayAttachments(options.contextItems, argumentsJson);
          } catch (error) {
            return `Error: ${getErrorMessage(error)}`;
          }
        },
        executeReadAgentAssistantMessages: async () => (
          lastDelegatedAssistantText ?? 'No user-visible result is ready yet.'
        ),
        log: (event, fields) => {
          console.log(`[InterpreterOverlay] [FAST_PATH] ${event}`, {
            iso: new Date().toISOString(),
            ...fields,
          });
        },
      });
    } catch (error) {
      // Execution began and then genuinely failed: surface loudly, never
      // silently fall back to the agent path.
      const message = getErrorMessage(error);
      console.error('[InterpreterOverlay] [FAST_PATH] execution failed:', error);
      this.trackOverlayError('overlay_fast_path_failed', message, {});
      releaseFastPathSession();
      this.runStartedAt = null;
      this.lastRunInputMethod = null;
      this.finishDebugRun(
        'failed',
        message,
        error instanceof OverlayTargetWindowClosedError ? 'target_window_closed' : 'fast_path_failed',
      );
      await this.showInputMode(false);
      this.send({
        pill: { kind: 'error', message },
      });
      return { handled: true, handoffSummary: null };
    }

    if (result.kind === 'handoff') {
      console.log(`[InterpreterOverlay] [FAST_PATH] handoff to agent: ${result.reason}`, {
        iso: new Date().toISOString(),
        laps: result.laps,
        executedBatchCount: result.executedBatchCount,
        totalMs: Date.now() - loopStartedAt,
      });
      releaseFastPathSession();
      return {
        handled: false,
        handoffSummary: result.conversationSummary || null,
      };
    }

    const doneAt = Date.now();
    console.log('[InterpreterOverlay] [FAST_PATH] loop-done', {
      iso: new Date(doneAt).toISOString(),
      laps: result.laps,
      executedBatchCount: result.executedBatchCount,
      delegatedToHiddenAgent: result.delegatedToHiddenAgent,
      targetWindowClosedObserved: result.targetWindowClosedObserved,
      totalMs: doneAt - loopStartedAt,
    });
    appendOverlayTranscriptDebugEvent({
      kind: 'tool.result',
      turn: 0,
      payload: { source: 'overlay_fast_path', tool: 'computer_batch', summary: result.summary },
    });
    this.runStartedAt = null;
    this.lastRunInputMethod = null;
    this.finishDebugRun('completed', result.summary, 'fast_path_completed');
    if (result.targetWindowClosedObserved) {
      // The model received the dead-target observation and decided the
      // outcome in text. Nothing visible happened on screen, so that text is
      // the run's user-visible result: hold it in a message pill, then tear
      // down to idle through the normal completion path.
      console.log('[InterpreterOverlay] [FAST_PATH] dead-target model decision shown', {
        iso: new Date().toISOString(),
        message: result.summary.slice(0, 1200),
      });
      this.send({
        mode: 'working',
        action: null,
        ghosts: [],
        pill: { kind: 'message', message: result.summary },
      });
      const runId = this.debugRunState.id;
      const sessionToDetach = fastPathSession;
      setTimeout(() => {
        if (this.debugRunState.id !== runId || this.debugRunState.status === 'running') {
          return;
        }
        void (async () => {
          if (sessionToDetach) {
            await this.detachAttachedToolSession(sessionToDetach, 'agent_complete');
          } else {
            this.send({ ...DEFAULT_OVERLAY_STATE });
          }
        })().catch((error) => {
          console.error('[InterpreterOverlay] [FAST_PATH] dead-target message teardown failed:', error);
        });
      }, OVERLAY_FAST_PATH_MESSAGE_HOLD_MS);
      return { handled: true, handoffSummary: null };
    }
    if (fastPathSession) {
      await this.detachAttachedToolSession(fastPathSession, 'agent_complete');
    } else {
      this.send({ ...DEFAULT_OVERLAY_STATE });
    }
    return { handled: true, handoffSummary: null };
  }

  // -- World overlay pinning ----------------------------------------------
  //
  // When the user click-drags to define a scope, identify the OS window under
  // the scope center, pin the world BrowserWindow above it via the native
  // addon, and start tracking that window's bounds. As the user drags the
  // target window around the screen, the world renderer's coordinates shift
  // by the same delta so the markers/pill/sheen stay glued to the field the
  // user originally pointed at.

  private async beginPinningWorldOverlayToTarget(): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    if (!this.scopeBounds || !this.interactionDisplay) return;

    const centerX = this.scopeBounds.x + this.scopeBounds.width / 2;
    const centerY = this.scopeBounds.y + this.scopeBounds.height / 2;
    console.log('[InterpreterOverlay] beginPinningWorldOverlayToTarget', {
      scopeBounds: this.scopeBounds,
      center: { x: centerX, y: centerY },
      displayBoundsDIP: this.interactionDisplay.boundsDIP,
    });
    const target = await windowAtPoint(centerX, centerY);
    if (!target) {
      console.log('[InterpreterOverlay] no target window under scope; skipping world pin', {
        centerX,
        centerY,
      });
      return;
    }

    console.log('[InterpreterOverlay] pinning world overlay to target', {
      pid: target.pid,
      cgWindowId: target.cgWindowId,
      owner: target.ownerName,
      title: target.title,
      bounds: target.bounds,
    });

    // Snapshot the absolute bounds of scope and any in-flight action so we can
    // re-derive their world position on each target-window movement.
    const initialActionMap = new Map<string, Bounds>();
    if (this.overlayState.action?.bounds) {
      initialActionMap.set(this.overlayState.action.id, { ...this.overlayState.action.bounds });
    }
    for (const ghost of this.overlayState.ghosts) {
      initialActionMap.set(ghost.id, { ...ghost.bounds });
    }

    this.pinnedTarget = {
      pid: target.pid,
      cgWindowId: target.cgWindowId,
      initialWindowBounds: { ...target.bounds },
      initialScopeAbsolute: { ...this.scopeBounds },
      initialActionBoundsAbsolute: initialActionMap,
      initialVisualProbeAbsolute: this.overlayState.debugVisualProbe
        ? toAbsoluteBounds(this.overlayState.debugVisualProbe.bounds, this.interactionDisplay.boundsDIP)
        : null,
    };
    this.worldTargetBounds = toLocalBounds(target.bounds, this.interactionDisplay.boundsDIP);

    this.overlay.setWorldTargetMovedListener((bounds) => this.handleTargetWindowMoved(bounds));
    const pinned = this.overlay.pinWorldTo({
      pid: target.pid,
      cgWindowId: target.cgWindowId,
      ownerName: target.ownerName,
      title: target.title,
      initialBounds: target.bounds,
      initialOverlayBounds: target.bounds,
    });
    if (!pinned) {
      this.pinnedTarget = null;
      this.overlay.setWorldTargetMovedListener(null);
      console.warn('[InterpreterOverlay] world overlay pin failed; keeping chrome spatial layers active');
      return;
    }
    this.send({ worldPinActive: true, worldTargetBounds: this.worldTargetBounds });
    const ready = await this.waitForPinnedWorldOverlayReady();
    if (!ready) {
      console.warn('[InterpreterOverlay] pinned world overlay did not become visually ready; keeping chrome spatial layers active');
      this.overlay.setWorldTargetMovedListener(null);
      this.overlay.unpinWorld();
      this.pinnedTarget = null;
      this.worldTargetBounds = null;
      this.send({ worldPinActive: false, worldTargetBounds: null });
    }
  }

  private async waitForPinnedWorldOverlayReady(timeoutMs = 1200): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const health = this.lastWorldOverlayVisualHealth;
      if (
        health?.hasRenderedDom
        && health.hasVisibleAffordance
        && Date.now() - health.timestamp < 500
      ) {
        return true;
      }
      await wait(50);
    }
    return false;
  }

  private endPinningWorldOverlay(fadeMs = 0): void {
    if (!this.pinnedTarget) return;
    console.log('[InterpreterOverlay] unpinning world overlay');
    this.overlay.setWorldTargetMovedListener(null);
    this.overlay.unpinWorld(fadeMs);

    const finalize = () => {
      this.worldOverlayFinalizeTimer = null;
      this.pinnedTarget = null;
      this.worldTargetBounds = null;
      this.send({
        mode: 'idle',
        action: null,
        ghosts: [],
        pill: { kind: 'hidden' },
        ctrlPressed: false,
        shiftPressed: false,
        worldPinActive: false,
        worldTargetBounds: null,
        worldPinClosing: false,
        scopeBounds: null,
        draftScopeBounds: null,
        selectableElements: [],
      });
    };

    if (fadeMs > 0) {
      if (this.worldOverlayFinalizeTimer) {
        clearTimeout(this.worldOverlayFinalizeTimer);
      }
      this.worldOverlayFinalizeTimer = setTimeout(finalize, fadeMs);
    } else {
      finalize();
    }
  }

  private handleTargetWindowMoved(bounds: WindowInfo['bounds'] | null): void {
    if (!this.pinnedTarget || !this.interactionDisplay) return;
    if (!bounds) {
      console.warn('[InterpreterOverlay] pinned target bounds unavailable; keeping previous world overlay bounds');
      return;
    }
    if (!this.scopeBounds) return;
    const dx = bounds.x - this.pinnedTarget.initialWindowBounds.x;
    const dy = bounds.y - this.pinnedTarget.initialWindowBounds.y;
    const previousScopeDx = this.scopeBounds.x - this.pinnedTarget.initialScopeAbsolute.x;
    const previousScopeDy = this.scopeBounds.y - this.pinnedTarget.initialScopeAbsolute.y;

    const shiftedScopeAbsolute: Bounds = {
      x: this.pinnedTarget.initialScopeAbsolute.x + dx,
      y: this.pinnedTarget.initialScopeAbsolute.y + dy,
      width: this.pinnedTarget.initialScopeAbsolute.width,
      height: this.pinnedTarget.initialScopeAbsolute.height,
    };
    this.scopeBounds = shiftedScopeAbsolute;
    if (this.activeAttachedSessionId) {
      try {
        const session = overlaySessionManager.getSessionForAgent(this.activeAttachedAgentId ?? undefined);
        if (session.id === this.activeAttachedSessionId) {
          session.scopeBoundsDIP = { ...shiftedScopeAbsolute };
        }
      } catch {
        // The pinned overlay can outlive the attached session during shutdown.
      }
    }
    const localScope = toLocalBounds(shiftedScopeAbsolute, this.interactionDisplay.boundsDIP);
    this.worldTargetBounds = toLocalBounds(bounds, this.interactionDisplay.boundsDIP);

    // Shift action and ghost bounds by the same delta so attached pills and
    // markers stay glued to the field the agent originally targeted.
    const partial: Partial<OverlayState> = {
      scopeBounds: localScope,
      worldTargetBounds: this.worldTargetBounds,
    };

    const getInitialActionBounds = (action: ReviewAction): Bounds => {
      const cached = this.pinnedTarget!.initialActionBoundsAbsolute.get(action.id);
      if (cached) {
        return cached;
      }

      const initial: Bounds = {
        x: action.bounds.x - previousScopeDx,
        y: action.bounds.y - previousScopeDy,
        width: action.bounds.width,
        height: action.bounds.height,
      };
      this.pinnedTarget!.initialActionBoundsAbsolute.set(action.id, initial);
      return initial;
    };

    if (this.overlayState.action?.bounds) {
      const initial = getInitialActionBounds(this.overlayState.action);
      partial.action = {
        ...this.overlayState.action,
        bounds: {
          x: initial.x + dx,
          y: initial.y + dy,
          width: initial.width,
          height: initial.height,
        },
      };
    }

    if (this.overlayState.ghosts.length > 0) {
      partial.ghosts = this.overlayState.ghosts.map((ghost) => {
        const initial = getInitialActionBounds(ghost);
        return {
          ...ghost,
          bounds: {
            x: initial.x + dx,
            y: initial.y + dy,
            width: initial.width,
            height: initial.height,
          },
        };
      });
    }

    if (this.overlayState.debugVisualProbe && this.pinnedTarget.initialVisualProbeAbsolute) {
      partial.debugVisualProbe = {
        ...this.overlayState.debugVisualProbe,
        bounds: toLocalBounds({
          x: this.pinnedTarget.initialVisualProbeAbsolute.x + dx,
          y: this.pinnedTarget.initialVisualProbeAbsolute.y + dy,
          width: this.pinnedTarget.initialVisualProbeAbsolute.width,
          height: this.pinnedTarget.initialVisualProbeAbsolute.height,
        }, this.interactionDisplay.boundsDIP),
      };
    }

    this.send(partial);
  }
}
