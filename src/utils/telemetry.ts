/**
 * Frontend telemetry helpers.
 *
 * Thin wrapper around the IPC telemetry.track() call.
 * All calls respect the user's telemetryEnabled setting — the server-side
 * sendTelemetry() early-returns when telemetry is disabled.
 */

import { telemetry } from '@/ipc';
import type { MessageSendSource } from '../../shared/types/messageSendSource';
import { getEnrichment, noteUserAction } from './telemetryContext';

// Events that are passive/ambient (not triggered by user action) — they still
// get enriched with screen context but don't count as a "last user action" so
// error telemetry can still point at the real thing the user did last.
const PASSIVE_EVENTS = new Set([
  'screen_viewed',
  'feature_duration',
  'settings_section_closed',
  'split_view_observed',
  'response_received',
  'agent_turn_completed',
  'approval_shown',
  'update_prompted',
  'tool_called',
  'tool_failed',
]);

function track(event: string, data?: Record<string, unknown>) {
  try {
    const enriched = { ...getEnrichment(), ...(data ?? {}) };
    if (!PASSIVE_EVENTS.has(event)) {
      noteUserAction(event);
    }
    void telemetry.track(event, enriched, undefined).catch(() => {});
  } catch {
    // never crash the app for telemetry
  }
}

function trackError(errorType: string, error: string, context?: Record<string, unknown>) {
  try {
    // Error events carry enrichment so we know WHERE and WHEN the error hit
    // without every call site needing to pass it.
    const enriched = { ...getEnrichment(), ...(context ?? {}) };
    void telemetry.trackError(errorType, error, enriched).catch(() => {});
  } catch {
    // never crash the app for telemetry
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error == null) {
    return 'Unknown error';
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') {
      return serialized;
    }
  } catch {
    // Fall through to String(error).
  }

  return String(error);
}

export type OAuthTelemetryProvider = 'openai' | 'claude';
export type OAuthTelemetrySurface = 'onboarding' | 'settings';

export function trackOAuthSignInStarted(meta: {
  provider: OAuthTelemetryProvider;
  surface: OAuthTelemetrySurface;
  flowId: string;
  autoAddPack?: boolean;
}) {
  track('oauth_signin_started', meta);
}

export function trackOAuthSignInCompleted(meta: {
  provider: OAuthTelemetryProvider;
  surface: OAuthTelemetrySurface;
  flowId: string;
  hasEmail: boolean;
}) {
  track('oauth_signin_completed', meta);
}

export function trackOAuthSignInFailed(meta: {
  provider: OAuthTelemetryProvider;
  surface: OAuthTelemetrySurface;
  flowId?: string;
  error: unknown;
  stage?: string;
}) {
  trackError('oauth_signin_failed', normalizeErrorMessage(meta.error), {
    provider: meta.provider,
    surface: meta.surface,
    flowId: meta.flowId,
    stage: meta.stage,
  });
}

export function trackOAuthModelListFailed(meta: {
  provider: OAuthTelemetryProvider;
  surface: OAuthTelemetrySurface;
  flowId?: string;
  stage: string;
  errorKind: string;
  error: unknown;
}) {
  trackError('oauth_model_list_failed', normalizeErrorMessage(meta.error), {
    provider: meta.provider,
    surface: meta.surface,
    flowId: meta.flowId,
    stage: meta.stage,
    errorKind: meta.errorKind,
  });
}

// -- Chat flow --

export function trackMessageSent(meta: {
  messageLength: number;
  hasAttachments: boolean;
  attachmentCount: number;
  isFirstMessage: boolean;
  profileId: string;
  model?: string;
  messageSource?: MessageSendSource | null;
}) {
  const { messageSource, ...rest } = meta;
  track('message_sent', {
    ...rest,
    ...(messageSource
      ? {
          messageSource: messageSource.type,
          sourceChipId: messageSource.chipId,
          sourceChipTitle: messageSource.chipTitle,
          sourceChipContent: messageSource.chipContent,
        }
      : {}),
  });
}

export function trackResponseReceived(meta: {
  durationMs: number;
  timeToFirstTokenMs?: number;
  toolCallCount: number;
  hadError: boolean;
  isFirstResponse: boolean;
  profileId?: string;
  model?: string;
}) {
  track('response_received', meta);
}

let hasTrackedActivation = false;
export function trackFirstSuccessfulInteraction() {
  if (hasTrackedActivation) return;
  hasTrackedActivation = true;
  track('first_successful_interaction');
}

