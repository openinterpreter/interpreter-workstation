export interface ReadToolPromptInjectionGuardSettings {
  enabled: boolean;
  modelProfileId: string | null;
}

export interface InterpreterOverlaySettings {
  accountUserId: string | null;
  enabled: boolean;
  permissionSetupPending: boolean;
  hotkey: string;
  preferredWorkspacePath: string | null;
  preferredNoWorkspace: boolean;
  preferredProfileId: string | null;
  advancedVoiceEnabled: boolean;
  advancedVoiceWorkspacePath: string | null;
  advancedVoiceModel: string;
  hiddenAgentModel: string;
  readToolPromptInjectionGuard: ReadToolPromptInjectionGuardSettings;
}

export interface OverlayModelTaskProfileIds {
  preferredTextProfileId: string | null;
  advancedVoiceProfileId: string;
  hiddenAgentProfileId: string;
  readToolGuardProfileId: string | null;
}

export const DEFAULT_INTERPRETER_OVERLAY_SETTINGS: InterpreterOverlaySettings = {
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

export function normalizeInterpreterOverlayHotkey(hotkey: string): string {
  const normalized = hotkey
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('+');

  if (!normalized) {
    throw new Error('Overlay hotkey cannot be empty');
  }

  return normalized;
}

export function sanitizeInterpreterOverlaySettings(
  settings?: Partial<InterpreterOverlaySettings> | null,
): InterpreterOverlaySettings {
  const guard = settings?.readToolPromptInjectionGuard;

  return {
    accountUserId: typeof settings?.accountUserId === 'string' ? settings.accountUserId : null,
    enabled: settings?.enabled ?? DEFAULT_INTERPRETER_OVERLAY_SETTINGS.enabled,
    permissionSetupPending: settings?.permissionSetupPending === true,
    hotkey: normalizeInterpreterOverlayHotkey(
      settings?.hotkey ?? DEFAULT_INTERPRETER_OVERLAY_SETTINGS.hotkey,
    ),
    preferredWorkspacePath: typeof settings?.preferredWorkspacePath === 'string'
      ? settings.preferredWorkspacePath
      : null,
    preferredNoWorkspace: settings?.preferredNoWorkspace === true,
    preferredProfileId: typeof settings?.preferredProfileId === 'string' && settings.preferredProfileId.trim()
      ? settings.preferredProfileId.trim()
      : null,
    advancedVoiceEnabled: settings?.advancedVoiceEnabled !== false,
    advancedVoiceWorkspacePath: typeof settings?.advancedVoiceWorkspacePath === 'string'
      ? settings.advancedVoiceWorkspacePath
      : null,
    advancedVoiceModel: typeof settings?.advancedVoiceModel === 'string' && settings.advancedVoiceModel.trim()
      ? settings.advancedVoiceModel.trim()
      : DEFAULT_INTERPRETER_OVERLAY_SETTINGS.advancedVoiceModel,
    hiddenAgentModel: typeof settings?.hiddenAgentModel === 'string' && settings.hiddenAgentModel.trim()
      ? settings.hiddenAgentModel.trim()
      : DEFAULT_INTERPRETER_OVERLAY_SETTINGS.hiddenAgentModel,
    readToolPromptInjectionGuard: {
      enabled: guard?.enabled === true,
      modelProfileId: typeof guard?.modelProfileId === 'string' && guard.modelProfileId.trim()
        ? guard.modelProfileId.trim()
        : null,
    },
  };
}

export function resolveOverlayModelTaskProfileIds(
  settings?: Partial<InterpreterOverlaySettings> | null,
): OverlayModelTaskProfileIds {
  const sanitized = sanitizeInterpreterOverlaySettings(settings);
  return {
    preferredTextProfileId: sanitized.preferredProfileId,
    advancedVoiceProfileId: sanitized.advancedVoiceModel,
    hiddenAgentProfileId: sanitized.hiddenAgentModel,
    readToolGuardProfileId: sanitized.readToolPromptInjectionGuard.enabled
      ? sanitized.readToolPromptInjectionGuard.modelProfileId
      : null,
  };
}
