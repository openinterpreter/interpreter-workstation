/**
 * ExtensionDownloadBar
 *
 * Passive toast notification that listens for extension install events from
 * the main process. Appears in the bottom-left corner. Dismissible.
 * Uses the shared AppToast visual styling for consistency.
 */

import { useState, useEffect } from 'react';
import { Check, X } from 'lucide-react';
import { useLowerLeftNotice } from '../../contexts/LowerLeftNoticesContext';
import type { TtsInstallProgressEvent } from '../../../electron/ipc/registry';

type InstallerId = 'office' | 'voice' | 'ttsModel';
type InstallerStatus = 'idle' | 'running' | 'complete' | 'error';

interface InstallerState {
  required: boolean;
  status: InstallerStatus;
  progress: number;
  error?: string;
}

type InstallersState = Record<InstallerId, InstallerState>;

function createInitialInstallersState(): InstallersState {
  return {
    office: { required: false, status: 'idle', progress: 0 },
    voice: { required: false, status: 'idle', progress: 0 },
    ttsModel: { required: false, status: 'idle', progress: 0 },
  };
}

function averageProgress(installers: InstallerState[]): number {
  if (installers.length === 0) return 0;
  const total = installers.reduce((sum, installer) => {
    if (installer.status === 'complete') return sum + 100;
    if (installer.status === 'running') return sum + installer.progress;
    return sum + 5;
  }, 0);
  return total / installers.length;
}