export function trackResponseError(meta: {
  error: string;
  isFirstMessage: boolean;
  profileId?: string;
  model?: string;
  httpStatus?: number;
}) {
  trackError('response_error', meta.error, {
    isFirstMessage: meta.isFirstMessage,
    profileId: meta.profileId,
    model: meta.model,
    httpStatus: meta.httpStatus,
  });
}

// -- Onboarding provider/model --

export function trackProviderSelected(meta: {
  packId: string;
  wasDetected: boolean;
  step: string;
}) {
  track('provider_selected', meta);
}

export function trackModelsConfigured(meta: {
  packId: string;
  profileCount: number;
  defaultProfileId?: string;
  hasApiKey: boolean;
}) {
  track('models_configured', meta);
}

export function trackResponseStopped() {
  track('response_stopped');
}

// -- Auth --

export function trackSignIn() {
  track('signed_in');
}

export function trackSignOut() {
  track('signed_out');
}

// -- Navigation / engagement --

export function trackNewChat() {
  track('new_chat_created');
}

export function trackSettingsOpened(section?: string) {
  track('settings_opened', { section });
}

export function trackModelChanged(meta: { profileId: string; model?: string }) {
  track('model_changed', meta);
}

export function trackImageAttached(count: number) {
  track('image_attached', { count });
}

export function trackAgentPinned() {
  track('agent_pinned');
}

export function trackAgentReset() {
  track('agent_reset');
}

export function trackAgentUnpinned() {
  track('agent_unpinned');
}

export function trackSidebarVisibilityChanged(meta: {
  sidebar: 'left' | 'right';
  isOpen: boolean;
  tab?: string;
  hasPinnedAgent?: boolean;
}) {
  track('sidebar_visibility_changed', meta);
}

export function trackSidebarTabChanged(meta: {
  sidebar: 'left' | 'right';
  tab: string;
}) {
  track('sidebar_tab_changed', meta);
}

export function trackSplitViewObserved(meta: {
  source: 'initial' | 'layout_changed';
  hasSplitView: boolean;
  paneCount: number;
  splitCount: number;
  horizontalSplitCount: number;
  verticalSplitCount: number;
  maxSplitDepth: number;
  rootDirection: 'horizontal' | 'vertical' | 'none';
}) {
  track('split_view_observed', meta);
}

export function trackOverlaySettingChanged(meta: {
  setting: 'enabled' | 'hotkey';
  value?: boolean;
}) {
  track('overlay_setting_changed', meta);
}

export function trackPinnedAgentCreated(meta: {
  source: string;
  hasInitialMessage: boolean;
  hasConversationId: boolean;
  hasThreadId: boolean;
  channel?: string;
}) {
  track('pinned_agent_created', meta);
}

export function trackPinnedAgentFileDropped(meta: {
  isDirectory: boolean;
}) {
  track('pinned_agent_file_dropped', meta);
}

// -- Inbox --

export function trackInboxSetupStarted(meta: {
  channel: string;
  entryPoint: string;
}) {
  track('inbox_setup_started', meta);
}

export function trackInboxSetupCompleted(meta: {
  channel: string;
}) {
  track('inbox_setup_completed', meta);
}

export function trackInboxSetupCancelled(meta: {
  channel: string;
}) {
  track('inbox_setup_cancelled', meta);
}

export function trackInboxSetupFailed(meta: {
  channel: string;
  error: string;
  stage?: string;
}) {
  trackError('inbox_setup_failed', meta.error, {
    channel: meta.channel,
    stage: meta.stage,
  });
}

export function trackInboxRefreshed(meta: {
  channelFilter: string;
  searchActive: boolean;
}) {
  track('inbox_refreshed', meta);
}

export function trackInboxFilterChanged(meta: {
  channelFilter: string;
}) {
  track('inbox_filter_changed', meta);
}

export function trackInboxSearch(meta: {
  queryLength: number;
  channelFilter: string;
  resultCount: number;
}) {
  track('inbox_search', meta);
}

export function trackInboxThreadOpened(meta: {
  channel: string;
  unread: boolean;
}) {
  track('inbox_thread_opened', meta);
}

export function trackInboxMessageSent(meta: {
  channel: string;
  messageLength: number;
}) {
  track('inbox_message_sent', meta);
}

