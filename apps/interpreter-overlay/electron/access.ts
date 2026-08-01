import type { InterpreterOverlaySettings } from '../shared/settings.js';
import type { InterpreterOverlayAccessState } from '../../../server/lib/subscriptionStatus';

export function resolveEffectiveOverlaySettings(
  settings: InterpreterOverlaySettings,
  accessState: InterpreterOverlayAccessState,
  benchmarkMode: boolean,
): InterpreterOverlaySettings {
  if (benchmarkMode || accessState.allowed) {
    return settings;
  }

  return {
    ...settings,
    enabled: false,
  };
}

export function resolveOverlaySettingsForCurrentAccount(
  settings: InterpreterOverlaySettings,
  currentUserId: string | null,
): InterpreterOverlaySettings {
  if (process.env.FORM_TESTS_MODE === 'true') {
    return settings;
  }

  if (!settings.enabled) {
    return settings;
  }

  if (!settings.accountUserId || settings.accountUserId !== currentUserId) {
    return {
      ...settings,
      enabled: false,
    };
  }

  return settings;
}

export function getOverlayUnavailableDialog(
  accessState: InterpreterOverlayAccessState,
): { message: string; detail: string } {
  switch (accessState.reason) {
    case 'unsupported-platform':
      return {
        message: 'Interpreter Overlay is unavailable on this platform.',
        detail: accessState.detail ?? 'This feature is currently unavailable on this platform.',
      };
    case 'signed-out':
      return {
        message: 'Please sign in to use Interpreter Overlay.',
        detail: 'Sign in to a paid account to access the overlay.',
      };
    case 'unpaid':
      return {
        message: 'Interpreter Overlay is available on paid plans.',
        detail: 'Upgrade your plan to use the overlay.',
      };
    case 'error':
      return {
        message: 'Interpreter Overlay is unavailable right now.',
        detail: accessState.detail ?? 'Unable to verify your subscription status.',
      };
    case 'allowed':
      return {
        message: 'Interpreter Overlay is available.',
        detail: '',
      };
  }
}
