import { beforeEach, describe, expect, mock, test } from 'bun:test';

const trackMock = mock(() => Promise.resolve(undefined));
const trackErrorMock = mock(() => Promise.resolve(undefined));

mock.module('@/ipc', () => ({
  telemetry: {
    track: trackMock,
    trackError: trackErrorMock,
  },
}));

const telemetryModule = await import('./telemetry');
const { __resetTelemetryContextForTests, setCurrentScreen, setActiveProfile } = await import('./telemetryContext');

// Every emitted event should carry these enrichment fields merged with the
// event-specific payload, so tests use objectContaining to assert only the
// event-specific shape without hand-listing enrichment on each case.
const ENRICHMENT_KEYS = [
  'currentScreen',
  'previousScreen',
  'screenIndex',
  'lastUserActionEvent',
  'lastUserActionMsAgo',
  'sessionDurationMs',
  'activeProfileId',
  'activeModel',
  'activeProvider',
] as const;

function trackArgs(index = 0) {
  const call = trackMock.mock.calls[index] as [string, Record<string, unknown>, unknown] | undefined;
  if (!call) throw new Error(`No track call at index ${index}`);
  return { event: call[0], payload: call[1], tag: call[2] };
}

function trackErrorArgs(index = 0) {
  const call = trackErrorMock.mock.calls[index] as [string, string, Record<string, unknown>] | undefined;
  if (!call) throw new Error(`No trackError call at index ${index}`);
  return { errorType: call[0], error: call[1], context: call[2] };
}

function expectEnrichmentOn(payload: Record<string, unknown>) {
  for (const key of ENRICHMENT_KEYS) {
    expect(payload).toHaveProperty(key);
  }
}

