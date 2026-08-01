import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_INTERPRETER_OVERLAY_SETTINGS,
  resolveOverlayModelTaskProfileIds,
  sanitizeInterpreterOverlaySettings,
} from './settings';

describe('interpreter overlay settings', () => {
  test('defaults overlay to disabled for first-time users', () => {
    expect(DEFAULT_INTERPRETER_OVERLAY_SETTINGS).toEqual({
      accountUserId: null,
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

  test('sanitizeInterpreterOverlaySettings applies disabled defaults when missing', () => {
    expect(sanitizeInterpreterOverlaySettings(undefined)).toEqual({
      accountUserId: null,
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

  test('sanitizes the hidden-agent model setting', () => {
    expect(sanitizeInterpreterOverlaySettings({
      hiddenAgentModel: '  profile-fast  ',
    }).hiddenAgentModel).toBe('profile-fast');
    expect(sanitizeInterpreterOverlaySettings({
      hiddenAgentModel: '   ',
    }).hiddenAgentModel).toBe('interpreter-fast');
  });

  test('sanitizes the read-tool prompt-injection guard setting', () => {
    expect(sanitizeInterpreterOverlaySettings({
      readToolPromptInjectionGuard: {
        enabled: true,
        modelProfileId: '  interpreter-smart  ',
      },
    }).readToolPromptInjectionGuard).toEqual({
      enabled: true,
      modelProfileId: 'interpreter-smart',
    });

    expect(sanitizeInterpreterOverlaySettings({
      readToolPromptInjectionGuard: {
        enabled: false,
        modelProfileId: '   ',
      },
    }).readToolPromptInjectionGuard).toEqual({
      enabled: false,
      modelProfileId: null,
    });
  });

  test('resolves all overlay model task profile ids from sanitized settings', () => {
    expect(resolveOverlayModelTaskProfileIds({
      preferredProfileId: '  interpreter-smart  ',
      advancedVoiceModel: '  interpreter-voice  ',
      hiddenAgentModel: '  interpreter-hidden  ',
      readToolPromptInjectionGuard: {
        enabled: true,
        modelProfileId: '  interpreter-guard  ',
      },
    })).toEqual({
      preferredTextProfileId: 'interpreter-smart',
      advancedVoiceProfileId: 'interpreter-voice',
      hiddenAgentProfileId: 'interpreter-hidden',
      readToolGuardProfileId: 'interpreter-guard',
    });
  });

  test('does not expose a read-tool guard model when the guard is disabled', () => {
    expect(resolveOverlayModelTaskProfileIds({
      readToolPromptInjectionGuard: {
        enabled: false,
        modelProfileId: 'interpreter-guard',
      },
    }).readToolGuardProfileId).toBeNull();
  });
});
