import { describe, expect, test } from 'bun:test';

import { getOverlayUnavailableDialog, resolveEffectiveOverlaySettings } from './access';

const settings = {
  accountUserId: 'user_123',
  enabled: true,
  permissionSetupPending: false,
  hotkey: 'Control+Space',
  preferredWorkspacePath: null,
  preferredNoWorkspace: false,
  preferredProfileId: null,
  advancedVoiceEnabled: true,
  advancedVoiceWorkspacePath: null,
  advancedVoiceModel: 'interpreter-fast',
  hiddenAgentModel: 'interpreter-fast',
  readToolPromptInjectionGuard: {
    enabled: false,
    modelProfileId: null,
  },
};

describe('overlay access helpers', () => {
  test('resolveEffectiveOverlaySettings disables overlay controls when access is denied', () => {
    expect(
      resolveEffectiveOverlaySettings(settings, { allowed: false, reason: 'unpaid' }, false),
    ).toEqual({
      accountUserId: 'user_123',
      enabled: false,
      permissionSetupPending: false,
      hotkey: 'Control+Space',
      preferredWorkspacePath: null,
      preferredNoWorkspace: false,
      preferredProfileId: null,
      advancedVoiceEnabled: true,
      advancedVoiceWorkspacePath: null,
      advancedVoiceModel: 'interpreter-fast',
      hiddenAgentModel: 'interpreter-fast',
      readToolPromptInjectionGuard: {
        enabled: false,
        modelProfileId: null,
      },
    });
  });

  test('resolveEffectiveOverlaySettings preserves settings when access is allowed', () => {
    expect(
      resolveEffectiveOverlaySettings(settings, { allowed: true, reason: 'allowed' }, false),
    ).toEqual(settings);
  });

  test('getOverlayUnavailableDialog explains unpaid access clearly', () => {
    expect(getOverlayUnavailableDialog({ allowed: false, reason: 'unpaid' })).toEqual({
      message: 'Interpreter Overlay is available on paid plans.',
      detail: 'Upgrade your plan to use the overlay.',
    });
  });

  test('getOverlayUnavailableDialog explains unsupported platform clearly', () => {
    expect(
      getOverlayUnavailableDialog({
        allowed: false,
        reason: 'unsupported-platform',
        detail: 'Interpreter Overlay is not available on Windows yet.',
      }),
    ).toEqual({
      message: 'Interpreter Overlay is unavailable on this platform.',
      detail: 'Interpreter Overlay is not available on Windows yet.',
    });
  });

  test('resolveOverlaySettingsForCurrentAccount disables enabled overlay for a different user', async () => {
    const { resolveOverlaySettingsForCurrentAccount } = await import('./access');

    expect(resolveOverlaySettingsForCurrentAccount(settings, 'user_456')).toEqual({
      accountUserId: 'user_123',
      enabled: false,
      permissionSetupPending: false,
      hotkey: 'Control+Space',
      preferredWorkspacePath: null,
      preferredNoWorkspace: false,
      preferredProfileId: null,
      advancedVoiceEnabled: true,
      advancedVoiceWorkspacePath: null,
      advancedVoiceModel: 'interpreter-fast',
      hiddenAgentModel: 'interpreter-fast',
      readToolPromptInjectionGuard: {
        enabled: false,
        modelProfileId: null,
      },
    });
  });

  test('resolveOverlaySettingsForCurrentAccount preserves settings in form-tests mode', async () => {
    process.env.FORM_TESTS_MODE = 'true';
    const { resolveOverlaySettingsForCurrentAccount } = await import('./access');

    expect(resolveOverlaySettingsForCurrentAccount(settings, null)).toEqual(settings);

    delete process.env.FORM_TESTS_MODE;
  });
});
