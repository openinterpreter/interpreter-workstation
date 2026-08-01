import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { OnboardingProvider, useOnboarding } from '../OnboardingContext';

const overlaySettingsMock = vi.hoisted(() => ({
  getPermissionStatus: vi.fn(),
  requestAccessibilityPermission: vi.fn(),
  requestScreenRecordingPermission: vi.fn(),
  openAccessibilitySettings: vi.fn(),
  openScreenRecordingSettings: vi.fn(),
}));

const i18nMocks = vi.hoisted(() => {
  const labels: Record<string, string> = {
    'onboarding.overlayPermissions.title': 'Set up overlay permissions',
    'onboarding.overlayPermissions.description': 'Interpreter can work with the current app when these permissions are ready.',
    'onboarding.overlayPermissions.accessibilityTitle': 'Accessibility',
    'onboarding.overlayPermissions.accessibilityDescription': 'Lets Interpreter inspect app controls.',
    'onboarding.overlayPermissions.accessibilityAction': 'Request Accessibility',
    'onboarding.overlayPermissions.screenRecordingTitle': 'Screen Recording',
    'onboarding.overlayPermissions.screenRecordingDescription': 'Lets Interpreter verify what is visible.',
    'onboarding.overlayPermissions.screenRecordingAction': 'Request Screen Recording',
    'onboarding.overlayPermissions.statusGranted': 'Granted',
    'onboarding.overlayPermissions.statusNotGranted': 'Not granted',
    'onboarding.overlayPermissions.statusNotRequested': 'Not requested yet',
    'onboarding.overlayPermissions.statusDenied': 'Denied',
    'onboarding.overlayPermissions.statusRestricted': 'Restricted',
    'onboarding.overlayPermissions.statusUnknown': 'Unknown',
    'onboarding.overlayPermissions.canContinue': 'You can continue and finish this later in Settings.',
    'onboarding.overlayPermissions.checkAgain': 'Check again',
    'onboarding.overlayPermissions.checking': 'Checking...',
    'onboarding.overlayPermissions.opening': 'Opening...',
    'onboarding.overlayPermissions.continue': 'Set up AI',
    'onboarding.overlayPermissions.permissionStillNeeded': 'Permission is still needed.',
  };

  return {
    t: (key: string) => labels[key] ?? key,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: i18nMocks.t,
  }),
}));

vi.mock('../../../ipc', () => ({
  overlaySettings: overlaySettingsMock,
}));

import { OverlayPermissionsScreen } from './OverlayPermissionsScreen';

function ContinueHarness() {
  const { footerConfig } = useOnboarding();

  return (
    <button
      type="button"
      disabled={!footerConfig?.continueAction || footerConfig.continueDisabled || footerConfig.continueLoading}
      onClick={() => footerConfig?.continueAction?.()}
    >
      {footerConfig?.continueLabel ?? 'Continue'}
    </button>
  );
}

describe('OverlayPermissionsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overlaySettingsMock.getPermissionStatus.mockResolvedValue({
      status: {
        accessibilityGranted: false,
        screenRecordingGranted: false,
        screenRecordingStatus: 'not-determined',
      },
    });
    overlaySettingsMock.requestAccessibilityPermission.mockResolvedValue({
      success: false,
      status: {
        accessibilityGranted: false,
        screenRecordingGranted: false,
        screenRecordingStatus: 'not-determined',
      },
      error: 'Approve Interpreter in System Settings.',
    });
    overlaySettingsMock.requestScreenRecordingPermission.mockResolvedValue({
      success: true,
      status: {
        accessibilityGranted: false,
        screenRecordingGranted: true,
        screenRecordingStatus: 'granted',
      },
    });
    overlaySettingsMock.openAccessibilitySettings.mockResolvedValue({ success: true });
    overlaySettingsMock.openScreenRecordingSettings.mockResolvedValue({ success: true });
  });

  test('renders current permission status and advances through footer config', async () => {
    const onNext = vi.fn();

    render(
      <OnboardingProvider totalSteps={22}>
        <OverlayPermissionsScreen onNext={onNext} />
        <ContinueHarness />
      </OnboardingProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Set up overlay permissions' })).toBeInTheDocument();

    await waitFor(() => {
      expect(overlaySettingsMock.getPermissionStatus).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('Accessibility')).toBeInTheDocument();
    expect(screen.getByText('Screen Recording')).toBeInTheDocument();
    expect(screen.getByText('Not granted')).toBeInTheDocument();
    expect(screen.getByText('Not requested yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set up AI' }));

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  test('requests missing permissions through the existing overlay settings IPC', async () => {
    render(
      <OnboardingProvider totalSteps={22}>
        <OverlayPermissionsScreen onNext={vi.fn()} />
      </OnboardingProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Request Accessibility' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Request Accessibility' }));

    await waitFor(() => {
      expect(overlaySettingsMock.requestAccessibilityPermission).toHaveBeenCalledTimes(1);
      expect(overlaySettingsMock.openAccessibilitySettings).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('Approve Interpreter in System Settings.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request Screen Recording' }));

    await waitFor(() => {
      expect(overlaySettingsMock.requestScreenRecordingPermission).toHaveBeenCalledTimes(1);
    });
  });
});