export function trackInboxMessageSendFailed(meta: {
  channel: string;
  messageLength: number;
  error: string;
}) {
  trackError('inbox_message_send_failed', meta.error, {
    channel: meta.channel,
    messageLength: meta.messageLength,
  });
}

export function trackInboxLoadFailed(meta: {
  surface: 'rail' | 'thread';
  channel?: string;
  error: string;
}) {
  trackError('inbox_load_failed', meta.error, {
    surface: meta.surface,
    channel: meta.channel,
  });
}

// -- Voice --

export function trackVoiceModeStarted(
  mode: string,
  context?: { backend?: string; surface?: string },
) {
  track('voice_mode_started', { mode, ...context });
}

export function trackVoiceModeStopped(context?: {
  mode?: string;
  backend?: string;
  durationMs?: number;
  surface?: string;
}) {
  track('voice_mode_stopped', context ?? {});
}

export function trackVoiceModeChanged(
  mode: string,
  context?: { backend?: string; surface?: string },
) {
  track('voice_mode_changed', { mode, ...context });
}

export function trackSttBackendChanged(backend: string) {
  track('stt_backend_changed', { backend });
}

export function trackTtsModelChanged(meta: { family?: string; modelId?: string; size?: string }) {
  track('tts_model_changed', meta);
}

export function trackTtsVoiceChanged(voiceId: number) {
  track('tts_voice_changed', { voiceId });
}

// -- Files / documents --

// Basenames of files shipped in resources/sample-workspace/
const SAMPLE_FILE_BASENAMES = new Set([
  'Welcome.md',
  'Expense Tracker.xlsx',
  'receipt.jpg',
  'Client Intake Form.docx',
  'Vendor Information.docx',
  'Vendor Registration Form.pdf',
  'Research Notes.md',
  'The New Knowledge Worker.md',
  'Use Cases.md',
  'SKILL.md',
  'openai.yaml',
]);

function isSampleFile(filePath: string): boolean {
  const basename = filePath.split(/[/\\]/).pop() || '';
  return SAMPLE_FILE_BASENAMES.has(basename);
}

export function trackFileOpened(meta: { extension: string; fileType: string; filePath: string }) {
  const sample = isSampleFile(meta.filePath);
  track('file_opened', { extension: meta.extension, fileType: meta.fileType, isSampleFile: sample });
}

export function trackDocumentEdited(meta: { extension: string; fileType: string; filePath: string }) {
  const sample = isSampleFile(meta.filePath);
  track('document_edited', { extension: meta.extension, fileType: meta.fileType, isSampleFile: sample });
}

// -- Workspace --

export function trackWorkspaceChanged() {
  track('workspace_changed');
}

// -- Errors (mirrors to our table alongside Sentry) --

export function trackAppError(meta: { type: string; message: string; source?: string }) {
  trackError(meta.type, meta.message, { source: meta.source });
}

export function trackOnboardingError(meta: {
  step: string;
  stage: string;
  error: unknown;
  displayMessage?: string;
  context?: Record<string, unknown>;
}) {
  trackError('onboarding_error', normalizeErrorMessage(meta.error), {
    step: meta.step,
    stage: meta.stage,
    displayMessage: meta.displayMessage,
    ...meta.context,
  });
}

// -- Feedback --

export function trackFeedbackSubmitted(meta: { hasImages: boolean; includedLogs: boolean; messageLength: number }) {
  track('feedback_submitted', meta);
}

export function trackFeedbackOpened() {
  track('feedback_opened');
}

// -- Navigation / screens --

export function trackScreenViewed(meta: {
  screen: string;
  fromScreen: string | null;
  previousDurationMs: number;
  screenIndex: number;
  tabType?: string;
  settingsSection?: string;
}) {
  track('screen_viewed', meta);
}

export function trackFeatureDuration(meta: {
  feature: string;
  durationMs: number;
  spanId?: string;
  extra?: Record<string, unknown>;
}) {
  const { extra, ...rest } = meta;
  track('feature_duration', { ...rest, ...(extra ?? {}) });
}

// -- Settings --

export function trackSettingsSectionOpened(meta: {
  tabId: string;
  sectionId?: string;
  source?: string;
}) {
  track('settings_section_opened', meta);
}

export function trackSettingsSectionClosed(meta: {
  tabId: string;
  sectionId?: string;
  durationMs: number;
}) {
  track('settings_section_closed', meta);
}

