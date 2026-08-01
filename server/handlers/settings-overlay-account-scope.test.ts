import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { scopeInterpreterOverlaySettingsToCurrentAccount } from './settings';
import type { InterpreterOverlaySettings } from '../../apps/interpreter-overlay/shared/settings';

const baseSettings: InterpreterOverlaySettings = {
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
};

describe('interpreter overlay account scoping', () => {
  test('binds enabled overlay settings to the current backend account', () => {
    const settings = scopeInterpreterOverlaySettingsToCurrentAccount(
      {
        ...baseSettings,
        enabled: true,
      },
      'user_123',
    );

    assert.equal(settings.enabled, true);
    assert.equal(settings.accountUserId, 'user_123');
  });

  test('leaves disabled overlay settings unchanged', () => {
    const settings = scopeInterpreterOverlaySettingsToCurrentAccount(
      {
        ...baseSettings,
        accountUserId: 'user_123',
      },
      'user_456',
    );

    assert.equal(settings.enabled, false);
    assert.equal(settings.accountUserId, 'user_123');
  });
});