export function ExtensionDownloadBar() {
  const [installers, setInstallers] = useState<InstallersState>(() => createInitialInstallersState());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribeCallbacks: Array<() => void> = [];

    void (async () => {
      if (window.electron?.officeExtension?.checkInstalled) {
        try {
          const result = await window.electron.officeExtension.checkInstalled();
          if (!cancelled) {
            setInstallers((prev) => ({
              ...prev,
              office: result.installed
                ? { required: false, status: 'complete', progress: 100 }
                : { required: false, status: 'idle', progress: 0 },
            }));
          }
        } catch {
          // Keep default state. Any progress event will still activate this installer.
        }
      }

      if (window.electron?.voiceExtension?.checkInstalled) {
        try {
          const result = await window.electron.voiceExtension.checkInstalled();
          if (!cancelled) {
            setInstallers((prev) => ({
              ...prev,
              voice: result.installed
                ? { required: false, status: 'complete', progress: 100 }
                : { required: false, status: 'idle', progress: 0 },
            }));
          }
        } catch {
          // Keep default state. Any progress event will still activate this installer.
        }
      }
    })();

    if (window.electron?.officeExtension?.onInstallProgress) {
      const offOfficeInstallProgress = window.electron.officeExtension.onInstallProgress((event) => {
        setDismissed(false);
        switch (event.stage) {
          case 'downloading': {
            const total = event.totalBytes || 0;
            const downloaded = event.bytesDownloaded || 0;
            const progress = total > 0 ? (downloaded / total) * 70 : 35;
            setInstallers((prev) => ({
              ...prev,
              office: { required: true, status: 'running', progress },
            }));
            break;
          }
          case 'extracting':
            setInstallers((prev) => ({
              ...prev,
              office: { required: true, status: 'running', progress: 88 },
            }));
            break;
          case 'configuring':
            setInstallers((prev) => ({
              ...prev,
              office: { required: true, status: 'running', progress: 96 },
            }));
            break;
          case 'complete':
            setInstallers((prev) => ({
              ...prev,
              office: { required: true, status: 'complete', progress: 100 },
            }));
            break;
          case 'error':
            setInstallers((prev) => ({
              ...prev,
              office: { required: true, status: 'error', progress: prev.office.progress, error: event.error || 'Failed' },
            }));
            break;
        }
      });
      unsubscribeCallbacks.push(offOfficeInstallProgress);
    }

    if (window.electron?.voiceExtension?.onInstallProgress) {
      const offVoiceInstallProgress = window.electron.voiceExtension.onInstallProgress((event) => {
        setDismissed(false);
        switch (event.stage) {
          case 'preparing':
            setInstallers((prev) => ({
              ...prev,
              voice: { required: true, status: 'running', progress: 20 },
            }));
            break;
          case 'downloading':
            setInstallers((prev) => ({
              ...prev,
              voice: { required: true, status: 'running', progress: 60 },
            }));
            break;
          case 'copying':
            setInstallers((prev) => ({
              ...prev,
              voice: { required: true, status: 'running', progress: 90 },
            }));
            break;
          case 'complete':
            setInstallers((prev) => ({
              ...prev,
              voice: { required: true, status: 'complete', progress: 100 },
            }));
            break;
          case 'error':
            setInstallers((prev) => ({
              ...prev,
              voice: { required: true, status: 'error', progress: prev.voice.progress, error: event.error || 'Failed' },
            }));
            break;
        }
      });
      unsubscribeCallbacks.push(offVoiceInstallProgress);
    }

    // TTS model install progress (auto-triggered on first playback)
    if (window.electron?.tts?.onInstallProgress) {
      const offTtsInstallProgress = window.electron.tts.onInstallProgress((event: TtsInstallProgressEvent) => {
        setDismissed(false);
        switch (event.stage) {
          case 'preparing':
            setInstallers((prev) => ({
              ...prev,
              ttsModel: { required: true, status: 'running', progress: 5 },
            }));
            break;
          case 'downloading': {
            const total = event.totalBytes || 0;
            const downloaded = event.bytesDownloaded || 0;
            const progress = total > 0 ? 5 + (downloaded / total) * 75 : 40;
            setInstallers((prev) => ({
              ...prev,
              ttsModel: { required: true, status: 'running', progress },
            }));
            break;
          }
          case 'extracting':
            setInstallers((prev) => ({
              ...prev,
              ttsModel: { required: true, status: 'running', progress: 90 },
            }));
            break;
          case 'complete':
            setInstallers((prev) => ({
              ...prev,
              ttsModel: { required: true, status: 'complete', progress: 100 },
            }));
            break;
          case 'error':
            setInstallers((prev) => ({
              ...prev,
              ttsModel: { required: true, status: 'error', progress: prev.ttsModel.progress, error: event.error || 'Failed' },
            }));
            break;
        }
      });
      unsubscribeCallbacks.push(offTtsInstallProgress);
    }

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribeCallbacks) {
        unsubscribe();
      }
    };
  }, []);

  const requiredInstallers = Object.values(installers).filter((installer) => installer.required);
  const hasRequiredInstalls = requiredInstallers.length > 0;
  const hasError = requiredInstallers.some((installer) => installer.status === 'error');
  const isComplete = hasRequiredInstalls
    && requiredInstallers.every((installer) => installer.status === 'complete');
  const isInstalling = hasRequiredInstalls && !isComplete && !hasError;
  const progressPercent = averageProgress(requiredInstallers);
  const errorMessage = requiredInstallers.find((installer) => installer.status === 'error')?.error;

  useEffect(() => {
    if (isInstalling) {
      setDismissed(false);
      return;
    }
    if (isComplete) {
      const timer = setTimeout(() => setDismissed(true), 3000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, isInstalling]);

  const isIndeterminate = isInstalling && requiredInstallers.some((installer) => installer.status === 'idle');

  // Show a contextual label when only a specific model type is active.
  const onlyTtsModel = installers.ttsModel.required
    && !installers.office.required && !installers.voice.required;
  const onlyVoice = installers.voice.required
    && !installers.office.required && !installers.ttsModel.required;
  const label = hasError
    ? onlyTtsModel ? 'Voice model download failed'
      : onlyVoice ? 'Voice model install failed'
        : 'Recommended extension install failed'
    : isComplete
      ? onlyTtsModel || onlyVoice ? 'Voice model ready'
        : 'Recommended extensions ready'
      : onlyTtsModel ? 'Downloading voice model...'
        : onlyVoice ? 'Installing voice model...'
          : 'Installing recommended extensions...';

  const content = dismissed || !hasRequiredInstalls ? null : (
    <div
      className={`
        w-full max-w-[20rem]
        transition-all duration-500 ease-out
        ${isComplete ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'}
      `}
    >
      <div
        className="w-full overflow-hidden rounded-[16px] border border-black/[0.06] bg-[var(--oa-surface-center)] shadow-[0_8px_30px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.4)]"
      >
        <div className="flex items-start gap-2.5 px-3 py-3">
          <div className="mt-0.5 shrink-0">
            {isComplete ? (
              <Check className="size-3.5 text-[#6b7280] dark:text-[#b4b4b4]" />
            ) : hasError ? null : (
              <div className="size-3.5 border-[1.5px] border-[#6b7280]/60 border-t-transparent rounded-full animate-spin dark:border-[#b4b4b4]/60 dark:border-t-transparent" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <span className={`text-ui-sm font-medium leading-tight ${hasError ? 'text-status-error' : 'text-[#202123] dark:text-[#f5f5f5]'}`}>
              {label}
            </span>
            {isInstalling && (
              <p className="mt-1 text-ui-xs text-[#6b7280] dark:text-[#b4b4b4]">
                {onlyTtsModel || onlyVoice
                  ? 'Voice features will be available once the download completes.'
                  : 'Some features may be unavailable while extensions download.'}
              </p>
            )}
            {hasError && errorMessage && (
              <p className="mt-1 text-ui-xs text-status-error/90 truncate" title={errorMessage}>
                {errorMessage}
              </p>
            )}
          </div>

          <button
            onClick={() => setDismissed(true)}
            className="mt-0.5 shrink-0 text-[#6b7280]/40 hover:text-[#6b7280] dark:text-[#b4b4b4]/40 dark:hover:text-[#b4b4b4] transition-colors"
          >
            <X className="size-3" />
          </button>
        </div>

        {/* Progress track */}
        {!isComplete && !hasError && (
          <div className="h-[2px] bg-black/[0.04] dark:bg-white/[0.06]">
            {isIndeterminate ? (
              <div className="h-full bg-[#6b7280]/40 animate-pulse dark:bg-[#b4b4b4]/40" style={{ width: '100%' }} />
            ) : (
              <div
                className="h-full bg-[#6b7280]/40 dark:bg-[#b4b4b4]/40 transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );

  useLowerLeftNotice('extension-download', content);

  return null;
}