export function trackSettingChanged(meta: {
  settingKey: string;
  tabId?: string;
  sectionId?: string;
  valueType: 'boolean' | 'string' | 'number' | 'enum' | 'object';
  oldValue?: unknown;
  newValue?: unknown;
}) {
  track('setting_changed', meta);
}

// -- Agent turn lifecycle --

export type AgentTurnEndReason =
  | 'natural_stop'
  | 'user_stopped'
  | 'error'
  | 'context_limit'
  | 'timeout'
  | 'unknown';

export function trackAgentTurnCompleted(meta: {
  reason: AgentTurnEndReason;
  durationMs: number;
  timeToFirstTokenMs?: number;
  toolCallCount: number;
  toolFailCount?: number;
  profileId?: string;
  model?: string;
  isFirstResponse: boolean;
  threadId?: string;
  errorMessage?: string;
  httpStatus?: number;
}) {
  track('agent_turn_completed', meta);
}

// -- Tool calls (from the agent loop) --

export function trackToolCalled(meta: {
  toolName: string;
  serverId?: string;
  callId?: string;
  threadId?: string;
  profileId?: string;
  model?: string;
}) {
  track('tool_called', meta);
}

export function trackToolFailed(meta: {
  toolName: string;
  serverId?: string;
  callId?: string;
  threadId?: string;
  profileId?: string;
  model?: string;
  error: string;
  errorKind?: string;
  durationMs?: number;
}) {
  trackError('tool_failed', meta.error, {
    toolName: meta.toolName,
    serverId: meta.serverId,
    callId: meta.callId,
    threadId: meta.threadId,
    profileId: meta.profileId,
    model: meta.model,
    errorKind: meta.errorKind,
    durationMs: meta.durationMs,
  });
}

export function trackToolCompleted(meta: {
  toolName: string;
  serverId?: string;
  callId?: string;
  threadId?: string;
  durationMs: number;
  // commandExecution that ran but exited non-zero — agent gets the output and
  // decides what to do. Tracked here (not as tool_failed) so the failure
  // metric reflects real tool breakage, not agent probing.
  nonZeroExit?: boolean;
  exitCode?: number;
  // User declined an approval — tool didn't run, but it didn't break either.
  declined?: boolean;
}) {
  track('tool_completed', meta);
}

// -- Model switches (within a session; separate from onboarding config) --

export function trackModelSwitched(meta: {
  fromProfileId?: string | null;
  toProfileId: string;
  fromModel?: string | null;
  toModel?: string;
  threadId?: string;
  surface: 'composer' | 'settings' | 'onboarding' | 'thread';
}) {
  track('model_switched', meta);
}

// -- Approvals --

export function trackApprovalShown(meta: {
  approvalId: string;
  toolName?: string;
  serverId?: string;
  kind: 'simple' | 'question';
}) {
  track('approval_shown', meta);
}

export function trackApprovalResolved(meta: {
  approvalId: string;
  toolName?: string;
  serverId?: string;
  action: 'approve_once' | 'approve_session' | 'deny' | 'question_answered';
  durationMs: number;
}) {
  track('approval_resolved', meta);
}

// -- Shortcuts / context menus --

export function trackShortcutInvoked(meta: {
  shortcut: string;
  action: string;
  source?: 'global' | 'window' | 'menu';
}) {
  track('shortcut_invoked', meta);
}

export function trackContextMenuAction(meta: {
  menu: string;
  action: string;
  targetKind?: string;
}) {
  track('context_menu_action', meta);
}

// -- Skills / MCP --

export function trackSkillInstalled(meta: {
  skillId: string;
  source: 'store' | 'discovered' | 'onboarding' | 'manual';
}) {
  track('skill_installed', meta);
}

export function trackSkillInstallFailed(meta: {
  skillId: string;
  source: 'store' | 'discovered' | 'onboarding' | 'manual';
  error: string;
  stage?: string;
}) {
  trackError('skill_install_failed', meta.error, {
    skillId: meta.skillId,
    source: meta.source,
    stage: meta.stage,
  });
}

// -- Auto-update --

export function trackUpdatePrompted(meta: {
  version: string;
  surface: 'dialog' | 'toast';
}) {
  track('update_prompted', meta);
}

export function trackUpdateAccepted(meta: {
  version: string;
  action: 'install_now' | 'install_on_quit' | 'dismissed';
}) {
  track('update_accepted', meta);
}
