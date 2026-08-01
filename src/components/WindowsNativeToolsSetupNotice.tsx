import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shield, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { nativeTools, getRuntimeSystemInfo } from '@/ipc';
import { useLowerLeftNotice } from '@/contexts/LowerLeftNoticesContext';
import { useToast } from '@/contexts/ToastContext';
import { useLayoutActions } from '@/hooks/useLayout';
import {
  CODEX_SANDBOX_MODE_CHANGED_EVENT,
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexSandboxMode,
} from '@/lib/codex/sandbox-ui';
import { formatWindowsSandboxSetupError } from '@/lib/codex/windows-sandbox-setup-error';

const NOTICE_ID = 'windows-native-tools-setup';
const STORAGE_KEY = 'codex-windows-sandbox-setup-notice-v1';
const RUNTIME_PERMISSIONS_SECTION = 'runtimePermissions';

type NoticePreference = 'completed' | null;

function readPreference(): NoticePreference {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = window.localStorage.getItem(STORAGE_KEY);
  if (value === 'completed') {
    return value;
  }
  return null;
}

function writePreference(value: Exclude<NoticePreference, null>): void {
  window.localStorage.setItem(STORAGE_KEY, value);
}

export function WindowsNativeToolsSetupNotice() {
  "use no memo";

  const { showToast, dismissToast } = useToast();
  const { openSettings } = useLayoutActions();
  const [isVisible, setIsVisible] = useState(false);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const runtimePlatform = getRuntimeSystemInfo().platform;

  const refreshVisibility = useCallback(async () => {
    if (runtimePlatform !== 'win32') {
      setIsVisible(false);
      return;
    }

    const preference = readPreference();
    if (preference === 'completed') {
      setIsVisible(false);
      return;
    }

    try {
      const sandboxResult = await nativeTools.getSandboxMode();
      const sandboxMode = (sandboxResult.mode ?? DEFAULT_CODEX_SANDBOX_MODE) as CodexSandboxMode;
      setIsVisible(sandboxMode !== 'danger-full-access');
    } catch (error) {
      console.error('Failed to load Windows sandbox setup state:', error);
      setIsVisible(false);
    }
  }, [runtimePlatform]);

  useEffect(() => {
    void refreshVisibility();

    const handleConfigChanged = () => {
      void refreshVisibility();
    };

    window.addEventListener(CODEX_SANDBOX_MODE_CHANGED_EVENT, handleConfigChanged);
    return () => {
      window.removeEventListener(CODEX_SANDBOX_MODE_CHANGED_EVENT, handleConfigChanged);
    };
  }, [refreshVisibility]);

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
  }, []);

  const showSetupFailure = useCallback((rawError: string | null | undefined) => {
    const formattedError = formatWindowsSandboxSetupError(rawError);
    if (rawError && formattedError !== rawError.trim()) {
      console.error('Windows sandbox setup failed:', rawError);
    }
    showToast(
      formattedError,
      'error',
      8000,
      [{
        label: 'Runtime Permissions',
        onClick: () => openSettings(undefined, RUNTIME_PERMISSIONS_SECTION),
      }],
    );
  }, [openSettings, showToast]);

  const handleSetup = useCallback(async () => {
    setIsSettingUp(true);
    const toastId = showToast('Windows sandbox setup needs admin approval once', 'info');

    try {
      const result = await nativeTools.setupWindowsSandbox('elevated');
      dismissToast(toastId);

      if (!result.success) {
        showSetupFailure(result.error);
        return;
      }

      writePreference('completed');
      setIsVisible(false);
      showToast('Windows sandbox is ready for Interpreter execution.', 'success', 4000);
    } catch (error) {
      dismissToast(toastId);
      const rawMessage = error instanceof Error ? error.message : null;
      showSetupFailure(rawMessage);
    } finally {
      setIsSettingUp(false);
      void refreshVisibility();
    }
  }, [dismissToast, refreshVisibility, showSetupFailure, showToast]);

  const content = useMemo(() => {
    if (!isVisible) {
      return null;
    }

    return (
      <div className="w-full max-w-[20rem] transition-all duration-300 ease-out animate-in fade-in slide-in-from-bottom-2">
        <div
          className="w-full overflow-hidden rounded-[16px] backdrop-blur-[10px]"
          style={{
            border:
              'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
            background:
              'color-mix(in srgb, var(--oa-bg-app, var(--popover)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)',
            boxShadow:
              '0 24px 56px -30px rgba(0, 0, 0, 0.24), 0 12px 24px -18px rgba(0, 0, 0, 0.16)',
          }}
        >
          <div className="flex items-start gap-3 px-3.5 py-3.5">
            <div
              className="flex size-8 shrink-0 items-center justify-center rounded-[12px]"
              style={{
                background:
                  'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 84%, transparent)',
              }}
            >
              <Shield className="size-4 text-[var(--oa-text-strong, var(--foreground))]" />
            </div>

            <div className="min-w-0 flex-1">
              <span className="block text-ui-sm font-medium text-[var(--oa-text-strong, var(--foreground))]">
                Windows sandbox setup
              </span>
              <span className="mt-0.5 block text-ui-xs leading-4 text-muted-foreground">
                Creates local sandbox accounts and configures folder permissions for Interpreter execution on this machine.
              </span>
              <span className="mt-1 block text-ui-xs leading-4 text-muted-foreground">
                Windows will ask for admin approval once.
              </span>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  onClick={handleDismiss}
                  disabled={isSettingUp}
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2.5 text-ui-sm text-muted-foreground"
                >
                  Not now
                </Button>
                <Button
                  onClick={handleSetup}
                  disabled={isSettingUp}
                  variant="default"
                  size="sm"
                  className="h-8 px-3"
                >
                  {isSettingUp ? 'Setting up...' : 'Set up now'}
                </Button>
              </div>
            </div>

            <Button
              onClick={handleDismiss}
              disabled={isSettingUp}
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-foreground"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }, [handleDismiss, handleSetup, isSettingUp, isVisible]);

  useLowerLeftNotice(NOTICE_ID, content);

  return null;
}