describe('telemetry helpers', () => {
  beforeEach(() => {
    trackMock.mockClear();
    trackErrorMock.mockClear();
    __resetTelemetryContextForTests();
  });

  test('track attaches enrichment to every event', () => {
    telemetryModule.trackNewChat();
    const { event, payload } = trackArgs();
    expect(event).toBe('new_chat_created');
    expectEnrichmentOn(payload);
  });

  test('trackError attaches enrichment to the error context', () => {
    telemetryModule.trackInboxSetupFailed({
      channel: 'whatsapp',
      error: 'Connection lost',
      stage: 'sse_closed',
    });
    const { errorType, error, context } = trackErrorArgs();
    expect(errorType).toBe('inbox_setup_failed');
    expect(error).toBe('Connection lost');
    expect(context).toMatchObject({ channel: 'whatsapp', stage: 'sse_closed' });
    expectEnrichmentOn(context);
  });

  test('enrichment reflects the current screen + active profile when they are set', () => {
    setCurrentScreen('settings.models');
    setActiveProfile({ profileId: 'p1', model: 'm1', provider: 'hosted' });

    telemetryModule.trackNewChat();
    const { payload } = trackArgs();
    expect(payload.currentScreen).toBe('settings.models');
    expect(payload.activeProfileId).toBe('p1');
    expect(payload.activeModel).toBe('m1');
    expect(payload.activeProvider).toBe('hosted');
  });

  test('user actions update lastUserActionEvent but passive events do not', () => {
    telemetryModule.trackNewChat();
    telemetryModule.trackFeatureDuration({ feature: 'voice_mode', durationMs: 1000 });
    // 2nd call is the passive feature_duration event — its enrichment should
    // still show 'new_chat_created' as the most recent user action.
    const { payload } = trackArgs(1);
    expect(payload.lastUserActionEvent).toBe('new_chat_created');
  });

  test('tracks inbox search events', () => {
    telemetryModule.trackInboxSearch({
      queryLength: 12,
      channelFilter: 'whatsapp',
      resultCount: 4,
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('inbox_search');
    expect(payload).toMatchObject({ queryLength: 12, channelFilter: 'whatsapp', resultCount: 4 });
  });

  test('tracks sidebar visibility events', () => {
    telemetryModule.trackSidebarVisibilityChanged({
      sidebar: 'right',
      isOpen: true,
      tab: 'chat',
      hasPinnedAgent: true,
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('sidebar_visibility_changed');
    expect(payload).toMatchObject({ sidebar: 'right', isOpen: true, tab: 'chat', hasPinnedAgent: true });
  });

  test('tracks onboarding failures with the exact error message', () => {
    telemetryModule.trackOnboardingError({
      step: 'model_setup',
      stage: 'initiate_oauth',
      error: new Error('unsupported_country_region_territory'),
      displayMessage: 'Failed to connect.',
      context: { provider: 'openai' },
    });
    const { errorType, error, context } = trackErrorArgs();
    expect(errorType).toBe('onboarding_error');
    expect(error).toBe('unsupported_country_region_territory');
    expect(context).toMatchObject({
      step: 'model_setup',
      stage: 'initiate_oauth',
      displayMessage: 'Failed to connect.',
      provider: 'openai',
    });
  });

  test('tracks OAuth sign-in lifecycle', () => {
    telemetryModule.trackOAuthSignInStarted({
      provider: 'openai', surface: 'onboarding', flowId: 'openai-123', autoAddPack: true,
    });
    telemetryModule.trackOAuthSignInCompleted({
      provider: 'openai', surface: 'settings', flowId: 'openai-456', hasEmail: true,
    });

    expect(trackArgs(0).event).toBe('oauth_signin_started');
    expect(trackArgs(0).payload).toMatchObject({ provider: 'openai', flowId: 'openai-123', autoAddPack: true });
    expect(trackArgs(1).event).toBe('oauth_signin_completed');
    expect(trackArgs(1).payload).toMatchObject({ provider: 'openai', flowId: 'openai-456', hasEmail: true });
  });

  test('tracks OAuth sign-in failures', () => {
    telemetryModule.trackOAuthSignInFailed({
      provider: 'openai', surface: 'onboarding', flowId: 'openai-789',
      error: 'OAuth callback failed', stage: 'poll',
    });
    const { errorType, error, context } = trackErrorArgs();
    expect(errorType).toBe('oauth_signin_failed');
    expect(error).toBe('OAuth callback failed');
    expect(context).toMatchObject({ provider: 'openai', flowId: 'openai-789', stage: 'poll' });
  });

  test('tracks message-sent with suggestion-chip metadata', () => {
    telemetryModule.trackMessageSent({
      messageLength: 42,
      hasAttachments: false,
      attachmentCount: 0,
      isFirstMessage: false,
      profileId: 'interpreter',
      model: 'interpreter-smart',
      messageSource: {
        type: 'suggestion_chip',
        chipId: 'settings-explain',
        chipTitle: 'Explain my settings',
        chipContent: 'Explain what my current settings do.',
      },
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('message_sent');
    expect(payload).toMatchObject({
      messageSource: 'suggestion_chip',
      sourceChipId: 'settings-explain',
      sourceChipTitle: 'Explain my settings',
      sourceChipContent: 'Explain what my current settings do.',
    });
  });

  // --- New helpers ---

  test('trackScreenViewed', () => {
    telemetryModule.trackScreenViewed({
      screen: 'settings.models',
      fromScreen: 'home',
      previousDurationMs: 1234,
      screenIndex: 2,
      tabType: 'settings',
      settingsSection: 'models',
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('screen_viewed');
    expect(payload).toMatchObject({ screen: 'settings.models', fromScreen: 'home', previousDurationMs: 1234 });
  });

  test('trackFeatureDuration flattens extra into the payload', () => {
    telemetryModule.trackFeatureDuration({
      feature: 'file_preview',
      durationMs: 8000,
      spanId: 'span-1',
      extra: { ext: 'xlsx' },
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('feature_duration');
    expect(payload).toMatchObject({ feature: 'file_preview', durationMs: 8000, spanId: 'span-1', ext: 'xlsx' });
  });

  test('trackSettingsSectionOpened/Closed', () => {
    telemetryModule.trackSettingsSectionOpened({ tabId: 'models', sectionId: 'models', source: 'initial' });
    telemetryModule.trackSettingsSectionClosed({ tabId: 'models', durationMs: 5000 });
    expect(trackArgs(0).event).toBe('settings_section_opened');
    expect(trackArgs(0).payload).toMatchObject({ tabId: 'models', source: 'initial' });
    expect(trackArgs(1).event).toBe('settings_section_closed');
    expect(trackArgs(1).payload).toMatchObject({ tabId: 'models', durationMs: 5000 });
  });

  test('trackSettingChanged', () => {
    telemetryModule.trackSettingChanged({
      settingKey: 'tts.voice',
      tabId: 'textToSpeech',
      sectionId: 'textToSpeech',
      valueType: 'number',
      oldValue: 1,
      newValue: 2,
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('setting_changed');
    expect(payload).toMatchObject({ settingKey: 'tts.voice', valueType: 'number', oldValue: 1, newValue: 2 });
  });

  test('trackAgentTurnCompleted', () => {
    telemetryModule.trackAgentTurnCompleted({
      reason: 'natural_stop',
      durationMs: 1200,
      timeToFirstTokenMs: 400,
      toolCallCount: 2,
      toolFailCount: 0,
      profileId: 'p1',
      model: 'm1',
      isFirstResponse: false,
      threadId: 't1',
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('agent_turn_completed');
    expect(payload).toMatchObject({ reason: 'natural_stop', durationMs: 1200, toolCallCount: 2, threadId: 't1' });
  });

  test('trackToolCalled and trackToolFailed', () => {
    telemetryModule.trackToolCalled({ toolName: 'fs.read', serverId: 'builtin-fs', callId: 'c1' });
    telemetryModule.trackToolFailed({
      toolName: 'fs.read', serverId: 'builtin-fs', callId: 'c1',
      error: 'ENOENT', errorKind: 'filesystem', durationMs: 12,
    });
    expect(trackArgs(0).event).toBe('tool_called');
    expect(trackArgs(0).payload).toMatchObject({ toolName: 'fs.read', serverId: 'builtin-fs', callId: 'c1' });
    const err = trackErrorArgs(0);
    expect(err.errorType).toBe('tool_failed');
    expect(err.error).toBe('ENOENT');
    expect(err.context).toMatchObject({ toolName: 'fs.read', errorKind: 'filesystem', durationMs: 12 });
  });

  test('trackModelSwitched', () => {
    telemetryModule.trackModelSwitched({
      fromProfileId: 'p1', toProfileId: 'p2', fromModel: 'm1', toModel: 'm2', surface: 'composer',
    });
    const { event, payload } = trackArgs();
    expect(event).toBe('model_switched');
    expect(payload).toMatchObject({ fromProfileId: 'p1', toProfileId: 'p2', surface: 'composer' });
  });

  test('trackApprovalShown/Resolved', () => {
    telemetryModule.trackApprovalShown({ approvalId: 'a1', toolName: 'shell.exec', kind: 'simple' });
    telemetryModule.trackApprovalResolved({
      approvalId: 'a1', toolName: 'shell.exec', action: 'approve_once', durationMs: 2500,
    });
    expect(trackArgs(0).event).toBe('approval_shown');
    expect(trackArgs(1).event).toBe('approval_resolved');
    expect(trackArgs(1).payload).toMatchObject({ action: 'approve_once', durationMs: 2500 });
  });

  test('trackShortcutInvoked and trackContextMenuAction', () => {
    telemetryModule.trackShortcutInvoked({ shortcut: 'cmd+k', action: 'command_palette', source: 'global' });
    telemetryModule.trackContextMenuAction({ menu: 'file_tree', action: 'rename', targetKind: 'folder' });
    expect(trackArgs(0).event).toBe('shortcut_invoked');
    expect(trackArgs(0).payload).toMatchObject({ shortcut: 'cmd+k', action: 'command_palette' });
    expect(trackArgs(1).event).toBe('context_menu_action');
    expect(trackArgs(1).payload).toMatchObject({ menu: 'file_tree', action: 'rename' });
  });

  test('trackSkillInstalled and trackSkillInstallFailed', () => {
    telemetryModule.trackSkillInstalled({ skillId: 'pdf-filler', source: 'store' });
    telemetryModule.trackSkillInstallFailed({
      skillId: 'pdf-filler', source: 'store', error: 'network', stage: 'download',
    });
    expect(trackArgs(0).event).toBe('skill_installed');
    const err = trackErrorArgs(0);
    expect(err.errorType).toBe('skill_install_failed');
    expect(err.error).toBe('network');
    expect(err.context).toMatchObject({ skillId: 'pdf-filler', source: 'store', stage: 'download' });
  });

  test('trackUpdatePrompted and trackUpdateAccepted', () => {
    telemetryModule.trackUpdatePrompted({ version: '0.2.137', surface: 'dialog' });
    telemetryModule.trackUpdateAccepted({ version: '0.2.137', action: 'install_now' });
    expect(trackArgs(0).event).toBe('update_prompted');
    expect(trackArgs(1).event).toBe('update_accepted');
    expect(trackArgs(1).payload).toMatchObject({ version: '0.2.137', action: 'install_now' });
  });
});
