/**
 * ComposerArea - Unified composer component for both agents and terminals
 *
 * This component renders the composer area that is always visible at the bottom
 * of the agent sidebar. It routes sends to either the agent runtime or terminal
 * session based on the active tab type.
 */

import React, { useState, useEffect, useCallback, useRef, useContext, useImperativeHandle, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { BaseTiptapComposer, BaseTiptapComposerRef } from './composer/BaseTiptapComposer';
import { SendButtonWithMenu } from './composer/SendButtonWithMenu';
import { ButtonWithHoverMenu, type HoverMenuItem } from './composer/ButtonWithHoverMenu';
import {
  buildSuggestionChipMessageSource,
  describeVoiceError,
  getEffectiveComposerWorkspacePath,
  getPendingInputValidationError,
  isLikelyMicrophonePermissionError,
  primeMicrophonePermission,
  getVoiceSendBehavior,
  normalizeWindowVoiceSelectedText,
  resolveComposerMessageSource,
  shouldHandleManualTtsPlayRequest,
  shouldAdoptWindowWorkspaceForIdleComposer,
  shouldCancelCurrentTurnForVoiceBargeIn,
  type AssistantTtsManualPlayRequestDetail,
} from './ComposerArea.helpers';
import { ContextPreview, calculateContextDiff, formatContextDiffForMessage, getLastSentContext, setLastSentContext, isContextEnabled } from './composer/ContextPreview';
import { WorkspacePopover } from './composer/WorkspacePopover';
import { QueuedMessagesDisplay } from './composer/QueuedMessagesDisplay';
import { SuggestionChips } from './composer/SuggestionChips';
import { ComposerSecondaryButton } from './composer/ComposerSecondaryButton';
import { ResizeHandle } from '../../src/components/ui/resize-handle';
import { LayoutContext } from '../../src/contexts/LayoutContext';
import {
  files,
  getRuntimeSystemInfo,
  interpreterOverlay,
  nativeTools,
  openPathDialog,
  pathDirname,
  stt,
  tts,
  workspace as workspaceIpc,
} from '../../src/ipc';
import {
  getMarketingDemoAutoplayPromptId,
  getMarketingDemoPromptOptions,
  isMarketingDemoMode,
  type MarketingDemoPromptOption,
} from '../../src/demo/marketingDemo';
import type { Profile } from '../../shared/types/profile';
import type { MessageSendSource } from '../../shared/types/messageSendSource';
import type { AgentModelConfig } from '../../shared/types/model';
import {
  DEFAULT_STT_SETTINGS,
  getPrimaryAmbientPhrase,
  type SttBackend,
  type SttSettings,
  type VoiceMode,
} from '../../shared/types/stt';
import { DEFAULT_TTS_MODEL_ID, getTtsModelById, type TtsModelId } from '../../shared/types/tts';
import {
  AGENT_SEED_COMPOSER_EVENT,
  consumePendingAgentComposerSeed,
  peekPendingAgentComposerSeed,
  type AgentSeedComposerDetail,
} from '../../shared/agentEvents';
import { ArrowUp, AudioLines, Check, Keyboard, Loader2, MessageSquare, Plus, Radio, Square, X } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../src/components/ui/tooltip';
import { MAIN_COMPOSER_SEND_BUTTON_ID, MAIN_COMPOSER_VOICE_BUTTON_ID, VOICE_OVERLAY_TEXT_ID } from '../../shared/element-ids';
import { Button } from '../../src/components/ui/button';
import { OnboardingModal } from '../../src/components/onboarding/components/OnboardingModal';
import { ExperimentalBadge } from '../../src/components/onboarding/components/ExperimentalBadge';
import { useToast } from '../../src/contexts/ToastContext';
import { trackVoiceModeStarted, trackVoiceModeStopped, trackVoiceModeChanged } from '../../src/utils/telemetry';
import {
  MICROPHONE_CAPTURE_REQUEST,
  QwenStreamingCaptureSession,
  checkEndOfTurn,
  getAdaptiveVoiceSilenceTimeoutMs,
  shouldUseMoonshineVoiceBackend,
  finishVoiceStreamSession,
  warmVoiceStreamSession,
} from '../utils/voiceCapture';
import { QwenVoiceStreamBridge } from '../utils/qwenVoiceStreamBridge';
import { loadMoonshineModule, warmMoonshineModel, type MoonshineMicrophoneTranscriber } from '../utils/moonshine';
import { emitVoiceLatencyEvent } from '../utils/voiceLatency';
import { isComposerFileDrag, resolveComposerFileDropData } from '../../src/utils/composerDrop';
import { markActiveFileDragHandled } from '../../src/utils/fileDragData';
import {
  extractAmbientCommandText,
  resolveAmbientCommandFinalText,
  resolveAmbientDetectorFinishRequest,
  resolveAmbientEndPhrase,
  resolveAmbientTranscriptGate,
} from '../utils/ambientVoice';
import {
  buildTolerantPhraseSetPattern,
  mergeStreamingVoiceTranscript,
  normalizeVoiceText,
} from '../utils/voiceTranscript';
import { sanitizeTranscriptForLanguage } from '../../shared/utils/sttTranscriptSanitizer';
import { playSound } from '../../src/utils/sounds';
import {
  CODEX_SANDBOX_MODE_CHANGED_EVENT,
  DEFAULT_CODEX_SANDBOX_MODE,
  getCodexSandboxNotice,
  type CodexSandboxMode,
} from '../../src/lib/codex/sandbox-ui';
import {
  addAgentPendingInput,
  getAgentPendingInputs,
  getLatestPendingInputContextSnapshot,
  isAgentPendingInputSteerLocked,
  removeAgentPendingInput,
  subscribeAgentPendingInputs,
  updateAgentPendingInput,
  type AgentPendingInput,
} from '../../src/stores/agentPendingInputStore';
import type { StreamImageAttachment } from '../../src/lib/codex/api-types';
import type { SerializedComposerSubmission } from './composer/attachment/types';

export interface ComposerAreaProps {
  // Tab type
  isTerminal: boolean;

  // Agent mode props
  agentId?: string;
  modelConfig?: AgentModelConfig;
  workspacePath?: string;
  isStreaming?: boolean;
  autoStartVoiceMode?: boolean;
  messageCount: number;
  onAgentSend?: (
    text: string,
    options?: {
      workspacePath?: string | null;
      attachments?: StreamImageAttachment[];
      messageSource?: MessageSendSource | null;
    },
  ) => void;
  onWorkspacePathChange?: (workspacePath: string) => void;
  onVoiceModeAutoStartConsumed?: () => void;

  // Terminal mode props
  terminalSessionId?: string | null;
  onTerminalSend?: (text: string) => void;

  // Profile selection
  onProfileSelect?: (profile: Profile) => void;
  settingsContent?: React.ReactNode;
  showSuggestionChips?: boolean;
  onSuggestionOverlayHeightChange?: (height: number) => void;
  suggestionOverlayOpacity?: number;
  showQueuedMessages?: boolean;
  topAccessory?: React.ReactNode;
  showResizeHandle?: boolean;
  showFirstStartupNudge?: boolean;
  onBeforeSend?: (text: string) => void;
  noBorderPadding?: boolean;
  morphTarget?: boolean;
}

const WIDE_BREAKPOINT = 500;
const VOICE_MODE_CHANGED_EVENT = 'agent:voice-mode-changed';
const ASSISTANT_TTS_STOP_EVENT = 'assistant-tts:stop';
const ASSISTANT_TTS_ENQUEUE_EVENT = 'assistant-tts:enqueue-sentence';
const ASSISTANT_TTS_PLAYBACK_STATE_EVENT = 'assistant-tts:playback-state';
const ASSISTANT_TTS_MANUAL_PLAY_REQUEST_EVENT = 'assistant-tts:manual-play-request';
const SETTINGS_FOCUS_SECTION_EVENT = 'settings:focus-section';
const AGENT_RUNTIME_STEER_EVENT = 'agent-runtime:steer';
const MOONSHINE_MODEL_NAME = 'model/base';
// Keep Moonshine in its starting state long enough that Windows cold starts do
// not show "ready" before the first utterance can be transcribed reliably.
const MIN_MOONSHINE_VOICE_MODE_READY_MS = 4000;
const MIN_QWEN_VOICE_MODE_READY_MS = 5000;
const MOONSHINE_STT_DOWNLOAD_BYTES = 63011933;
const QWEN_STT_DOWNLOAD_BYTES = 1880546725;
const VOICE_MODELS_MODAL_STYLE: React.CSSProperties = {
  border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 58%, transparent)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 96%, var(--oa-bg-subtle) 4%)',
  boxShadow: '0 24px 80px -40px var(--shadow-color)',
};

const EMPTY_COMPOSER_SUBMISSION: SerializedComposerSubmission = {
  text: '',
  attachments: [],
};

function hasSubmissionContent(submission: SerializedComposerSubmission): boolean {
  return submission.text.trim().length > 0 || submission.attachments.length > 0;
}

function buildPendingPreviewText(submission: SerializedComposerSubmission): string {
  return submission.text.trim();
}

interface VoiceModelRequirementStatus {
  sttBackend: SttBackend;
  sttInstallRequired: boolean;
  sttInstalled: boolean;
  ttsInstallRequired: boolean;
  ttsInstalled: boolean;
  ttsModelId: TtsModelId;
  sttDownloadBytes: number;
  ttsDownloadBytes: number;
}

interface AssistantTtsSentenceEnqueueDetail {
  text: string;
  messageId: string;
  sentenceIndex: number;
  source?: 'assistant-auto' | 'manual';
}

interface ComposerSendOptions {
  messageSource?: MessageSendSource | null;
}

function truncateVoiceLogText(text: string, maxLength = 140): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizeSeedPromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/** Strip leading punctuation/whitespace that qwen_asr puts after trigger words (e.g. "Interpreter, ...") */
function stripLeadingPunctuation(text: string): string {
  return text.replace(/^[\s,.:;!?\-'"]+/, '').trim();
}

function formatDownloadSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) {
    return `${gib.toFixed(1)} GB`;
  }
  const mib = bytes / (1024 ** 2);
  return `${Math.round(mib)} MB`;
}

function getSttDownloadSizeBytes(backend: SttBackend): number {
  return backend === 'moonshine'
    ? MOONSHINE_STT_DOWNLOAD_BYTES
    : QWEN_STT_DOWNLOAD_BYTES;
}

function getSttModelDisplayLabel(backend: SttBackend): string {
  return backend === 'moonshine' ? 'Moonshine STT model' : 'Qwen STT model';
}

function resolveManagedSttBackend(backend: SttBackend): SttBackend {
  return shouldUseMoonshineVoiceBackend(backend) ? 'moonshine' : 'qwen';
}

/**
 * ComposerArea - unified composer for agents and terminals
 */
export const ComposerArea = React.forwardRef<BaseTiptapComposerRef, ComposerAreaProps>(function ComposerArea({
  isTerminal,
  agentId,
  modelConfig: _modelConfig, // Reserved for future use
  workspacePath,
  isStreaming = false,
  autoStartVoiceMode = false,
  messageCount,
  onAgentSend,
  onWorkspacePathChange,
  onVoiceModeAutoStartConsumed,
  terminalSessionId: _terminalSessionId, // Reserved for future use (terminal sessions)
  onTerminalSend,
  onProfileSelect: _onProfileSelect, // Reserved for future use (profile switching)
  settingsContent,
  showSuggestionChips = true,
  onSuggestionOverlayHeightChange,
  suggestionOverlayOpacity = 1,
  showQueuedMessages = true,
  topAccessory,
  showResizeHandle = true,
  showFirstStartupNudge = false,
  onBeforeSend,
  noBorderPadding = false,
  morphTarget = false,
}: ComposerAreaProps, forwardedRef) {
  "use no memo";

  const { t, i18n } = useTranslation();
  const layout = useContext(LayoutContext);
  const { showToast } = useToast();
  const marketingDemoMode = !isTerminal && isMarketingDemoMode();
  const marketingDemoPromptOptions = marketingDemoMode ? getMarketingDemoPromptOptions() : [];
  const marketingDemoPromptOptionsById = useRef<Map<string, MarketingDemoPromptOption>>(new Map());
  marketingDemoPromptOptionsById.current = new Map(
    marketingDemoPromptOptions.map((option) => [option.id, option]),
  );
  const marketingDemoSuggestions = marketingDemoMode
    ? marketingDemoPromptOptions.map((option) => ({
        id: option.id,
        label: option.label,
        prompt: option.prompt,
        action: 'send' as const,
      }))
    : undefined;
  const composerRef = useRef<BaseTiptapComposerRef>(null);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const marketingDemoPlaybackTimersRef = useRef<number[]>([]);
  const [isMarketingDemoPromptPlaying, setIsMarketingDemoPromptPlaying] = useState(false);
  const marketingDemoAutoplayPromptPlayedRef = useRef(false);
  const [showFlash, setShowFlash] = useState(false);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ y: number; height: number; naturalHeight: number } | null>(null);
  const [isOver, setIsOver] = useState(false);
  const [isVoiceModeActive, setIsVoiceModeActive] = useState(false);
  const [isVoiceModeStarting, setIsVoiceModeStarting] = useState(false);
  const [windowWorkspacePath, setWindowWorkspacePath] = useState<string | null>(null);
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>(DEFAULT_CODEX_SANDBOX_MODE);
  const [isPushToTalkHeld, setIsPushToTalkHeld] = useState(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState(false);
  const [ambientPhase, setAmbientPhase] = useState<'waiting' | 'accumulating'>('waiting');
  const [voiceOverlayText, setVoiceOverlayText] = useState('');
  const [sttSettingsForUi, setSttSettingsForUi] = useState<SttSettings>(DEFAULT_STT_SETTINGS);
  const [voiceModelRequirement, setVoiceModelRequirement] = useState<VoiceModelRequirementStatus | null>(null);
  const [isVoiceModelsModalOpen, setIsVoiceModelsModalOpen] = useState(false);
  const [isVoiceModelInstallPending, setIsVoiceModelInstallPending] = useState(false);
  const [isPushToTalkFinishing, setIsPushToTalkFinishing] = useState(false);
  const voiceCaptureSessionRef = useRef<QwenStreamingCaptureSession | null>(null);
  const qwenStreamBridgeRef = useRef<QwenVoiceStreamBridge | null>(null);
  const moonshineTranscriberRef = useRef<MoonshineMicrophoneTranscriber | null>(null);
  const moonshineSilenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moonshineCommittedTextRef = useRef('');
  const moonshinePartialTextRef = useRef('');
  const hasPrimedMoonshineMicrophoneRef = useRef(false);
  const voiceRenderedTextRef = useRef('');
  const isVoiceModeActiveRef = useRef(false);
  const voiceModeSessionTelemetryRef = useRef<{ startedAt: number; mode: VoiceMode; backend: SttBackend } | null>(null);
  const hasAutoStartedVoiceRef = useRef(false);
  const isVoiceSendInFlightRef = useRef(false);
  const isStreamingRef = useRef(isStreaming);
  const isMountedRef = useRef(true);
  const isAssistantTtsPlayingRef = useRef(false);
  const sttSettingsRef = useRef<SttSettings>(DEFAULT_STT_SETTINGS);
  const isPushToTalkHeldRef = useRef(false);
  const isPushToTalkAwaitingSpeechStartRef = useRef(false);
  const pendingVoiceModeRef = useRef<VoiceMode | undefined>(undefined);
  const pendingManualTtsPlaybackRef = useRef<AssistantTtsManualPlayRequestDetail | null>(null);
  const isVoiceModeStartWaitingForInstallRef = useRef(false);
  const ambientNativeBridgeRef = useRef<QwenVoiceStreamBridge | null>(null);
  const ambientCycleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMessageSourceRef = useRef<MessageSendSource | null>(null);

  // Responsive width tracking - bounded composer when wide enough
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isTerminal) return;
    let cancelled = false;

    workspaceIpc.get()
      .then(({ workspace }: { workspace: string | null }) => {
        if (!cancelled) {
          setWindowWorkspacePath(workspace);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWindowWorkspacePath(null);
        }
      });

    const unsubscribe = workspaceIpc.onChanged((event: { workspacePath: string | null }) => {
      setWindowWorkspacePath(event.workspacePath);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isTerminal]);

  useEffect(() => {
    if (isTerminal) return;
    if (!shouldUseMoonshineVoiceBackend(sttSettingsForUi.backend)) return;
    if (!window.electron?.voiceExtension?.checkInstalled) return;

    let cancelled = false;

    void window.electron.voiceExtension.checkInstalled({ backend: 'moonshine' })
      .then(async (result) => {
        if (cancelled) return;
        if (!result.installed) {
          console.log('[VoiceMode] Moonshine prewarm skipped; assets are not installed yet');
          return;
        }
        await warmMoonshineModel(MOONSHINE_MODEL_NAME);
        if (cancelled) return;
        console.log('[VoiceMode] Moonshine prewarm ready');
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[VoiceMode] Moonshine prewarm failed:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [isTerminal, sttSettingsForUi.backend]);

  useEffect(() => {
    if (isTerminal) return;
    let cancelled = false;

    nativeTools.getSandboxMode()
      .then((result: { mode?: string }) => {
        const mode = result.mode;
        if (cancelled) return;
        if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') {
          setSandboxMode(mode);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSandboxMode(DEFAULT_CODEX_SANDBOX_MODE);
        }
      });

    const handleSandboxModeChanged = (event: Event) => {
      const mode = (event as CustomEvent<{ mode?: CodexSandboxMode }>).detail?.mode;
      if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') {
        setSandboxMode(mode);
      }
    };

    window.addEventListener(CODEX_SANDBOX_MODE_CHANGED_EVENT, handleSandboxModeChanged as EventListener);

    return () => {
      cancelled = true;
      window.removeEventListener(CODEX_SANDBOX_MODE_CHANGED_EVENT, handleSandboxModeChanged as EventListener);
    };
  }, [isTerminal]);
  const [isWide, setIsWide] = useState(false);
  const [showSendButtonPulse, setShowSendButtonPulse] = useState(false);
  const isVoiceReactive = isSpeechDetected || isPushToTalkHeld;
  const isVoiceWorking = isVoiceReactive || isPushToTalkFinishing;

  useImperativeHandle(forwardedRef, () => ({
    focus: () => composerRef.current?.focus(),
    insertText: (text: string) => composerRef.current?.insertText(text),
    setContent: (text: string) => composerRef.current?.setContent(text),
    setPreviewText: (text: string | null) => composerRef.current?.setPreviewText(text),
    getContent: () => composerRef.current?.getContent() ?? '',
    getSubmission: () => composerRef.current?.getSubmission() ?? EMPTY_COMPOSER_SUBMISSION,
    clearContent: () => composerRef.current?.clearContent(),
    setContentWithTokenFlash: (text: string, ranges: Array<{ start: number; end: number }>) => composerRef.current?.setContentWithTokenFlash(text, ranges),
  }), []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      setIsWide((entries[0]?.contentRect.width ?? 0) >= WIDE_BREAKPOINT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!showFirstStartupNudge) return;
    const text = t('newTab.firstPromptNudge');
    let i = 0;
    let feedbackPulseTimeout: ReturnType<typeof setTimeout> | null = null;
    const interval = setInterval(() => {
      if (i < text.length) {
        composerRef.current?.setContent(text.slice(0, i + 1));
        i++;
      } else {
        clearInterval(interval);
        setShowSendButtonPulse(true);
        feedbackPulseTimeout = setTimeout(() => {
          window.dispatchEvent(new CustomEvent('feedback-button:flash'));
        }, 20_000);
      }
    }, 40);
    return () => {
      clearInterval(interval);
      if (feedbackPulseTimeout) {
        clearTimeout(feedbackPulseTimeout);
      }
    };
  }, [showFirstStartupNudge]);

  const refocusComposer = useCallback(() => {
    composerRef.current?.focus();
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
    setTimeout(() => {
      composerRef.current?.focus();
    }, 100);
  }, []);

  const flashComposer = useCallback(() => {
    setShowFlash(true);
    setTimeout(() => setShowFlash(false), 300);
  }, []);

  const restoreTextToComposer = useCallback((text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      refocusComposer();
      return;
    }

    const currentText = composerRef.current?.getContent() ?? '';
    if (!currentText.trim()) {
      composerRef.current?.setContent(trimmedText);
    } else if (!currentText.includes(trimmedText)) {
      const separator = currentText.endsWith('\n') ? '' : '\n\n';
      composerRef.current?.setContent(`${currentText}${separator}${trimmedText}`);
    }

    flashComposer();
    refocusComposer();
  }, [flashComposer, refocusComposer]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (isTerminal || !agentId) return;
    window.dispatchEvent(new CustomEvent(VOICE_MODE_CHANGED_EVENT, {
      detail: { agentId, isActive: isVoiceModeActive },
    }));
  }, [agentId, isTerminal, isVoiceModeActive]);

  useEffect(() => {
    const handleTtsPlaybackState = (event: Event) => {
      const detail = (event as CustomEvent<{ isSpeaking?: unknown }>).detail;
      isAssistantTtsPlayingRef.current = detail?.isSpeaking === true;
    };

    window.addEventListener(ASSISTANT_TTS_PLAYBACK_STATE_EVENT, handleTtsPlaybackState as EventListener);
    return () => {
      window.removeEventListener(ASSISTANT_TTS_PLAYBACK_STATE_EVENT, handleTtsPlaybackState as EventListener);
    };
  }, []);

  const applySttSettings = useCallback((nextSettings: SttSettings) => {
    sttSettingsRef.current = nextSettings;
    setSttSettingsForUi(nextSettings);
  }, []);

  useEffect(() => {
    let canceled = false;

    void stt.getSettings()
      .then((response: { settings: SttSettings }) => {
        if (canceled) return;
        applySttSettings(response.settings);
      })
      .catch((error: unknown) => {
        console.error('[VoiceMode] Failed to load STT settings:', error);
      });

    const unsubscribe = stt.onSettingsChanged((event: { settings: SttSettings }) => {
      applySttSettings(event.settings);
    });

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [applySttSettings]);

  const loadVoiceModelRequirement = useCallback(async (): Promise<VoiceModelRequirementStatus | null> => {
    if (!window.electron?.voiceExtension?.checkInstalled) {
      return null;
    }

    try {
      const [sttSettingsResponse, ttsSettingsResponse, ttsModelsResponse] = await Promise.all([
        stt.getSettings(),
        tts.getSettings(),
        tts.listModels(),
      ]);

      const sttBackend = resolveManagedSttBackend(sttSettingsResponse.settings.backend);
      const platform = getRuntimeSystemInfo().platform;
      const sttInstallRequired = platform === 'win32' || sttBackend === 'qwen';
      const sttDownloadBytes = sttInstallRequired ? getSttDownloadSizeBytes(sttBackend) : 0;
      const sttInstalled = sttInstallRequired
        ? (await window.electron.voiceExtension.checkInstalled({ backend: sttBackend })).installed
        : true;

      const ttsInstallRequired = ttsSettingsResponse.settings.readAssistantMessages === true;
      const selectedModelId = ttsSettingsResponse.settings.modelId;
      const selectedModel = getTtsModelById(selectedModelId) ?? getTtsModelById(DEFAULT_TTS_MODEL_ID);
      const actualTtsInstalled = Array.isArray(ttsModelsResponse.models)
        ? ttsModelsResponse.models.some((model: { id: TtsModelId; installed?: boolean }) => (
          model.id === selectedModelId && model.installed === true
        ))
        : false;
      const ttsInstalled = ttsInstallRequired ? actualTtsInstalled : true;
      const ttsDownloadBytes = ttsInstallRequired ? (selectedModel?.downloadBytes ?? 0) : 0;

      return {
        sttBackend,
        sttInstallRequired,
        sttInstalled,
        ttsInstallRequired,
        ttsInstalled,
        ttsModelId: selectedModel?.id ?? DEFAULT_TTS_MODEL_ID,
        sttDownloadBytes,
        ttsDownloadBytes,
      };
    } catch (error) {
      console.error('[VoiceMode] Failed to check voice model requirements:', error);
      return null;
    }
  }, []);

  const closeVoiceModelsModal = useCallback(() => {
    if (isVoiceModelInstallPending) {
      return;
    }
    setIsVoiceModelsModalOpen(false);
    if (pendingVoiceModeRef.current !== undefined) {
      isVoiceModeStartWaitingForInstallRef.current = false;
      setIsVoiceModeStarting(false);
    }
    pendingVoiceModeRef.current = undefined;
    pendingManualTtsPlaybackRef.current = null;
  }, [isVoiceModelInstallPending]);

  const enqueueManualTtsPlayback = useCallback((request: AssistantTtsManualPlayRequestDetail) => {
    window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));
    request.sentences.forEach((sentence, sentenceIndex) => {
      const detail: AssistantTtsSentenceEnqueueDetail = {
        text: sentence,
        messageId: request.messageId,
        sentenceIndex,
        source: 'manual',
      };
      window.dispatchEvent(
        new CustomEvent<AssistantTtsSentenceEnqueueDetail>(ASSISTANT_TTS_ENQUEUE_EVENT, { detail }),
      );
    });
  }, []);

  const openManualTtsInstallModal = useCallback(async (request: AssistantTtsManualPlayRequestDetail) => {
    try {
      const [sttSettingsResponse, ttsModelsResponse] = await Promise.all([
        stt.getSettings(),
        tts.listModels(),
      ]);
      const selectedModel = getTtsModelById(request.modelId as TtsModelId)
        ?? getTtsModelById(DEFAULT_TTS_MODEL_ID);
      const isInstalled = Array.isArray(ttsModelsResponse.models)
        ? ttsModelsResponse.models.some((model: { id: TtsModelId; installed?: boolean }) => (
          model.id === request.modelId && model.installed === true
        ))
        : false;

      if (isInstalled) {
        enqueueManualTtsPlayback(request);
        return;
      }

      pendingManualTtsPlaybackRef.current = request;
      pendingVoiceModeRef.current = undefined;
      setVoiceModelRequirement({
        sttBackend: resolveManagedSttBackend(sttSettingsResponse.settings.backend),
        sttInstallRequired: false,
        sttInstalled: true,
        ttsInstallRequired: true,
        ttsInstalled: false,
        ttsModelId: selectedModel?.id ?? DEFAULT_TTS_MODEL_ID,
        sttDownloadBytes: 0,
        ttsDownloadBytes: selectedModel?.downloadBytes ?? 0,
      });
      setIsVoiceModelsModalOpen(true);
    } catch (error) {
      const errorMessage = describeVoiceError(error, 'Failed to prepare TTS model download.');
      console.error('[VoiceMode] Failed to prepare manual TTS playback:', error);
      showToast(errorMessage, 'error', 8000);
    }
  }, [enqueueManualTtsPlayback, showToast]);

  useEffect(() => {
    const handleManualTtsPlayRequest = (event: Event) => {
      const detail = (event as CustomEvent<AssistantTtsManualPlayRequestDetail>).detail;
      if (!shouldHandleManualTtsPlayRequest({ composerAgentId: agentId, request: detail })) {
        return;
      }
      void openManualTtsInstallModal(detail);
    };

    window.addEventListener(
      ASSISTANT_TTS_MANUAL_PLAY_REQUEST_EVENT,
      handleManualTtsPlayRequest as EventListener,
    );
    return () => {
      window.removeEventListener(
        ASSISTANT_TTS_MANUAL_PLAY_REQUEST_EVENT,
        handleManualTtsPlayRequest as EventListener,
      );
    };
  }, [agentId, openManualTtsInstallModal]);

  const pendingInputs = useSyncExternalStore(
    subscribeAgentPendingInputs,
    () => getAgentPendingInputs(agentId),
    () => getAgentPendingInputs(agentId),
  );
  const hasQueue = pendingInputs.length > 0;

  const buildComposerMessageText = useCallback((text: string): {
    messageText: string;
    contextSnapshot: AgentPendingInput['contextSnapshot'];
  } => {
    if (!layout?.getWorkstationContext || !agentId || !isContextEnabled(agentId)) {
      return {
        messageText: text,
        contextSnapshot: null,
      };
    }

    const currentContext = layout.getWorkstationContext();
    const baselineContext = getLatestPendingInputContextSnapshot(agentId)
      ?? getLastSentContext(agentId);
    const diff = calculateContextDiff(baselineContext, currentContext);
    const contextPrefix = diff.hasChanges ? formatContextDiffForMessage(diff) : '';

    return {
      messageText: contextPrefix ? `${contextPrefix}\n\n${text}` : text,
      contextSnapshot: currentContext,
    };
  }, [agentId, layout]);

  const commitContextSnapshot = useCallback((contextSnapshot: AgentPendingInput['contextSnapshot']) => {
    if (!agentId) return;
    setLastSentContext(agentId, contextSnapshot);
    // NOTE(victor): removeAllRanges() destroys contenteditable caret -- redundant with clearSelection() below
    // window.getSelection()?.removeAllRanges();
    // Clear any unified selection (files, etc.)
    layout?.clearSelection();
  }, [agentId, layout]);

  const findExistingWorkspacePickerPath = useCallback(async (
    candidatePath?: string | null,
  ): Promise<string | undefined> => {
    let currentPath = candidatePath ?? windowWorkspacePath ?? null;

    while (currentPath) {
      try {
        const result = await files.isDirectory(currentPath);
        if (result.isDirectory) {
          return currentPath;
        }
      } catch {
        // Keep walking upward until we find a usable directory or hit the root.
      }

      const parentPath = pathDirname(currentPath);
      if (!parentPath || parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }

    return undefined;
  }, [windowWorkspacePath]);

  const promptForWorkspacePath = useCallback(async (
    title: string,
    candidatePath?: string | null,
  ): Promise<string | null> => {
    if (!onWorkspacePathChange) {
      return null;
    }

    const defaultPath = await findExistingWorkspacePickerPath(candidatePath);
    const result = await openPathDialog({
      type: 'folder',
      defaultPath,
      title,
    });
    const nextWorkspacePath = result.filePaths[0];

    refocusComposer();

    if (result.canceled || !nextWorkspacePath) {
      return null;
    }

    onWorkspacePathChange(nextWorkspacePath);
    return nextWorkspacePath;
  }, [findExistingWorkspacePickerPath, onWorkspacePathChange, refocusComposer]);

  const ensureAgentWorkspaceReady = useCallback(async (): Promise<{
    ok: true;
    workspacePath: string;
  } | {
    ok: false;
  }> => {
    try {
      const nextWorkspacePath = getEffectiveComposerWorkspacePath({
        workspacePath,
        windowWorkspacePath,
      });

      if (!nextWorkspacePath) {
        showToast('Choose a folder before sending.', 'error', 6000);
        const selectedWorkspacePath = await promptForWorkspacePath('Select agent folder');
        if (!selectedWorkspacePath) {
          return { ok: false };
        }
        return { ok: true, workspacePath: selectedWorkspacePath };
      }

      try {
        const result = await files.isDirectory(nextWorkspacePath);
        if (result.isDirectory) {
          return { ok: true, workspacePath: nextWorkspacePath };
        }
      } catch {
        // Fall through to the same recovery flow as a missing directory.
      }

      showToast('The selected folder no longer exists. Pick a new folder to continue.', 'error', 7000);
      const selectedWorkspacePath = await promptForWorkspacePath('Select agent folder', nextWorkspacePath);
      if (!selectedWorkspacePath) {
        return { ok: false };
      }
      return { ok: true, workspacePath: selectedWorkspacePath };
    } catch (error) {
      console.error('[ComposerArea] Failed to resolve workspace before send', {
        agentId,
        error,
      });
      showToast('Failed to verify the selected folder. Pick a folder and try again.', 'error', 7000);
      return { ok: false };
    }
  }, [agentId, promptForWorkspacePath, showToast, windowWorkspacePath, workspacePath]);

  // Resize handlers
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = composerContainerRef.current;
    if (!container) return;

    const currentHeight = container.offsetHeight;
    dragStartRef.current = {
      y: e.clientY,
      height: currentHeight,
      naturalHeight: composerHeight === null ? currentHeight : dragStartRef.current?.naturalHeight ?? currentHeight,
    };
    setIsDragging(true);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [composerHeight]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const deltaY = dragStartRef.current.y - e.clientY;
      const newHeight = dragStartRef.current.height + deltaY;

      if (newHeight <= dragStartRef.current.naturalHeight) {
        setComposerHeight(null);
      } else {
        setComposerHeight(Math.min(400, newHeight));
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Handle pending prompt from layout
  const processedPromptRef = useRef<string | null>(null);

  const resolveSubmission = useCallback((
    text?: string,
    submission?: SerializedComposerSubmission,
  ): SerializedComposerSubmission => {
    if (submission) {
      return submission;
    }
    if (typeof text === 'string') {
      return {
        text,
        attachments: [],
      };
    }
    return composerRef.current?.getSubmission() ?? EMPTY_COMPOSER_SUBMISSION;
  }, []);

  const resolveMessageSource = useCallback((
    submission: SerializedComposerSubmission,
    options?: ComposerSendOptions,
  ): MessageSendSource | null => (
    resolveComposerMessageSource({
      submission,
      explicitSource: options?.messageSource,
      pendingSource: pendingMessageSourceRef.current,
    })
  ), []);

  // Send handlers
  const handleSend = useCallback(async (
    text: string,
    submissionArg?: SerializedComposerSubmission,
    sendOptions?: ComposerSendOptions,
  ): Promise<boolean> => {
    const submission = resolveSubmission(text, submissionArg);
    if (!hasSubmissionContent(submission)) return false;

    try {
      if (isTerminal) {
        if (!submission.text.trim()) {
          return false;
        }
        onBeforeSend?.(submission.text);
        setShowSendButtonPulse(false);
        // Terminal mode: immediate send, no queuing
        onTerminalSend?.(submission.text);
      } else {
        const workspaceResult = await ensureAgentWorkspaceReady();
        if (!workspaceResult.ok) {
          return false;
        }

        onBeforeSend?.(submission.text);
        setShowSendButtonPulse(false);
        const messageSource = resolveMessageSource(submission, sendOptions);
        const { messageText, contextSnapshot } = buildComposerMessageText(submission.text);
        onAgentSend?.(messageText, {
          workspacePath: workspaceResult.workspacePath,
          attachments: submission.attachments,
          messageSource,
        });
        commitContextSnapshot(contextSnapshot);
      }

      pendingMessageSourceRef.current = null;

      // Keep keyboard flow in chat composers even when other UI updates run after send.
      refocusComposer();

      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('chat:scroll-to-bottom'));
      }, 50);
      return true;
    } catch (error) {
      console.error('[ComposerArea] Failed to send message', {
        agentId,
        error,
        isTerminal,
      });
      showToast('Failed to send message. Try again.', 'error', 7000);
      return false;
    }
  }, [
    agentId,
    buildComposerMessageText,
    commitContextSnapshot,
    ensureAgentWorkspaceReady,
    isTerminal,
    onAgentSend,
    onBeforeSend,
    onTerminalSend,
    refocusComposer,
    resolveMessageSource,
    resolveSubmission,
    showToast,
  ]);

  // Ref to access latest handleSend in pending prompt effect without re-triggering it
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  const clearMarketingDemoPlayback = useCallback(() => {
    for (const timerId of marketingDemoPlaybackTimersRef.current) {
      clearTimeout(timerId);
    }
    marketingDemoPlaybackTimersRef.current = [];
    setIsMarketingDemoPromptPlaying(false);
  }, []);

  useEffect(() => clearMarketingDemoPlayback, [clearMarketingDemoPlayback]);

  useEffect(() => {
    if (isTerminal || !showSuggestionChips) {
      onSuggestionOverlayHeightChange?.(0);
    }
  }, [isTerminal, onSuggestionOverlayHeightChange, showSuggestionChips]);

  const playMarketingDemoPrompt = useCallback((
    option: MarketingDemoPromptOption,
    messageSource?: MessageSendSource | null,
  ) => {
    if (!composerRef.current) {
      return;
    }

    clearMarketingDemoPlayback();
    setIsMarketingDemoPromptPlaying(true);
    composerRef.current.clearContent();
    composerRef.current.focus();

    let cumulativeDelayMs = 70;
    option.composeFrames.forEach((frame, index) => {
      const timerId = window.setTimeout(() => {
        composerRef.current?.setContent(frame);
        if (index === option.composeFrames.length - 1) {
          const sendTimerId = window.setTimeout(async () => {
            const sent = await handleSendRef.current(option.prompt, undefined, { messageSource });
            if (sent) {
              composerRef.current?.clearContent();
            } else {
              composerRef.current?.setContent(option.prompt);
            }
            setIsMarketingDemoPromptPlaying(false);
            marketingDemoPlaybackTimersRef.current = [];
          }, 140);
          marketingDemoPlaybackTimersRef.current.push(sendTimerId);
        }
      }, cumulativeDelayMs);
      marketingDemoPlaybackTimersRef.current.push(timerId);
      cumulativeDelayMs += index < 3 ? 70 : 45;
    });
  }, [clearMarketingDemoPlayback]);

  useEffect(() => {
    if (!marketingDemoMode || marketingDemoAutoplayPromptPlayedRef.current) {
      return;
    }

    const autoplayPromptId = getMarketingDemoAutoplayPromptId();
    if (!autoplayPromptId) {
      return;
    }

    const option = marketingDemoPromptOptionsById.current.get(autoplayPromptId);
    if (!option) {
      return;
    }

    marketingDemoAutoplayPromptPlayedRef.current = true;
    const timerId = window.setTimeout(() => {
      playMarketingDemoPrompt(option);
    }, 260);

    return () => window.clearTimeout(timerId);
  }, [marketingDemoMode, playMarketingDemoPrompt]);

  useEffect(() => {
    const prompt = layout?.pendingPrompt;
    if (!prompt) {
      processedPromptRef.current = null;
      return;
    }

    if (prompt !== processedPromptRef.current) {
      if (composerRef.current) {
        processedPromptRef.current = prompt;
        const shouldAutoSend = layout.pendingAutoSend;
        layout.setComposerPrompt(null);

        if (shouldAutoSend) {
          // Auto-send immediately without populating composer
          void handleSendRef.current(prompt).then((sent) => {
            if (!sent) {
              restoreTextToComposer(prompt);
            }
          });
        } else {
          composerRef.current.setContent(prompt);
          flashComposer();
        }
      }
    }
  }, [flashComposer, layout?.pendingPrompt, layout?.pendingAutoSend, layout?.setComposerPrompt, restoreTextToComposer]);

  useEffect(() => {
    if (isTerminal || !agentId) {
      return;
    }

    let retryTimerId: number | null = null;

    const applySeedComposerDetail = (detail: AgentSeedComposerDetail): boolean => {
      if (!detail || detail.agentId !== agentId || !detail.prompt.trim()) {
        return false;
      }

      if (detail.autoSend) {
        consumePendingAgentComposerSeed(detail.agentId);
        console.log(
          `[AgentComposerSeed] apply agentId=${detail.agentId} autoSend=true promptLen=${detail.prompt.length}`,
        );
        void handleSendRef.current(detail.prompt).then((sent) => {
          if (!sent) {
            restoreTextToComposer(detail.prompt);
          }
        });
        return true;
      }

      if (!composerRef.current) {
        return false;
      }

      composerRef.current.setContent(detail.prompt);
      const appliedPrompt = normalizeSeedPromptText(composerRef.current.getContent());
      if (appliedPrompt !== normalizeSeedPromptText(detail.prompt)) {
        return false;
      }
      consumePendingAgentComposerSeed(detail.agentId);
      composerRef.current.focus();
      flashComposer();
      return true;
    };

    const schedulePendingSeedRetry = () => {
      if (retryTimerId !== null) {
        return;
      }
      retryTimerId = window.setTimeout(() => {
        retryTimerId = null;
        const pendingSeed = peekPendingAgentComposerSeed(agentId);
        if (!pendingSeed) {
          return;
        }
        if (!applySeedComposerDetail(pendingSeed)) {
          schedulePendingSeedRetry();
        }
      }, 50);
    };

    const handleSeedComposer = (event: Event) => {
      const detail = (event as CustomEvent<AgentSeedComposerDetail>).detail;
      if (!applySeedComposerDetail(detail)) {
        schedulePendingSeedRetry();
      }
    };

    window.addEventListener(AGENT_SEED_COMPOSER_EVENT, handleSeedComposer as EventListener);
    const pendingSeed = peekPendingAgentComposerSeed(agentId);
    if (pendingSeed) {
      if (!applySeedComposerDetail(pendingSeed)) {
        schedulePendingSeedRetry();
      }
    }
    return () => {
      if (retryTimerId !== null) {
        window.clearTimeout(retryTimerId);
      }
      window.removeEventListener(AGENT_SEED_COMPOSER_EVENT, handleSeedComposer as EventListener);
    };
  }, [agentId, flashComposer, isTerminal, restoreTextToComposer]);

  const buildPendingInput = useCallback(async (
    submission: SerializedComposerSubmission,
    stage: AgentPendingInput['stage'],
    sendOptions?: ComposerSendOptions,
  ): Promise<AgentPendingInput | null> => {
    if (!agentId) {
      return null;
    }

    if (!hasSubmissionContent(submission)) {
      return null;
    }

    const validationError = getPendingInputValidationError(submission);
    if (validationError) {
      showToast(validationError, 'error', 7000);
      return null;
    }

    const workspaceResult = await ensureAgentWorkspaceReady();
    if (!workspaceResult.ok) {
      return null;
    }

    setShowSendButtonPulse(false);

    const messageSource = resolveMessageSource(submission, sendOptions);
    const { messageText, contextSnapshot } = buildComposerMessageText(submission.text);
    return {
      id: crypto.randomUUID(),
      agentId,
      draftText: submission.text,
      previewText: buildPendingPreviewText(submission),
      messageText,
      afterNextToolState: stage === 'afterNextTool' ? 'local' : null,
      submittedText: null,
      workspacePath: workspaceResult.workspacePath,
      contextSnapshot,
      messageSource,
      stage,
      createdAt: Date.now(),
    };
  }, [
    agentId,
    buildComposerMessageText,
    ensureAgentWorkspaceReady,
    resolveMessageSource,
    showToast,
  ]);

  const handleQueue = useCallback(async (
    textArg?: string,
    submissionArg?: SerializedComposerSubmission,
    sendOptions?: ComposerSendOptions,
  ): Promise<boolean> => {
    if (isTerminal) return false;

    const submission = resolveSubmission(textArg, submissionArg);
    if (!hasSubmissionContent(submission)) return false;

    try {
      const pendingInput = await buildPendingInput(submission, 'endOfTurn', sendOptions);
      if (!pendingInput) {
        return false;
      }

      addAgentPendingInput(pendingInput);
      pendingMessageSourceRef.current = null;
      if (!textArg) {
        composerRef.current?.clearContent();
      }
      refocusComposer();
      return true;
    } catch (error) {
      console.error('[ComposerArea] Failed to queue end-of-turn message', {
        agentId,
        error,
      });
      showToast('Failed to queue message. Try again.', 'error', 7000);
      return false;
    }
  }, [agentId, buildPendingInput, isTerminal, refocusComposer, resolveSubmission, showToast]);

  const handleSteer = useCallback(async (
    textArg?: string,
    submissionArg?: SerializedComposerSubmission,
    sendOptions?: ComposerSendOptions,
  ): Promise<boolean> => {
    if (isTerminal) return false;

    const submission = resolveSubmission(textArg, submissionArg);
    if (!hasSubmissionContent(submission)) return false;

    try {
      const pendingInput = await buildPendingInput(submission, 'afterNextTool', sendOptions);
      if (!pendingInput) {
        return false;
      }

      addAgentPendingInput(pendingInput);
      pendingMessageSourceRef.current = null;
      if (!textArg) {
        composerRef.current?.clearContent();
      }
      window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));
      window.dispatchEvent(new CustomEvent(AGENT_RUNTIME_STEER_EVENT, {
        detail: {
          tabId: agentId,
          pendingInputId: pendingInput.id,
        },
      }));
      refocusComposer();
      return true;
    } catch (error) {
      console.error('[ComposerArea] Failed to queue steer message', {
        agentId,
        error,
      });
      showToast('Failed to send message. Try again.', 'error', 7000);
      return false;
    }
  }, [agentId, buildPendingInput, isTerminal, refocusComposer, resolveSubmission, showToast]);

  const handleSendImmediate = useCallback(async (
    textArg?: string,
    submissionArg?: SerializedComposerSubmission,
    sendOptions?: ComposerSendOptions,
  ): Promise<boolean> => {
    if (isTerminal) return false;

    const submission = resolveSubmission(textArg, submissionArg);
    if (!hasSubmissionContent(submission)) return false;

    try {
      const pendingInput = await buildPendingInput(submission, 'interrupting', sendOptions);
      if (!pendingInput) {
        return false;
      }

      addAgentPendingInput(pendingInput);
      pendingMessageSourceRef.current = null;
      if (!textArg) {
        composerRef.current?.clearContent();
      }

      window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));

      if (agentId) {
        window.dispatchEvent(new CustomEvent('agent-runtime:cancel', {
          detail: { tabId: agentId },
        }));
      }

      refocusComposer();
      return true;
    } catch (error) {
      console.error('[ComposerArea] Failed to interrupt and send immediately', {
        agentId,
        error,
      });
      showToast('Failed to send message. Try again.', 'error', 7000);
      return false;
    }
  }, [agentId, buildPendingInput, isTerminal, refocusComposer, resolveSubmission, showToast]);

  // Stop current stream
  const handleStop = useCallback(async () => {
    if (isTerminal) return;

    window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));

    if (agentId) {
      window.dispatchEvent(new CustomEvent('agent-runtime:cancel', {
        detail: { tabId: agentId }
      }));
    }
  }, [isTerminal, agentId]);

  const resetVoiceRenderedText = useCallback(() => {
    voiceRenderedTextRef.current = '';
    setVoiceOverlayText('');
  }, []);

  const clearMoonshineSilenceTimeout = useCallback(() => {
    if (moonshineSilenceTimeoutRef.current) {
      clearTimeout(moonshineSilenceTimeoutRef.current);
      moonshineSilenceTimeoutRef.current = null;
    }
  }, []);

  const resetMoonshineDraft = useCallback(() => {
    moonshineCommittedTextRef.current = '';
    moonshinePartialTextRef.current = '';
  }, []);

  const clearVoicePreviewComposer = useCallback(() => {
    const currentComposerText = normalizeVoiceText(composerRef.current?.getContent() ?? '');
    if (!currentComposerText || currentComposerText === voiceRenderedTextRef.current) {
      composerRef.current?.clearContent();
    }
  }, [normalizeVoiceText]);

  const resetPushToTalkCaptureState = useCallback(() => {
    clearMoonshineSilenceTimeout();
    resetMoonshineDraft();
    resetVoiceRenderedText();
    clearVoicePreviewComposer();
    setIsSpeechDetected(false);
  }, [
    clearMoonshineSilenceTimeout,
    clearVoicePreviewComposer,
    resetMoonshineDraft,
    resetVoiceRenderedText,
  ]);

  const armPushToTalkCapture = useCallback(() => {
    resetPushToTalkCaptureState();
    setIsPushToTalkFinishing(false);

    if (shouldUseMoonshineVoiceBackend(sttSettingsRef.current.backend)) {
      isPushToTalkAwaitingSpeechStartRef.current = true;
      console.log('[VoiceMode] Push-to-talk armed backend="moonshine"');
      return;
    }

    isPushToTalkAwaitingSpeechStartRef.current = false;
    qwenStreamBridgeRef.current?.reset();
    console.log('[VoiceMode] Push-to-talk armed backend="qwen"');
  }, [resetPushToTalkCaptureState]);

  const combineMoonshineDraftText = useCallback((committedText: string, partialText: string) => {
    const committed = normalizeVoiceText(committedText);
    const partial = normalizeVoiceText(partialText);

    if (!committed) return partial;
    if (!partial) return committed;
    if (partial.startsWith(committed)) return partial;
    if (committed.startsWith(partial) || committed.endsWith(partial) || committed.includes(partial)) {
      return committed;
    }
    if (partial.includes(committed)) return partial;
    return `${committed} ${partial}`;
  }, [normalizeVoiceText]);

  const getChangedTokenRanges = useCallback((previousText: string, nextText: string) => {
    const previousTokens = previousText.match(/\S+/g) ?? [];
    const nextTokensWithIndex = Array.from(nextText.matchAll(/\S+/g)).map(match => ({
      token: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }));

    if (nextTokensWithIndex.length === 0) return [];

    let prefix = 0;
    while (
      prefix < previousTokens.length
      && prefix < nextTokensWithIndex.length
      && previousTokens[prefix] === nextTokensWithIndex[prefix]?.token
    ) {
      prefix += 1;
    }

    let previousSuffix = previousTokens.length - 1;
    let nextSuffix = nextTokensWithIndex.length - 1;
    while (
      previousSuffix >= prefix
      && nextSuffix >= prefix
      && previousTokens[previousSuffix] === nextTokensWithIndex[nextSuffix]?.token
    ) {
      previousSuffix -= 1;
      nextSuffix -= 1;
    }

    if (nextSuffix < prefix) return [];

    return nextTokensWithIndex
      .slice(prefix, nextSuffix + 1)
      .map(({ start, end }) => ({ start, end }));
  }, []);

  const waitForPreview = useCallback((durationMs: number) => {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }, []);

  /**
   * Check if a transcript ends with a voice command phrase.
   * Returns the command type and the text with the command stripped, or null.
   */
  const detectVoiceCommand = useCallback((text: string): { command: 'send' | 'newChat'; strippedText: string } | null => {
    const lower = text.toLowerCase().trim();
    const { sendCommand, newChatCommand } = sttSettingsRef.current;

    // Check newChatCommand first (more specific action)
    if (newChatCommand) {
      const cmd = newChatCommand.toLowerCase().trim();
      if (cmd && lower.endsWith(cmd)) {
        const stripped = text.slice(0, text.length - (text.length - text.trimEnd().length) - cmd.length).replace(/[\s,.!?]+$/, '').trim();
        return { command: 'newChat', strippedText: stripped };
      }
    }

    if (sendCommand) {
      const cmd = sendCommand.toLowerCase().trim();
      if (cmd && lower.endsWith(cmd)) {
        const stripped = text.slice(0, text.length - (text.length - text.trimEnd().length) - cmd.length).replace(/[\s,.!?]+$/, '').trim();
        return { command: 'send', strippedText: stripped };
      }
    }

    return null;
  }, []);

  const executeVoiceNewChat = useCallback(() => {
    resetVoiceRenderedText();
    composerRef.current?.clearContent();
    // Full reset: clear conversation and restart voice mode (same as TTS voice reset)
    if (agentId) {
      layout?.resetAgentTab(agentId, { autoStartVoiceMode: true });
    } else {
      window.dispatchEvent(new CustomEvent('sidebar:create-pinned-agent'));
    }
  }, [agentId, layout, resetVoiceRenderedText]);

  const submitVoiceText = useCallback(async (text: string): Promise<boolean> => {
    const sendBehavior = getVoiceSendBehavior({
      isStreaming: isStreamingRef.current,
      voiceMode: sttSettingsRef.current.voiceMode,
    });

    if (sendBehavior === 'interrupt') {
      return handleSendImmediate(text);
    }

    if (sendBehavior === 'steer') {
      return handleSteer(text);
    }

    return handleSend(text);
  }, [handleSend, handleSendImmediate, handleSteer]);

  const sanitizeVoiceTranscript = useCallback((text: string): string => {
    return sanitizeTranscriptForLanguage(
      text,
      i18n.resolvedLanguage ?? i18n.language,
      sttSettingsRef.current.stripChineseCharacters,
    );
  }, [i18n.language, i18n.resolvedLanguage]);

  const sendVoiceText = useCallback(async (text: string, backend: 'moonshine' | 'qwen') => {
    if (!isVoiceModeActiveRef.current) return;
    text = sanitizeVoiceTranscript(text);
    if (!text) return;

    // Check for voice commands (skip in ambient mode — already handled by ambient state machine)
    const sendMode = sttSettingsRef.current.voiceMode ?? 'conversational';
    const voiceCmd = sendMode !== 'ambient' ? detectVoiceCommand(text) : null;
    if (voiceCmd) {
      if (voiceCmd.command === 'newChat') {
        // Send any text before the command, then start new chat
        if (voiceCmd.strippedText) {
          const previousRendered = voiceRenderedTextRef.current;
          const changedRanges = getChangedTokenRanges(previousRendered, voiceCmd.strippedText);
          voiceRenderedTextRef.current = voiceCmd.strippedText;
          setVoiceOverlayText(voiceCmd.strippedText);
          composerRef.current?.setContentWithTokenFlash(voiceCmd.strippedText, changedRanges);
          await waitForPreview(sttSettingsRef.current.previewBeforeSendMs);
          if (!isVoiceModeActiveRef.current) return;
          // `new chat` replaces the tab immediately, so queued send paths would
          // be cleared with the old tab before the text could dispatch.
          const sent = await handleSend(voiceCmd.strippedText);
          if (!sent) {
            return;
          }
        }
        executeVoiceNewChat();
        return;
      }

      if (voiceCmd.command === 'send') {
        // Send with the command phrase stripped
        const finalText = voiceCmd.strippedText;
        if (!finalText) {
          resetVoiceRenderedText();
          composerRef.current?.clearContent();
          return;
        }
        text = finalText;
      }
    }

    const previousRendered = voiceRenderedTextRef.current;
    const changedRanges = getChangedTokenRanges(previousRendered, text);
    voiceRenderedTextRef.current = text;
    setVoiceOverlayText(text);
    emitVoiceLatencyEvent('voice-send-triggered', {
      surface: 'main-composer',
      backend,
      text,
    });
    composerRef.current?.setContentWithTokenFlash(text, changedRanges);
    await waitForPreview(sttSettingsRef.current.previewBeforeSendMs);

    if (!isVoiceModeActiveRef.current) return;

    const sent = await submitVoiceText(text);
    if (!sent) {
      return;
    }

    resetVoiceRenderedText();
    composerRef.current?.clearContent();
    composerRef.current?.focus();
  }, [
    detectVoiceCommand,
    executeVoiceNewChat,
    getChangedTokenRanges,
    handleSend,
    resetVoiceRenderedText,
    sanitizeVoiceTranscript,
    submitVoiceText,
    waitForPreview,
  ]);

  const syncMoonshineDraftPreview = useCallback(() => {
    const currentMode = sttSettingsRef.current.voiceMode ?? 'conversational';
    if (currentMode === 'push-to-talk' && !isPushToTalkHeldRef.current) {
      return;
    }

    const draftText = combineMoonshineDraftText(
      moonshineCommittedTextRef.current,
      moonshinePartialTextRef.current,
    );
    const normalizedDraft = sanitizeVoiceTranscript(draftText);
    const currentComposerText = normalizeVoiceText(composerRef.current?.getContent() ?? '');
    if (normalizedDraft === currentComposerText) return;

    // Check if interim text ends with a voice command — trigger immediately
    if (normalizedDraft) {
      const voiceCmd = detectVoiceCommand(normalizedDraft);
      if (voiceCmd && !isVoiceSendInFlightRef.current) {
        isVoiceSendInFlightRef.current = true;
        clearMoonshineSilenceTimeout();
        const textToSend = voiceCmd.strippedText;
        void sendVoiceText(textToSend || normalizedDraft, 'moonshine')
          .then(() => {
            if (voiceCmd.command === 'newChat') {
              executeVoiceNewChat();
            }
          })
          .finally(() => {
            isVoiceSendInFlightRef.current = false;
            resetMoonshineDraft();
          });
        return;
      }
    }

    const previousRendered = voiceRenderedTextRef.current;
    voiceRenderedTextRef.current = normalizedDraft;
    setVoiceOverlayText(normalizedDraft);
    if (!normalizedDraft) {
      composerRef.current?.clearContent();
      return;
    }

    const changedRanges = getChangedTokenRanges(previousRendered, normalizedDraft);
    emitVoiceLatencyEvent('composer-text-updated', {
      surface: 'main-composer',
      backend: 'moonshine',
      text: normalizedDraft,
    });
    composerRef.current?.setContentWithTokenFlash(normalizedDraft, changedRanges);
  }, [clearMoonshineSilenceTimeout, combineMoonshineDraftText, detectVoiceCommand, executeVoiceNewChat, getChangedTokenRanges, normalizeVoiceText, resetMoonshineDraft, sanitizeVoiceTranscript, sendVoiceText]);

  const previewVoiceText = useCallback((text: string) => {
    const normalized = sanitizeVoiceTranscript(text);
    if (!normalized) return;
    if (normalized === voiceRenderedTextRef.current) return;

    // Check if interim text ends with a voice command — trigger immediately.
    // Skip in ambient mode — ambient has its own end-phrase detection logic.
    const currentMode = sttSettingsRef.current.voiceMode ?? 'conversational';
    if (currentMode !== 'ambient') {
      const voiceCmd = detectVoiceCommand(normalized);
      if (voiceCmd && !isVoiceSendInFlightRef.current) {
        isVoiceSendInFlightRef.current = true;
        void sendVoiceText(voiceCmd.strippedText || normalized, 'qwen')
          .then(() => {
            if (voiceCmd.command === 'newChat') {
              executeVoiceNewChat();
            }
          })
          .finally(() => {
            isVoiceSendInFlightRef.current = false;
          });
        return;
      }
    }

    const previousRendered = voiceRenderedTextRef.current;
    const changedRanges = getChangedTokenRanges(previousRendered, normalized);
    voiceRenderedTextRef.current = normalized;
    setVoiceOverlayText(normalized);
    emitVoiceLatencyEvent('composer-text-updated', {
      surface: 'main-composer',
      backend: 'qwen',
      text: normalized,
    });
    composerRef.current?.setContentWithTokenFlash(normalized, changedRanges);
  }, [detectVoiceCommand, executeVoiceNewChat, getChangedTokenRanges, sanitizeVoiceTranscript, sendVoiceText]);

  const interruptAssistantForBargeIn = useCallback(() => {
    if (!isAssistantTtsPlayingRef.current) return;
    window.dispatchEvent(new CustomEvent(ASSISTANT_TTS_STOP_EVENT));
    if (!shouldCancelCurrentTurnForVoiceBargeIn(sttSettingsRef.current.voiceMode)) {
      return;
    }
    if (!isTerminal && agentId) {
      window.dispatchEvent(new CustomEvent('agent-runtime:cancel', {
        detail: { tabId: agentId },
      }));
    }
  }, [agentId, isTerminal]);

  const commitMoonshineDraft = useCallback(async () => {
    if (!isVoiceModeActiveRef.current || isVoiceSendInFlightRef.current) return;

    const text = sanitizeVoiceTranscript(
      combineMoonshineDraftText(
        moonshineCommittedTextRef.current,
        moonshinePartialTextRef.current,
      ),
    );
    if (!text) return;

    isVoiceSendInFlightRef.current = true;
    try {
      await sendVoiceText(text, 'moonshine');
    } finally {
      isVoiceSendInFlightRef.current = false;
      resetMoonshineDraft();
      clearMoonshineSilenceTimeout();
    }
  }, [clearMoonshineSilenceTimeout, combineMoonshineDraftText, resetMoonshineDraft, sanitizeVoiceTranscript, sendVoiceText]);

  const scheduleMoonshineSend = useCallback(() => {
    clearMoonshineSilenceTimeout();
    const draftText = sanitizeVoiceTranscript(
      combineMoonshineDraftText(
        moonshineCommittedTextRef.current,
        moonshinePartialTextRef.current,
      ),
    );
    const silenceTimeoutMs = getAdaptiveVoiceSilenceTimeoutMs(draftText, {
      silenceTimeoutMs: sttSettingsRef.current.silenceTimeoutMs,
      fastSentenceSilenceTimeoutMs: sttSettingsRef.current.fastSentenceSilenceTimeoutMs,
    });
    moonshineSilenceTimeoutRef.current = setTimeout(() => {
      void commitMoonshineDraft();
    }, silenceTimeoutMs);
  }, [clearMoonshineSilenceTimeout, combineMoonshineDraftText, commitMoonshineDraft, sanitizeVoiceTranscript]);

  const getVoiceTelemetryContext = useCallback((mode?: VoiceMode) => ({
    mode: mode ?? sttSettingsRef.current.voiceMode ?? 'conversational',
    backend: shouldUseMoonshineVoiceBackend(sttSettingsRef.current.backend) ? 'moonshine' as const : 'qwen' as const,
  }), []);

  const trackActiveVoiceModeStarted = useCallback((mode?: VoiceMode) => {
    const context = getVoiceTelemetryContext(mode);
    voiceModeSessionTelemetryRef.current = {
      startedAt: Date.now(),
      mode: context.mode,
      backend: context.backend,
    };
    trackVoiceModeStarted(context.mode, {
      backend: context.backend,
      surface: 'main_composer',
    });
  }, [getVoiceTelemetryContext]);

  const trackActiveVoiceModeStopped = useCallback(() => {
    const session = voiceModeSessionTelemetryRef.current;
    voiceModeSessionTelemetryRef.current = null;
    if (!session) {
      return;
    }

    trackVoiceModeStopped({
      mode: session.mode,
      backend: session.backend,
      durationMs: Math.max(0, Date.now() - session.startedAt),
      surface: 'main_composer',
    });
  }, []);

  const stopVoiceMode = useCallback(() => {
    trackActiveVoiceModeStopped();
    clearMoonshineSilenceTimeout();
    resetMoonshineDraft();
    resetVoiceRenderedText();
    isVoiceModeStartWaitingForInstallRef.current = false;
    isVoiceModeActiveRef.current = false;
    isPushToTalkHeldRef.current = false;
    isPushToTalkAwaitingSpeechStartRef.current = false;
    setIsPushToTalkHeld(false);
    setIsPushToTalkFinishing(false);

    const moonshineTranscriber = moonshineTranscriberRef.current;
    moonshineTranscriberRef.current = null;
    if (moonshineTranscriber) {
      try {
        moonshineTranscriber.stop();
      } catch (error) {
        console.error('[VoiceMode] Failed to stop moonshine transcriber:', error);
      }
    }

    const voiceSession = voiceCaptureSessionRef.current;
    voiceCaptureSessionRef.current = null;
    if (voiceSession) {
      try {
        voiceSession.stop();
      } catch (error) {
        console.error('[VoiceMode] Failed to stop voice capture:', error);
      }
    }

    const streamBridge = qwenStreamBridgeRef.current;
    qwenStreamBridgeRef.current = null;
    if (streamBridge) {
      streamBridge.abort();
    }

    const ambientNativeBridge = ambientNativeBridgeRef.current;
    ambientNativeBridgeRef.current = null;
    if (ambientNativeBridge) {
      ambientNativeBridge.abort();
    }

    if (ambientCycleTimerRef.current) {
      clearInterval(ambientCycleTimerRef.current);
      ambientCycleTimerRef.current = null;
    }

    if (!isMountedRef.current) return;
    setIsVoiceModeActive(false);
    setIsVoiceModeStarting(false);
    setIsSpeechDetected(false);
    setAmbientPhase('waiting');
  }, [clearMoonshineSilenceTimeout, resetMoonshineDraft, resetVoiceRenderedText, trackActiveVoiceModeStopped]);

  const setVoiceMode = useCallback(async (voiceMode: VoiceMode) => {
    if (sttSettingsRef.current.voiceMode === voiceMode) return;
    const telemetryContext = getVoiceTelemetryContext(voiceMode);
    if (voiceModeSessionTelemetryRef.current) {
      voiceModeSessionTelemetryRef.current = {
        ...voiceModeSessionTelemetryRef.current,
        mode: voiceMode,
      };
    }
    trackVoiceModeChanged(voiceMode, {
      backend: telemetryContext.backend,
      surface: 'main_composer',
    });
    applySttSettings({
      ...sttSettingsRef.current,
      voiceMode,
    });
    try {
      await stt.setSettings({ settings: { voiceMode } as Partial<SttSettings> });
    } catch (error) {
      console.error('[VoiceMode] Failed to update voice mode:', error);
    }
  }, [applySttSettings, getVoiceTelemetryContext]);

  const startVoiceMode = useCallback(async (
    requestedVoiceMode?: VoiceMode,
    options?: { resumeAfterInstall?: boolean },
  ) => {
    const resumeAfterInstall = options?.resumeAfterInstall === true;
    const resolvedVoiceMode = requestedVoiceMode ?? sttSettingsRef.current.voiceMode ?? 'conversational';
    if (isTerminal || isVoiceModeActiveRef.current || isVoiceModelInstallPending) return;
    if (isVoiceModeStarting && !resumeAfterInstall) return;

    setIsVoiceModeStarting(true);
    isVoiceModeStartWaitingForInstallRef.current = false;
    const selectedText = normalizeWindowVoiceSelectedText(window.getSelection()?.toString());

    try {
      const result = await interpreterOverlay.startWindowVoiceMode({ selectedText });
      if (!result.success) {
        showToast(result.error ?? 'Could not start Interpreter Overlay voice mode.', 'error', 8000);
      } else {
        emitVoiceLatencyEvent('overlay-window-voice-started', {
          surface: 'main-composer',
          selectedTextLength: selectedText?.length ?? 0,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`Could not start Interpreter Overlay voice mode. ${message}`, 'error', 8000);
    } finally {
      if (isMountedRef.current) {
        setIsVoiceModeStarting(false);
      }
    }
    return;

    if (!resumeAfterInstall) {
      const requirement = await loadVoiceModelRequirement();
      if (requirement !== null) {
        const currentRequirement = requirement!;
        const missingRequiredVoiceModel = !currentRequirement.sttInstalled || !currentRequirement.ttsInstalled;
        if (missingRequiredVoiceModel) {
          pendingVoiceModeRef.current = resolvedVoiceMode;
          isVoiceModeStartWaitingForInstallRef.current = true;
          setVoiceModelRequirement(currentRequirement);
          setIsVoiceModelsModalOpen(true);
          return;
        }
      }
    }

    const voiceModeStartAt = Date.now();
    const awaitMoonshineWarmupFloor = async () => {
      const remainingMs = MIN_MOONSHINE_VOICE_MODE_READY_MS - (Date.now() - voiceModeStartAt);
      if (remainingMs <= 0) return;
      console.log(`[VoiceMode] Delaying ready state for moonshine warmup by ${remainingMs}ms`);
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), remainingMs);
      });
    };
    const awaitQwenWarmupFloor = async () => {
      const remainingMs = MIN_QWEN_VOICE_MODE_READY_MS - (Date.now() - voiceModeStartAt);
      if (remainingMs <= 0) return;
      console.log(`[VoiceMode] Delaying ready state for qwen warmup by ${remainingMs}ms`);
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), remainingMs);
      });
    };

    setIsPushToTalkFinishing(false);
    clearMoonshineSilenceTimeout();
    resetMoonshineDraft();
    resetVoiceRenderedText();
    setIsSpeechDetected(false);

    try {
      if (!isMountedRef.current || isVoiceModeActiveRef.current) return;
      if (resolvedVoiceMode) {
        await setVoiceMode(resolvedVoiceMode);
      }
      if (!isMountedRef.current || isVoiceModeActiveRef.current) return;

      const activeVoiceMode = sttSettingsRef.current.voiceMode ?? resolvedVoiceMode;
      const currentVoiceMode = activeVoiceMode;
      const activeVoiceBackend: 'moonshine' | 'qwen' = shouldUseMoonshineVoiceBackend(sttSettingsRef.current.backend)
        ? 'moonshine'
        : 'qwen';
      let ambientState: 'waiting' | 'accumulating' = 'waiting';
      let ambientAccumulatedPreview = '';
      let ambientPendingSendText = '';
      const ambientTriggerPhrases = sttSettingsRef.current.ambientTriggerPhrases;
      const ambientEndPhrases = sttSettingsRef.current.ambientEndPhrases;
      const ambientPrimaryTriggerPhrase = getPrimaryAmbientPhrase(ambientTriggerPhrases, 'Interpreter');
      const ambientTriggerPattern = buildTolerantPhraseSetPattern(ambientTriggerPhrases);
      const ambientEndPattern = buildTolerantPhraseSetPattern(ambientEndPhrases);
      const logAmbientDecision = (
        reason: string,
        fields: Record<string, string | number | boolean | null | undefined>,
      ) => {
        const parts = Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
        console.log(`[AmbientVoice] ${reason}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`);
      };
      const logVoiceTimeline = (
        event: string,
        fields: Record<string, string | number | boolean | null | undefined> = {},
      ) => {
        const elapsedMs = Date.now() - voiceModeStartAt;
        const parts = Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
        console.log(`[VoiceTimeline] t=${elapsedMs}ms event=${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`);
      };
      const clearAmbientPreview = () => {
        resetVoiceRenderedText();
        composerRef.current?.clearContent();
      };
      const resetAmbientState = () => {
        ambientState = 'waiting';
        ambientAccumulatedPreview = '';
        setAmbientPhase('waiting');
        ambientPendingSendText = '';
      };
      const getAmbientPreviewText = (
        commandText: string,
        endAction: ReturnType<typeof resolveAmbientEndPhrase>,
      ): string => {
        if (endAction.type === 'send' || endAction.type === 'defer') {
          return endAction.finalText;
        }
        if (endAction.type === 'reset-empty') {
          return '';
        }
        return commandText;
      };
      const enterAmbientCommandPhase = (matchedTrigger: string, commandText: string) => {
        ambientState = 'accumulating';
        setAmbientPhase('accumulating');
        playSound('ambientTriggerDetected');
        interruptAssistantForBargeIn();
        logVoiceTimeline('ambient-trigger-detected', {
          matched: matchedTrigger,
          afterTrigger: truncateVoiceLogText(commandText),
        });
        logAmbientDecision('trigger-detected', {
          matched: matchedTrigger,
          afterTrigger: truncateVoiceLogText(commandText),
        });
      };
      let resetAmbientEngineState = () => {
        resetAmbientState();
      };
      const flushAmbientPendingSend = (): void => {
        if (!isVoiceModeActiveRef.current || isVoiceSendInFlightRef.current || !ambientPendingSendText) return;
        const pendingText = ambientPendingSendText;
        ambientPendingSendText = '';
        logAmbientDecision('pending-send-flushed', {
          finalText: truncateVoiceLogText(pendingText),
        });
        startAmbientSend(pendingText);
      };
      const startAmbientSend = (finalText: string): void => {
        resetAmbientEngineState();
        if (!finalText) {
          clearAmbientPreview();
          return;
        }

        logVoiceTimeline('ambient-send-started', {
          finalText: truncateVoiceLogText(finalText),
          backend: activeVoiceBackend,
        });
        isVoiceSendInFlightRef.current = true;
        void sendVoiceText(finalText, activeVoiceBackend).finally(() => {
          isVoiceSendInFlightRef.current = false;
          flushAmbientPendingSend();
        });
      };
      const handleAmbientTranscriptGate = (transcript: string, reason: string): void => {
        const normalized = sanitizeVoiceTranscript(transcript);
        if (!normalized) {
          return;
        }

        logAmbientDecision(reason, {
          phase: ambientState,
          transcript: truncateVoiceLogText(normalized),
        });

        const wasWaiting = ambientState === 'waiting';
        const triggerMatch = wasWaiting ? normalized.match(ambientTriggerPattern) : null;
        const gate = resolveAmbientTranscriptGate(
          normalized,
          ambientState,
          ambientTriggerPattern,
          ambientEndPattern,
          isVoiceSendInFlightRef.current,
        );

        if (wasWaiting) {
          if (!gate.triggerDetected) {
            return;
          }
          ambientAccumulatedPreview = gate.commandText;
          enterAmbientCommandPhase(triggerMatch?.[0] ?? ambientPrimaryTriggerPhrase, gate.commandText);
        }

        const effectiveCommandText = wasWaiting
          ? gate.commandText
          : gate.commandText
            ? (
              ambientAccumulatedPreview
                ? mergeStreamingVoiceTranscript(ambientAccumulatedPreview, gate.commandText)
                : gate.commandText
            )
            : ambientAccumulatedPreview;
        ambientAccumulatedPreview = effectiveCommandText;
        const effectiveEndAction = resolveAmbientEndPhrase(
          effectiveCommandText,
          ambientEndPattern,
          isVoiceSendInFlightRef.current,
        );

        const previewText = getAmbientPreviewText(effectiveCommandText, effectiveEndAction);
        if (previewText) {
          previewVoiceText(previewText);
        }

        if (effectiveEndAction.type === 'send') {
          logAmbientDecision('end-phrase-detected', {
            matched: effectiveEndAction.matchedPhrase,
            finalText: truncateVoiceLogText(effectiveEndAction.finalText),
            action: 'send',
          });
          startAmbientSend(effectiveEndAction.finalText);
        } else if (effectiveEndAction.type === 'defer') {
          ambientPendingSendText = effectiveEndAction.finalText;
          if (effectiveEndAction.finalText) {
            previewVoiceText(effectiveEndAction.finalText);
          }
          logAmbientDecision('end-phrase-detected', {
            matched: effectiveEndAction.matchedPhrase,
            finalText: truncateVoiceLogText(effectiveEndAction.finalText),
            action: 'defer',
          });
        } else if (effectiveEndAction.type === 'reset-empty') {
          logAmbientDecision('end-phrase-detected', {
            matched: effectiveEndAction.matchedPhrase,
            finalText: '',
            action: 'reset-empty',
          });
          resetAmbientEngineState();
          clearAmbientPreview();
        }
      };
      const handleAmbientCommittedSegment = (segmentText: string, reason: string): void => {
        const normalized = sanitizeVoiceTranscript(segmentText);
        if (!normalized) {
          return;
        }

        logAmbientDecision(reason, {
          phase: ambientState,
          transcript: truncateVoiceLogText(normalized),
        });

        let effectiveCommandText = ambientAccumulatedPreview;

        if (ambientState === 'waiting') {
          const triggerMatch = normalized.match(ambientTriggerPattern);
          const gate = resolveAmbientTranscriptGate(
            normalized,
            'waiting',
            ambientTriggerPattern,
            ambientEndPattern,
            isVoiceSendInFlightRef.current,
          );
          if (!gate.triggerDetected) {
            return;
          }
          effectiveCommandText = gate.commandText;
          ambientAccumulatedPreview = effectiveCommandText;
          enterAmbientCommandPhase(triggerMatch?.[0] ?? ambientPrimaryTriggerPhrase, gate.commandText);
        } else {
          effectiveCommandText = ambientAccumulatedPreview
            ? mergeStreamingVoiceTranscript(ambientAccumulatedPreview, normalized)
            : normalized;
          ambientAccumulatedPreview = effectiveCommandText;
        }

        const effectiveEndAction = resolveAmbientEndPhrase(
          effectiveCommandText,
          ambientEndPattern,
          isVoiceSendInFlightRef.current,
        );

        const previewText = getAmbientPreviewText(effectiveCommandText, effectiveEndAction);
        if (previewText) {
          previewVoiceText(previewText);
        }

        if (effectiveEndAction.type === 'send') {
          logAmbientDecision('end-phrase-detected', {
            matched: effectiveEndAction.matchedPhrase,
            finalText: truncateVoiceLogText(effectiveEndAction.finalText),
            action: 'send',
          });
          startAmbientSend(effectiveEndAction.finalText);
        } else if (effectiveEndAction.type === 'defer') {
          ambientPendingSendText = effectiveEndAction.finalText;
          if (effectiveEndAction.finalText) {
            previewVoiceText(effectiveEndAction.finalText);
          }
          logAmbientDecision('end-phrase-detected', {
            matched: effectiveEndAction.matchedPhrase,
            finalText: truncateVoiceLogText(effectiveEndAction.finalText),
            action: 'defer',
          });
        } else if (effectiveEndAction.type === 'reset-empty') {
          logAmbientDecision('end-phrase-detected', {
            matched: effectiveEndAction.matchedPhrase,
            finalText: '',
            action: 'reset-empty',
          });
          resetAmbientEngineState();
          clearAmbientPreview();
        }
      };

      if (currentVoiceMode === 'ambient') {
        logAmbientDecision('mode-started', {
          triggers: ambientTriggerPhrases.join(' | '),
          endPhrases: ambientEndPhrases.join(' | '),
          backend: activeVoiceBackend,
        });
        logVoiceTimeline('ambient-mode-started', {
          triggers: ambientTriggerPhrases.join(' | '),
          endPhrases: ambientEndPhrases.join(' | '),
          backend: activeVoiceBackend,
        });
      }

      if (shouldUseMoonshineVoiceBackend(sttSettingsRef.current.backend)) {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone capture is unavailable in this environment.');
        }
        if (!hasPrimedMoonshineMicrophoneRef.current) {
          await primeMicrophonePermission(
            (constraints) => navigator.mediaDevices.getUserMedia(constraints),
            MICROPHONE_CAPTURE_REQUEST,
          );
          hasPrimedMoonshineMicrophoneRef.current = true;
        }

        const moonshine = await loadMoonshineModule();
        if (!isMountedRef.current || isVoiceModeActiveRef.current) return;

        // NOTE(victor): Moonshine's start() resolves even when onError fires (e.g.
        // permission denied). Promise.race catches errors at ANY point during
        // start()+warmup, unlike manual checkpoints which only cover discrete moments.
        let rejectOnStartupError: (error: unknown) => void;
        const startupErrorSignal = new Promise<never>((_, reject) => {
          rejectOnStartupError = reject;
        });
        startupErrorSignal.catch(() => {});
        resetAmbientEngineState = () => {
          resetAmbientState();
          clearMoonshineSilenceTimeout();
          resetMoonshineDraft();
        };
        const useMoonshineVadMode = currentVoiceMode === 'ambient';

        const moonshineTranscriber = new moonshine.MicrophoneTranscriber(
          MOONSHINE_MODEL_NAME,
          {
            onModelLoadStarted: () => {
              logVoiceTimeline('moonshine-model-load-started');
            },
            onModelLoaded: () => {
              logVoiceTimeline('moonshine-model-loaded');
            },
            onTranscriptionUpdated: (text: string) => {
              if (!isVoiceModeActiveRef.current) return;
              const currentMode = sttSettingsRef.current.voiceMode ?? 'conversational';
              if (
                currentMode === 'push-to-talk'
                && (!isPushToTalkHeldRef.current || isPushToTalkAwaitingSpeechStartRef.current)
              ) {
                return;
              }
              moonshinePartialTextRef.current = sanitizeVoiceTranscript(text);
              if (currentMode === 'ambient') {
                if (useMoonshineVadMode) {
                  return;
                }
                handleAmbientTranscriptGate(
                  combineMoonshineDraftText(
                    moonshineCommittedTextRef.current,
                    moonshinePartialTextRef.current,
                  ),
                  'moonshine-transcript-updated',
                );
                return;
              }
              syncMoonshineDraftPreview();
            },
            onTranscriptionCommitted: (text: string) => {
              if (!isVoiceModeActiveRef.current) return;
              const currentMode = sttSettingsRef.current.voiceMode ?? 'conversational';
              if (
                currentMode === 'push-to-talk'
                && (!isPushToTalkHeldRef.current || isPushToTalkAwaitingSpeechStartRef.current)
              ) {
                return;
              }
              const committedText = sanitizeVoiceTranscript(text);
              if (!committedText) return;

              const previousCommitted = sanitizeVoiceTranscript(moonshineCommittedTextRef.current);
              if (!previousCommitted) {
                moonshineCommittedTextRef.current = committedText;
              } else if (committedText.startsWith(previousCommitted)) {
                moonshineCommittedTextRef.current = committedText;
              } else if (previousCommitted.startsWith(committedText)) {
                moonshineCommittedTextRef.current = previousCommitted;
              } else {
                moonshineCommittedTextRef.current = sanitizeVoiceTranscript(`${previousCommitted} ${committedText}`);
              }

              moonshinePartialTextRef.current = '';
              if (currentMode === 'ambient') {
                handleAmbientCommittedSegment(
                  committedText,
                  'moonshine-transcript-committed',
                );
                return;
              }
              syncMoonshineDraftPreview();
            },
            onSpeechStart: () => {
              const currentMode = sttSettingsRef.current.voiceMode ?? 'conversational';
              if (currentMode === 'push-to-talk') {
                if (!isPushToTalkHeldRef.current) {
                  return;
                }
                if (isPushToTalkAwaitingSpeechStartRef.current) {
                  isPushToTalkAwaitingSpeechStartRef.current = false;
                  resetPushToTalkCaptureState();
                  console.log('[VoiceMode] Push-to-talk speech window opened');
                }
              }
              clearMoonshineSilenceTimeout();
              setIsSpeechDetected(true);
              logVoiceTimeline('vad-speech-start', {
                mode: currentMode,
                phase: currentMode === 'ambient' ? ambientState : null,
              });
              if (currentMode === 'ambient') {
                return;
              }
              interruptAssistantForBargeIn();
            },
            onSpeechEnd: () => {
              const currentMode = sttSettingsRef.current.voiceMode ?? 'conversational';
              setIsSpeechDetected(false);
              logVoiceTimeline('vad-speech-end', {
                mode: currentMode,
                phase: currentMode === 'ambient' ? ambientState : null,
              });
              if (currentMode === 'push-to-talk') {
                return;
              }
              if (currentMode === 'ambient') {
                return;
              }
              scheduleMoonshineSend();
            },
            onError: (error: unknown) => {
              if (!isVoiceModeActiveRef.current) {
                rejectOnStartupError(error);
                return;
              }
              console.error('[VoiceMode] Moonshine error:', error);
              showToast('Voice transcription failed. Restart voice mode.', 'error', 5000);
              stopVoiceMode();
            },
          },
          useMoonshineVadMode ? true : false,
        );

        try {
          await Promise.race([
            (async () => {
              // Preload Moonshine before opening the microphone so Windows fake-audio
              // tests do not finish playback before VAD is attached to the stream.
              await moonshineTranscriber.load();
              await moonshineTranscriber.start();
              await awaitMoonshineWarmupFloor();
            })(),
            startupErrorSignal,
          ]);
        } catch (error) {
          if (isLikelyMicrophonePermissionError(error)) {
            hasPrimedMoonshineMicrophoneRef.current = false;
          }
          moonshineTranscriber.stop();
          throw error;
        }
        if (!isMountedRef.current || isVoiceModeActiveRef.current) {
          moonshineTranscriber.stop();
          return;
        }

        moonshineTranscriberRef.current = moonshineTranscriber;
        isVoiceModeActiveRef.current = true;

        if (!isMountedRef.current) return;
        setIsVoiceModeActive(true);
        trackActiveVoiceModeStarted(activeVoiceMode);
        emitVoiceLatencyEvent('voice-mode-started', {
          surface: 'main-composer',
          backend: 'moonshine',
        });
        return;
      }

      // On macOS ambient mode, use SFSpeechRecognizer only as a fast detector
      // for the wake word / end phrase. qwen_asr remains authoritative for the
      // actual command transcript once ambient capture is active.
      const useNativeAmbientDetector = activeVoiceMode === 'ambient' && getRuntimeSystemInfo().platform === 'darwin';
      const useAmbientCycling = activeVoiceMode === 'ambient' && !useNativeAmbientDetector;

      const voiceBridgeErrorHandler = (error: unknown) => {
        console.error('[VoiceMode] Stream bridge error (session may have died):', error);
        showToast('Voice transcription connection lost. Reconnecting...', 'error', 3000);
      };

      const createQwenStreamBridge = () => new QwenVoiceStreamBridge(voiceBridgeErrorHandler);
      const createAmbientNativeBridge = () => new QwenVoiceStreamBridge(
        voiceBridgeErrorHandler,
        { nativeRecognizer: true },
      );

      if (useNativeAmbientDetector) {
        const nativeBridge = createAmbientNativeBridge();
        ambientNativeBridgeRef.current = nativeBridge;
        await nativeBridge.ensureSession();

        const qwenBridge = createQwenStreamBridge();
        qwenStreamBridgeRef.current = qwenBridge;
        const qwenSessionId = await qwenBridge.ensureSession();
        await warmVoiceStreamSession(qwenSessionId);
      } else {
        const streamBridge = createQwenStreamBridge();
        qwenStreamBridgeRef.current = streamBridge;
        const sessionId = await streamBridge.ensureSession();
        await warmVoiceStreamSession(sessionId);
        await awaitQwenWarmupFloor();
      }
      if (!isMountedRef.current || isVoiceModeActiveRef.current) {
        const streamBridge = qwenStreamBridgeRef.current;
        qwenStreamBridgeRef.current = null;
        streamBridge?.abort();

        const nativeBridge = ambientNativeBridgeRef.current;
        ambientNativeBridgeRef.current = null;
        nativeBridge?.abort();
        return;
      }

      // VAD-driven send logic.
      // Silero VAD (server-side) classifies each chunk as speech/silence.
      // On speech→silence transition, use adaptive silence timeout to send.
      let lastTranscriptText = '';
      let lastTranscriptChangeAt = 0;
      let wasSpeech = false;
      let silenceSendTimer: ReturnType<typeof setTimeout> | null = null;

      let lastAmbientDetectorLoggedText = '';
      let lastAmbientQwenLoggedText = '';
      // Non-macOS ambient cycling state: every 2s we force-finish qwen to get
      // transcript (qwen -S 1 drops isolated words in silence). Overlap in
      // waiting mode prevents trigger word from being split at cycle boundaries.
      let ambientCycleAccumulated = '';
      const AMBIENT_CYCLE_MS = 2000;
      const AMBIENT_OVERLAP_CHUNKS = 15; // 15 * 80ms = 1.2s overlap
      const AMBIENT_COMMAND_PREROLL_CHUNKS = 50; // 50 * 80ms = 4s preroll
      const ambientPcmRingBuffer: Uint8Array[] = [];
      let ambientCycleInProgress = false;

      const ensureQwenStreamBridge = (bridge: QwenVoiceStreamBridge): void => {
        void bridge.ensureSession().catch(() => {});
      };

      const replaceQwenStreamBridge = (abortPrevious = true) => {
        const previousBridge = qwenStreamBridgeRef.current;
        const nextBridge = createQwenStreamBridge();
        qwenStreamBridgeRef.current = nextBridge;
        if (abortPrevious) {
          previousBridge?.abort();
        }
        return nextBridge;
      };

      const replaceAmbientNativeBridge = (abortPrevious = true) => {
        const previousBridge = ambientNativeBridgeRef.current;
        const nextBridge = createAmbientNativeBridge();
        ambientNativeBridgeRef.current = nextBridge;
        if (abortPrevious) {
          previousBridge?.abort();
        }
        return nextBridge;
      };

      const clearSilenceSendTimer = () => {
        if (silenceSendTimer) {
          clearTimeout(silenceSendTimer);
          silenceSendTimer = null;
        }
      };

      function resetAmbientCycle(): void {
        ambientState = 'waiting';
        setAmbientPhase('waiting');
        ambientPendingSendText = '';
        ambientCycleAccumulated = '';
        lastTranscriptText = '';
        lastTranscriptChangeAt = 0;
        wasSpeech = false;
        lastAmbientDetectorLoggedText = '';
        lastAmbientQwenLoggedText = '';
        if (useNativeAmbientDetector) {
          const nextQwenBridge = replaceQwenStreamBridge();
          ensureQwenStreamBridge(nextQwenBridge);
          const nextNativeBridge = replaceAmbientNativeBridge();
          void nextNativeBridge.ensureSession().catch(() => {});
        } else {
          replaceQwenStreamBridge();
        }
      }
      resetAmbientEngineState = resetAmbientCycle;

      const handleAmbientQwenUpdate = (update: { transcript: string }): void => {
        if (!isVoiceModeActiveRef.current || ambientState !== 'accumulating') return;

        const commandText = extractAmbientCommandText(update.transcript, ambientTriggerPattern);
        if (!commandText) return;

        const endAction = resolveAmbientEndPhrase(commandText, ambientEndPattern, false);
        const previewText = endAction.type === 'send' || endAction.type === 'defer'
          ? endAction.finalText
          : endAction.type === 'reset-empty'
            ? ''
            : commandText;
        if (!previewText) return;

        if (previewText !== lastAmbientQwenLoggedText) {
          lastAmbientQwenLoggedText = previewText;
          logAmbientDecision('qwen-command-transcript', {
            transcript: truncateVoiceLogText(previewText),
          });
        }
        previewVoiceText(previewText);
      };

      const enqueueAmbientQwenChunk = (bridge: QwenVoiceStreamBridge, pcmChunk: Uint8Array): void => {
        void bridge.enqueueChunk(pcmChunk, (update) => {
          if (qwenStreamBridgeRef.current !== bridge) return;
          handleAmbientQwenUpdate(update);
        });
      };

      function startAmbientCommandCapture(): void {
        const bridge = qwenStreamBridgeRef.current;
        if (!bridge) return;
        bridge.reset();
        const bufferedChunks = ambientPcmRingBuffer.slice(-AMBIENT_COMMAND_PREROLL_CHUNKS);
        for (const chunk of bufferedChunks) {
          enqueueAmbientQwenChunk(bridge, chunk);
        }
      }

      function finishAmbientCommandFromQwen(nativePreviewText: string, matchedPhrase: string): void {
        const activeBridge = qwenStreamBridgeRef.current;
        if (!activeBridge) return;
        let ownsSendLock = false;
        if (!isVoiceSendInFlightRef.current) {
          isVoiceSendInFlightRef.current = true;
          ownsSendLock = true;
        }

        ambientState = 'waiting';
        setAmbientPhase('waiting');
        ambientPendingSendText = '';
        ambientCycleAccumulated = '';
        lastTranscriptText = '';
        lastTranscriptChangeAt = 0;
        wasSpeech = false;
        lastAmbientDetectorLoggedText = '';
        lastAmbientQwenLoggedText = '';

        const nextQwenBridge = replaceQwenStreamBridge(false);
        ensureQwenStreamBridge(nextQwenBridge);
        const nextNativeBridge = replaceAmbientNativeBridge();
        void nextNativeBridge.ensureSession().catch(() => {});
        const drainActiveBridge = activeBridge.waitForQueuedChunks();
        const sessionPromise = activeBridge.ensureSession();

        void (async () => {
          try {
            const sessionId = await sessionPromise;
            await drainActiveBridge;
            const finalTranscript = sanitizeVoiceTranscript(await finishVoiceStreamSession(sessionId));
            const { finalText, source: actionSource } = resolveAmbientCommandFinalText(
              finalTranscript,
              nativePreviewText,
              ambientTriggerPattern,
              ambientEndPattern,
            );

            if (!finalText) {
              logAmbientDecision('end-phrase-detected', {
                matched: matchedPhrase,
                finalText: '',
                action: 'reset-empty',
                source: actionSource,
              });
              resetVoiceRenderedText();
              composerRef.current?.clearContent();
              return;
            }

            if (!ownsSendLock && isVoiceSendInFlightRef.current) {
              ambientPendingSendText = finalText;
              previewVoiceText(finalText);
              logAmbientDecision('end-phrase-detected', {
                matched: matchedPhrase,
                finalText: truncateVoiceLogText(finalText),
                action: 'defer',
                source: actionSource,
              });
              return;
            }

            if (!ownsSendLock) {
              isVoiceSendInFlightRef.current = true;
              ownsSendLock = true;
            }

            logAmbientDecision('end-phrase-detected', {
              matched: matchedPhrase,
              finalText: truncateVoiceLogText(finalText),
              action: 'send',
              source: actionSource,
            });
            await sendVoiceText(finalText, 'qwen');
          } catch (error) {
            const errorMessage = describeVoiceError(error, 'Voice transcription failed while finishing ambient speech.');
            console.error('[AmbientVoice] Failed to finish qwen command capture:', errorMessage, error);
            showToast(`Voice transcription failed: ${errorMessage}`, 'error', 8000);
          } finally {
            if (ownsSendLock) {
              isVoiceSendInFlightRef.current = false;
              flushAmbientPendingSend();
            }
          }
        })();
      }

      // Non-macOS ambient: cycle qwen sessions every 2s to force transcript output.
      // qwen_asr doesn't reliably output isolated words surrounded by silence.
      async function cycleAmbientSession(): Promise<void> {
        if (ambientCycleInProgress || !isVoiceModeActiveRef.current) return;
        ambientCycleInProgress = true;
        try {
          const oldBridge = qwenStreamBridgeRef.current;
          if (!oldBridge) return;
          // Snapshot overlap chunks before swapping (waiting mode only —
          // prevents trigger word from being split at cycle boundaries)
          const overlapChunks = ambientState === 'waiting'
            ? ambientPcmRingBuffer.slice()
            : [];
          // Start new bridge immediately so new chunks go there
          const newBridge = replaceQwenStreamBridge(false);
          // Feed overlap PCM to new session
          for (const chunk of overlapChunks) {
            void newBridge.enqueueChunk(chunk, () => {});
          }
          let oldSessionId: string | null = null;
          try { oldSessionId = await oldBridge.ensureSession(); } catch { return; }
          await oldBridge.waitForQueuedChunks();
          const rawTranscript = sanitizeVoiceTranscript(await finishVoiceStreamSession(oldSessionId));
          if (!rawTranscript) return;
          logAmbientDecision('cycle-transcript', { phase: ambientState, transcript: truncateVoiceLogText(rawTranscript) });

          if (ambientState === 'waiting') {
            const triggerMatch = rawTranscript.match(ambientTriggerPattern);
            if (triggerMatch) {
              const afterTrigger = stripLeadingPunctuation(rawTranscript.slice(triggerMatch.index! + triggerMatch[0].length));
              enterAmbientCommandPhase(triggerMatch[0], afterTrigger);
              logAmbientDecision('cycle-trigger', { matched: triggerMatch[0], afterTrigger: truncateVoiceLogText(afterTrigger) });
              if (afterTrigger) {
                ambientCycleAccumulated = afterTrigger;
                previewVoiceText(afterTrigger);
                const endAction = resolveAmbientEndPhrase(afterTrigger, ambientEndPattern, isVoiceSendInFlightRef.current);
                if (endAction.type === 'send') { ambientCycleAccumulated = ''; startAmbientSend(endAction.finalText); }
                else if (endAction.type === 'reset-empty') { ambientCycleAccumulated = ''; resetAmbientCycle(); }
              }
            }
          }
          if (ambientState === 'accumulating') {
            const triggerMatch = rawTranscript.match(ambientTriggerPattern);
            const cycleText = triggerMatch
              ? stripLeadingPunctuation(rawTranscript.slice(triggerMatch.index! + triggerMatch[0].length))
              : rawTranscript.trim();
            if (cycleText) {
              ambientCycleAccumulated = ambientCycleAccumulated
                ? mergeStreamingVoiceTranscript(ambientCycleAccumulated, cycleText)
                : cycleText;
            }
            previewVoiceText(ambientCycleAccumulated);
            const endAction = resolveAmbientEndPhrase(ambientCycleAccumulated, ambientEndPattern, isVoiceSendInFlightRef.current);
            if (endAction.type === 'send') { ambientCycleAccumulated = ''; startAmbientSend(endAction.finalText); }
            else if (endAction.type === 'defer') { ambientPendingSendText = endAction.finalText; }
            else if (endAction.type === 'reset-empty') { ambientCycleAccumulated = ''; resetAmbientCycle(); }
          }
        } catch (error) {
          console.error('[AmbientVoice] Cycle failed:', error);
        } finally {
          ambientCycleInProgress = false;
        }
      }

      const doFinishAndSend = () => {
        if (!isVoiceModeActiveRef.current || isVoiceSendInFlightRef.current) return;
        const oldBridge = qwenStreamBridgeRef.current;
        if (!oldBridge) return;

        isVoiceSendInFlightRef.current = true;
        void (async () => {
          try {
            const { transcript } = await oldBridge.snapshotUtterance();
            if (!transcript) {
              isVoiceSendInFlightRef.current = false;
              return;
            }

            const sessionId = await oldBridge.ensureSession();

            // Switch to new bridge BEFORE finishing old session.
            // This prevents race: chunks arriving during finishVoiceStreamSession
            // would hit the dead session on the old bridge.
            replaceQwenStreamBridge(false);
            await oldBridge.waitForQueuedChunks();

            const finalTranscript = sanitizeVoiceTranscript(await finishVoiceStreamSession(sessionId));

            lastTranscriptText = '';
            lastTranscriptChangeAt = 0;
            wasSpeech = false;

            const textToSend = finalTranscript || transcript;
            if (!textToSend) return;

            await sendVoiceText(textToSend, 'qwen');
          } catch (error) {
            const errorMessage = describeVoiceError(error, 'Voice transcription failed while sending.');
            console.error('[VoiceMode] qwen_asr streaming transcription failed:', errorMessage, error);
            showToast(`Voice transcription failed: ${errorMessage}`, 'error', 8000);
          } finally {
            isVoiceSendInFlightRef.current = false;
          }
        })();
      };

      const scheduleAdaptiveSilenceSend = () => {
        if (wasSpeech || !isVoiceModeActiveRef.current) return;
        const transcriptAge = Date.now() - lastTranscriptChangeAt;
        const timeoutMs = getAdaptiveVoiceSilenceTimeoutMs(lastTranscriptText, {
          silenceTimeoutMs: sttSettingsRef.current.silenceTimeoutMs,
          fastSentenceSilenceTimeoutMs: sttSettingsRef.current.fastSentenceSilenceTimeoutMs,
        });
        const remaining = Math.max(0, timeoutMs - transcriptAge);
        silenceSendTimer = setTimeout(doFinishAndSend, remaining);
      };

      const tryScheduleSend = () => {
        clearSilenceSendTimer();
        if (!lastTranscriptText || isVoiceSendInFlightRef.current) return;

        // Use Smart Turn for semantic end-of-turn detection.
        // On speech→silence, ask Smart Turn if the user is done.
        // If done → send immediately. If not done → fall back to adaptive
        // silence timeout (never hang — always schedule a send eventually).
        const bridge = qwenStreamBridgeRef.current;
        if (bridge) {
          void (async () => {
            try {
              const sessionId = await bridge.ensureSession();
              const result = await checkEndOfTurn(sessionId);
              // If speech resumed while we were checking, abort
              if (wasSpeech || !isVoiceModeActiveRef.current) return;
              if (result.done) {
                // Smart Turn says turn is complete — send with short preview delay
                const previewMs = Math.min(sttSettingsRef.current.previewBeforeSendMs, 300);
                silenceSendTimer = setTimeout(doFinishAndSend, previewMs);
              } else {
                // Smart Turn says not done — fall back to adaptive silence timeout
                scheduleAdaptiveSilenceSend();
              }
            } catch {
              // Smart Turn failed — fall back to adaptive silence timeout
              scheduleAdaptiveSilenceSend();
            }
          })();
        }
      };

      const voiceSession = new QwenStreamingCaptureSession({
        onPcmChunk: (pcmChunk: Uint8Array) => {
          if (!isVoiceModeActiveRef.current) return;
          if (currentVoiceMode === 'push-to-talk' && !isPushToTalkHeldRef.current) return;

          if (currentVoiceMode === 'ambient') {
            ambientPcmRingBuffer.push(new Uint8Array(pcmChunk));
            const maxAmbientBufferChunks = useAmbientCycling
              ? AMBIENT_OVERLAP_CHUNKS
              : AMBIENT_COMMAND_PREROLL_CHUNKS;
            if (ambientPcmRingBuffer.length > maxAmbientBufferChunks) {
              ambientPcmRingBuffer.shift();
            }
          }

          if (useNativeAmbientDetector) {
            const nativeBridge = ambientNativeBridgeRef.current;
            if (!nativeBridge) return;

            void nativeBridge.enqueueChunk(pcmChunk, (update) => {
              if (!isVoiceModeActiveRef.current) return;
              if (ambientNativeBridgeRef.current !== nativeBridge) return;

              wasSpeech = update.isSpeech;
              setIsSpeechDetected(update.isSpeech);

              const normalized = sanitizeVoiceTranscript(update.transcript);
              if (normalized && normalized !== lastAmbientDetectorLoggedText) {
                lastAmbientDetectorLoggedText = normalized;
                logAmbientDecision('native-detector-transcript', {
                  phase: ambientState,
                  transcript: truncateVoiceLogText(normalized),
                });
              }

              if (ambientState === 'waiting') {
                const gate = resolveAmbientTranscriptGate(
                  normalized,
                  ambientState,
                  ambientTriggerPattern,
                  ambientEndPattern,
                  isVoiceSendInFlightRef.current,
                );
                const triggerMatch = gate.triggerDetected ? normalized.match(ambientTriggerPattern) : null;
                if (gate.triggerDetected) {
                  enterAmbientCommandPhase(triggerMatch?.[0] ?? ambientPrimaryTriggerPhrase, gate.commandText);
                  startAmbientCommandCapture();
                }
              }

              if (ambientState === 'accumulating') {
                const detectorFinishRequest = resolveAmbientDetectorFinishRequest(
                  normalized,
                  ambientTriggerPattern,
                  ambientEndPattern,
                  lastAmbientQwenLoggedText,
                );
                if (detectorFinishRequest) {
                  finishAmbientCommandFromQwen(
                    detectorFinishRequest.previewText,
                    detectorFinishRequest.matchedPhrase,
                  );
                }
              }
            });

            if (ambientState === 'accumulating') {
              const qwenBridge = qwenStreamBridgeRef.current;
              if (qwenBridge) {
                enqueueAmbientQwenChunk(qwenBridge, pcmChunk);
              }
            }
            return;
          }

          const bridge = qwenStreamBridgeRef.current;
          if (!bridge) return;

          void bridge.enqueueChunk(pcmChunk, (update) => {
            if (!isVoiceModeActiveRef.current) return;
            if (qwenStreamBridgeRef.current !== bridge) return;
            if (currentVoiceMode === 'push-to-talk' && !isPushToTalkHeldRef.current) {
              setIsSpeechDetected(false);
              return;
            }

            // Speech state transitions from Silero VAD
            // Skip for push-to-talk — the spacebar is the only signal there.
            if (currentVoiceMode !== 'push-to-talk') {
              if (update.isSpeech && !wasSpeech) {
                // Speech started
                if (currentVoiceMode !== 'ambient') {
                  interruptAssistantForBargeIn();
                }
                clearSilenceSendTimer();
              }
              if (!update.isSpeech && wasSpeech && lastTranscriptText) {
                // Speech ended AND we have transcript — schedule send
                if (currentVoiceMode === 'conversational') {
                  tryScheduleSend();
                }
              }
              wasSpeech = update.isSpeech;
              setIsSpeechDetected(update.isSpeech);
            }

            const normalized = sanitizeVoiceTranscript(update.transcript);
            if (normalized && normalized !== lastTranscriptText) {
              lastTranscriptText = normalized;
              lastTranscriptChangeAt = Date.now();
              // Transcript changed — reset send timer.
              // If we're in silence (speech already ended), re-schedule the
              // send so that late-arriving transcripts still trigger delivery.
              clearSilenceSendTimer();
              if (!wasSpeech && currentVoiceMode === 'conversational') {
                tryScheduleSend();
              }
            }

            // Mode-specific transcript handling
            if (currentVoiceMode === 'ambient') {
              if (normalized && normalized !== lastAmbientDetectorLoggedText) {
                lastAmbientDetectorLoggedText = normalized;
                handleAmbientTranscriptGate(normalized, 'transcript-updated');
              }
            } else {
              // Conversational mode — show transcript normally
              previewVoiceText(update.transcript);
            }
          });
        },
        onError: (error: unknown) => {
          const errorMessage = describeVoiceError(error, 'Could not capture microphone audio.');
          console.error('[VoiceMode] Voice capture error:', errorMessage, error);
          showToast(errorMessage, 'error', 8000);
          clearSilenceSendTimer();
          stopVoiceMode();
        },
      });

      voiceCaptureSessionRef.current = voiceSession;

      isVoiceModeActiveRef.current = true;
      await voiceSession.start();

      if (!isMountedRef.current) return;
      setIsVoiceModeActive(true);
      trackActiveVoiceModeStarted(activeVoiceMode);
      emitVoiceLatencyEvent('voice-mode-started', {
        surface: 'main-composer',
        backend: 'qwen',
      });

      // Non-macOS ambient: start cycling timer to force qwen transcript output
      if (useAmbientCycling) {
        ambientCycleTimerRef.current = setInterval(() => {
          void cycleAmbientSession();
        }, AMBIENT_CYCLE_MS);
      }

    } catch (error) {
      const errorMessage = describeVoiceError(error, 'Voice mode failed to start.');
      console.error('[VoiceMode] Failed to start:', errorMessage, error);
      const backendLabel = shouldUseMoonshineVoiceBackend(sttSettingsRef.current.backend) ? 'Moonshine' : 'qwen_asr';
      showToast(`Could not start voice mode. Check microphone permissions and ${backendLabel} setup. ${errorMessage}`, 'error', 8000);
      stopVoiceMode();
    } finally {
      if (isMountedRef.current && !isVoiceModeStartWaitingForInstallRef.current) {
        setIsVoiceModeStarting(false);
      }
    }
  }, [
    clearMoonshineSilenceTimeout,
    isVoiceModelInstallPending,
    isTerminal,
    isVoiceModeStarting,
    interruptAssistantForBargeIn,
    loadVoiceModelRequirement,
    normalizeVoiceText,
    resetMoonshineDraft,
    resetPushToTalkCaptureState,
    resetVoiceRenderedText,
    sanitizeVoiceTranscript,
    scheduleMoonshineSend,
    sendVoiceText,
    setVoiceMode,
    showToast,
    stopVoiceMode,
    syncMoonshineDraftPreview,
    trackActiveVoiceModeStarted,
    previewVoiceText,
  ]);

  const handleInstallVoiceModels = useCallback(async () => {
    if (!voiceModelRequirement || isVoiceModelInstallPending) {
      return;
    }

    const pendingVoiceMode = pendingVoiceModeRef.current;
    const pendingManualPlayback = pendingManualTtsPlaybackRef.current;
    setIsVoiceModelsModalOpen(false);
    setIsVoiceModelInstallPending(true);

    let installedSuccessfully = false;
    try {
      if (!voiceModelRequirement.sttInstalled && voiceModelRequirement.sttInstallRequired) {
        if (!window.electron?.voiceExtension?.install) {
          throw new Error('Voice extension installer is unavailable.');
        }
        const voiceInstallResult = await window.electron.voiceExtension.install({ backend: voiceModelRequirement.sttBackend });
        if (!voiceInstallResult.success) {
          throw new Error(voiceInstallResult.error || 'Voice model download failed.');
        }
        if (voiceModelRequirement.sttBackend === 'moonshine') {
          await warmMoonshineModel(MOONSHINE_MODEL_NAME);
        }
      }

      if (voiceModelRequirement.ttsInstallRequired && !voiceModelRequirement.ttsInstalled) {
        const ttsInstallResult = await tts.installModel({ modelId: voiceModelRequirement.ttsModelId });
        if (!ttsInstallResult.success) {
          throw new Error(ttsInstallResult.error || 'TTS model download failed.');
        }
      }

      installedSuccessfully = true;
      setVoiceModelRequirement((prev) => (prev ? { ...prev, sttInstalled: true, ttsInstalled: true } : prev));
    } catch (error) {
      const errorMessage = describeVoiceError(error, 'Voice model download failed.');
      console.error('[VoiceMode] Failed to install required voice models:', error);
      showToast(errorMessage, 'error', 8000);
    } finally {
      setIsVoiceModelInstallPending(false);
    }

    if (!installedSuccessfully) {
      if (pendingVoiceMode !== undefined) {
        isVoiceModeStartWaitingForInstallRef.current = false;
        setIsVoiceModeStarting(false);
      }
      return;
    }

    pendingVoiceModeRef.current = undefined;
    pendingManualTtsPlaybackRef.current = null;
    if (pendingManualPlayback) {
      isVoiceModeStartWaitingForInstallRef.current = false;
      setIsVoiceModeStarting(false);
      enqueueManualTtsPlayback(pendingManualPlayback);
      return;
    }
    if (pendingVoiceMode === undefined) {
      isVoiceModeStartWaitingForInstallRef.current = false;
      setIsVoiceModeStarting(false);
      return;
    }
    void startVoiceMode(pendingVoiceMode, { resumeAfterInstall: true });
  }, [
    enqueueManualTtsPlayback,
    isVoiceModelInstallPending,
    showToast,
    startVoiceMode,
    voiceModelRequirement,
  ]);

  useEffect(() => {
    if (isTerminal) return;
    if (!autoStartVoiceMode) return;
    if (hasAutoStartedVoiceRef.current) return;
    hasAutoStartedVoiceRef.current = true;
    onVoiceModeAutoStartConsumed?.();
    void startVoiceMode();
  }, [
    autoStartVoiceMode,
    isTerminal,
    onVoiceModeAutoStartConsumed,
    startVoiceMode,
  ]);

  // Push to Talk: spacebar hold/release
  useEffect(() => {
    if (!isVoiceModeActive) return;
    if (sttSettingsRef.current.voiceMode !== 'push-to-talk') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      // Don't intercept if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      armPushToTalkCapture();
      isPushToTalkHeldRef.current = true;
      setIsPushToTalkHeld(true);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      isPushToTalkHeldRef.current = false;
      isPushToTalkAwaitingSpeechStartRef.current = false;
      setIsPushToTalkHeld(false);
      setIsSpeechDetected(false);

      if (shouldUseMoonshineVoiceBackend(sttSettingsRef.current.backend)) {
        if (isVoiceSendInFlightRef.current) return;
        setIsPushToTalkFinishing(true);
        void commitMoonshineDraft().finally(() => {
          setIsPushToTalkFinishing(false);
        });
        return;
      }

      // Finish the ASR session, wait for qwen to fully transcribe, then send.
      const bridge = qwenStreamBridgeRef.current;
      if (!bridge || isVoiceSendInFlightRef.current) return;

      isVoiceSendInFlightRef.current = true;
      setIsPushToTalkFinishing(true);
      void (async () => {
        try {
          const sessionId = await bridge.ensureSession();
          await bridge.waitForQueuedChunks();
          const finalTranscript = sanitizeVoiceTranscript(await finishVoiceStreamSession(sessionId));

          qwenStreamBridgeRef.current = new QwenVoiceStreamBridge((error) => {
            console.error('[VoiceMode] Stream bridge error:', error);
            showToast('Voice transcription connection lost. Reconnecting...', 'error', 3000);
          });

          if (finalTranscript) {
            await sendVoiceText(finalTranscript, 'qwen');
          }

          // Start a fresh session for next push-to-talk
          void qwenStreamBridgeRef.current!.ensureSession().catch(() => {});
        } catch (error) {
          console.error('[VoiceMode] Push to talk send failed:', error);
          showToast('Voice transcription failed.', 'error', 5000);
        } finally {
          isVoiceSendInFlightRef.current = false;
          setIsPushToTalkFinishing(false);
        }
      })();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [armPushToTalkCapture, commitMoonshineDraft, isVoiceModeActive, sanitizeVoiceTranscript, sendVoiceText, showToast]);

  const handleEditPendingInput = useCallback((pendingInputId: string) => {
    if (!agentId) {
      return;
    }

    const pendingInput = removeAgentPendingInput(agentId, pendingInputId);
    if (!pendingInput) {
      return;
    }

    pendingMessageSourceRef.current = pendingInput.messageSource ?? null;
    composerRef.current?.setContent(pendingInput.draftText || pendingInput.previewText);
    composerRef.current?.focus();
  }, [agentId]);

  const handleRemovePendingInput = useCallback((pendingInputId: string) => {
    if (!agentId) {
      return;
    }

    removeAgentPendingInput(agentId, pendingInputId);
    composerRef.current?.focus();
  }, [agentId]);

  const handleQueuePendingInput = useCallback((pendingInputId: string) => {
    if (!agentId) {
      return;
    }

    const pendingInput = getAgentPendingInputs(agentId).find((input) => input.id === pendingInputId);
    if (!pendingInput) {
      return;
    }

    if (isAgentPendingInputSteerLocked(pendingInput)) {
      showToast('This message has already been submitted after the next tool call and cannot be moved.', 'info', 5000);
      return;
    }

    updateAgentPendingInput(agentId, pendingInputId, (input) => ({
      ...input,
      stage: 'endOfTurn',
      afterNextToolState: null,
      submittedText: null,
    }));
    composerRef.current?.focus();
  }, [agentId, showToast]);

  const handleInterruptPendingInput = useCallback((pendingInputId: string) => {
    if (isTerminal || !agentId) {
      return;
    }

    const existingPendingInput = getAgentPendingInputs(agentId).find((input) => input.id === pendingInputId);
    if (!existingPendingInput) {
      return;
    }

    const pendingInput = updateAgentPendingInput(agentId, pendingInputId, (input) => ({
      ...input,
      stage: 'interrupting',
      afterNextToolState: null,
    }));
    if (!pendingInput) {
      return;
    }

    window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));
    window.dispatchEvent(new CustomEvent('agent-runtime:cancel', {
      detail: { tabId: agentId },
    }));
    composerRef.current?.focus();
  }, [agentId, isTerminal]);

  const handleSteerPendingInput = useCallback((pendingInputId: string) => {
    if (isTerminal || !agentId) {
      return;
    }

    const pendingInput = updateAgentPendingInput(agentId, pendingInputId, (input) => ({
      ...input,
      stage: 'afterNextTool',
      afterNextToolState: 'local',
      submittedText: null,
    }));
    if (!pendingInput) {
      return;
    }

    window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));
    window.dispatchEvent(new CustomEvent(AGENT_RUNTIME_STEER_EVENT, {
      detail: {
        tabId: agentId,
        pendingInputId,
      },
    }));
    composerRef.current?.focus();
  }, [agentId, isTerminal]);

  // Drag handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isComposerFileDrag(e.dataTransfer, layout?.state.tabs ?? {})) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setIsOver(true);
    e.dataTransfer.dropEffect = 'copy';
  }, [layout?.state.tabs]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);

    const composerDrop = resolveComposerFileDropData(e.dataTransfer, layout?.state.tabs ?? {});
    if (!composerDrop) {
      return;
    }

    markActiveFileDragHandled('composer-area-drop', {
      agentId,
      filePath: composerDrop.filePath,
    });
    window.dispatchEvent(new CustomEvent('composer:file-drop', {
      detail: {
        filePath: composerDrop.filePath,
        fileName: composerDrop.fileName,
        isDirectory: composerDrop.isDirectory,
        agentId,
      }
    }));
  }, [agentId, layout]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (!isTerminal && agentId) {
        window.dispatchEvent(new CustomEvent(VOICE_MODE_CHANGED_EVENT, {
          detail: { agentId, isActive: false },
        }));
      }
      clearMoonshineSilenceTimeout();
      resetMoonshineDraft();
      resetVoiceRenderedText();
      trackActiveVoiceModeStopped();
      isVoiceModeActiveRef.current = false;
      isPushToTalkAwaitingSpeechStartRef.current = false;
      const moonshineTranscriber = moonshineTranscriberRef.current;
      moonshineTranscriberRef.current = null;
      if (moonshineTranscriber) {
        try {
          moonshineTranscriber.stop();
        } catch (error) {
          console.error('[VoiceMode] Failed to stop moonshine transcriber during cleanup:', error);
        }
      }
      const voiceSession = voiceCaptureSessionRef.current;
      voiceCaptureSessionRef.current = null;
      if (voiceSession) {
        try {
          voiceSession.stop();
        } catch (error) {
          console.error('[VoiceMode] Failed to stop voice capture during cleanup:', error);
        }
      }
    };
  }, [agentId, clearMoonshineSilenceTimeout, isTerminal, resetMoonshineDraft, resetVoiceRenderedText, trackActiveVoiceModeStopped]);

  // Determine if send button should show (for terminal, always show simple send)
  const renderSendButton = useCallback(({ disabled, onSend }: { disabled: boolean; onSend: () => void }) => {
    if (isTerminal) {
      // Terminal mode: simple send button, no queue/stop states
      return (
        <span
          className={[
            'inline-flex rounded-full p-1',
            showSendButtonPulse && !disabled && 'onboarding-feedback-button-shell feedback-button-onboarding-pulse-twice',
          ].filter(Boolean).join(' ')}
          onAnimationEnd={() => setShowSendButtonPulse(false)}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid={MAIN_COMPOSER_SEND_BUTTON_ID}
                disabled={disabled}
                className={[
                  'composer-send-button flex size-9 items-center justify-center rounded-full transition-all duration-150',
                  disabled && 'opacity-50 cursor-not-allowed',
                  !disabled && 'hover:-translate-y-px',
                ].filter(Boolean).join(' ')}
                style={{
                  background: disabled
                    ? 'var(--oa-bg-subtle, var(--hover-bg))'
                    : 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
                  color: disabled
                    ? 'var(--oa-text-faint, var(--text-muted))'
                    : 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
                  boxShadow: disabled
                    ? 'none'
                    : 'var(--oa-shadow-sm, 0 8px 30px rgba(0,0,0,0.08))',
                }}
                onClick={onSend}
              >
                <ArrowUp className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="flex items-center gap-1.5">
                <span>{t('common.send')}</span>
                <span className="opacity-60">{t('common.enter')}</span>
              </span>
            </TooltipContent>
          </Tooltip>
        </span>
      );
    }

    const isBusy = isVoiceModeStarting;
    const isActive = isVoiceModeActive;

    // When voice is active AND streaming, show stop agent button (separate from voice exit)
    if (isActive && isStreaming) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={MAIN_COMPOSER_SEND_BUTTON_ID}
              className="composer-send-button flex size-9 items-center justify-center rounded-full"
              style={{
                background: 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
                color: 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
                boxShadow: 'var(--oa-shadow-sm, 0 8px 30px rgba(0,0,0,0.08))',
              }}
              onClick={handleStop}
            >
              <Square className="size-4 fill-current" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('composer.stopAgent')}</TooltipContent>
        </Tooltip>
      );
    }

    // When voice is active but not streaming, keep the same control available
    // and turn it into an exit affordance on hover/focus.
    if (isActive) {
      const exitVoiceTitle = t('help.composer.exitVoice.title');
      const exitVoiceDescription = t('help.composer.exitVoice.description');
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={MAIN_COMPOSER_VOICE_BUTTON_ID}
              aria-label={exitVoiceTitle}
              data-help-title={exitVoiceTitle}
              data-help-description={exitVoiceDescription}
              aria-pressed="true"
              className="composer-send-button group flex size-9 items-center justify-center rounded-full transition-all duration-150"
              style={{
                background: isVoiceWorking
                  ? 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 58%, var(--oa-bg-app, var(--background)) 42%)'
                  : 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 74%, var(--oa-bg-app, var(--background)) 26%)',
                color: 'var(--oa-text-strong, var(--foreground))',
                boxShadow: isVoiceWorking
                  ? '0 1px 2px rgba(15, 23, 42, 0.08), 0 0 0 1px color-mix(in srgb, var(--oa-text, var(--foreground)) 10%, transparent)'
                  : '0 1px 2px rgba(15, 23, 42, 0.06), 0 6px 16px rgba(15, 23, 42, 0.05)',
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                stopVoiceMode();
              }}
            >
              {isPushToTalkFinishing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <span className="relative flex size-4 items-center justify-center">
                  <AudioLines className="size-4 transition-[opacity,transform] duration-150 group-hover:scale-75 group-hover:opacity-0 group-focus-visible:scale-75 group-focus-visible:opacity-0" />
                  <X className="absolute size-4 scale-75 opacity-0 transition-[opacity,transform] duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100" />
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isPushToTalkFinishing ? t('help.composer.voice.finishingTranscription') : exitVoiceTitle}
          </TooltipContent>
        </Tooltip>
      );
    }

    // Voice mode starting or idle (no input, not streaming) — show a direct voice start button
    const showVoiceControls = isBusy || (!isStreaming && disabled);

    if (showVoiceControls) {
      const currentVoiceMode = sttSettingsForUi.voiceMode ?? 'conversational';
      const conversationalModeLabel = t('settings.stt.voiceModeConversational');
      const pushToTalkModeLabel = t('settings.stt.voiceModePushToTalk');
      const ambientModeLabel = t('settings.stt.voiceModeAmbient');
      const ambientModeDescription = t('help.composer.voice.modeAmbientDescription', {
        trigger: getPrimaryAmbientPhrase(sttSettingsForUi.ambientTriggerPhrases, 'Interpreter'),
        endPhrase: getPrimaryAmbientPhrase(sttSettingsForUi.ambientEndPhrases, 'make it so'),
      });
      const voiceModeMenuItems: HoverMenuItem[] = [
        {
          key: 'conversational',
          icon: <MessageSquare className="size-4" />,
          label: conversationalModeLabel,
          helpTitle: conversationalModeLabel,
          helpDescription: t('help.composer.voice.modeConversationalDescription'),
          description: (
            <div className="text-ui-sm leading-5 text-pretty">
              {t('help.composer.voice.modeConversationalDescription')}
            </div>
          ),
          trailing: currentVoiceMode === 'conversational' ? <Check className="size-4" /> : undefined,
          onClick: () => {
            void startVoiceMode('conversational');
          },
        },
        {
          key: 'push-to-talk',
          icon: <Keyboard className="size-4" />,
          label: pushToTalkModeLabel,
          helpTitle: pushToTalkModeLabel,
          helpDescription: t('help.composer.voice.modePushToTalkDescription'),
          description: (
            <div className="text-ui-sm leading-5 text-pretty">
              {t('help.composer.voice.modePushToTalkDescription')}
            </div>
          ),
          trailing: currentVoiceMode === 'push-to-talk' ? <Check className="size-4" /> : undefined,
          onClick: () => {
            void startVoiceMode('push-to-talk');
          },
        },
        {
          key: 'ambient',
          icon: <Radio className="size-4" />,
          label: ambientModeLabel,
          helpTitle: ambientModeLabel,
          helpDescription: ambientModeDescription,
          description: (
            <div className="text-ui-sm leading-5 text-pretty">
              {ambientModeDescription}
            </div>
          ),
          trailing: currentVoiceMode === 'ambient' ? <Check className="size-4" /> : undefined,
          onClick: () => {
            void startVoiceMode('ambient');
          },
        },
      ];

      return (
        <ButtonWithHoverMenu
          menuItems={voiceModeMenuItems}
          menuHeader={t('onboarding.common.experimental')}
          menuEnabled={!isBusy}
          hoverDelayMs={400}
          buttonIcon={isBusy ? <Loader2 className="size-4 animate-spin" /> : <AudioLines className="size-4" />}
          onButtonClick={() => {
            void startVoiceMode();
          }}
          disabled={isBusy}
          testId={MAIN_COMPOSER_VOICE_BUTTON_ID}
          helpTitle={t('help.composer.voice.title')}
          helpDescription={t('help.composer.voice.description')}
          buttonStyle={{
            background: isBusy
              ? 'var(--oa-bg-subtle, var(--hover-bg))'
              : 'var(--brand-accent, var(--oa-primary, var(--foreground)))',
            color: isBusy
              ? 'var(--oa-text-faint, var(--text-muted))'
              : 'var(--brand-accent-foreground, var(--oa-primary-foreground, var(--background)))',
            boxShadow: isBusy
              ? 'none'
              : 'var(--oa-shadow-sm, 0 8px 30px rgba(0,0,0,0.08))',
          }}
          buttonClassName="composer-send-button flex size-9 items-center justify-center rounded-full transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50"
        />
      );
    }

    // Agent mode: full menu with queue/stop
    return (
      <SendButtonWithMenu
        isStreaming={isStreaming}
        hasInput={!disabled}
        hasQueue={hasQueue}
        onSend={onSend}
        onSendAfterNextTool={() => {
          void handleSteer();
        }}
        onQueueForEndOfTurn={() => {
          void handleQueue();
        }}
        onInterruptAndSendImmediately={() => {
          void handleSendImmediate();
        }}
        onStop={handleStop}
        disabled={disabled}
        showOnboardingPulse={showSendButtonPulse}
        onOnboardingPulseEnd={() => setShowSendButtonPulse(false)}
      />
    );
  }, [
    hasQueue,
    handleQueue,
    handleSteer,
    handleSendImmediate,
    handleStop,
    isPushToTalkFinishing,
    isVoiceReactive,
    isVoiceWorking,
    isStreaming,
    isTerminal,
    isVoiceModeActive,
    isVoiceModeStarting,
    sttSettingsForUi,
    t,
    stopVoiceMode,
    startVoiceMode,
    showSendButtonPulse,
  ]);

  useEffect(() => {
    const handleWorkspacePathChange = onWorkspacePathChange;
    const nextWorkspacePath = windowWorkspacePath;
    if (!handleWorkspacePathChange || !nextWorkspacePath) {
      return;
    }
    if (!shouldAdoptWindowWorkspaceForIdleComposer({
      isTerminal,
      onWorkspacePathChange: handleWorkspacePathChange,
      messageCount,
      windowWorkspacePath: nextWorkspacePath,
      workspacePath,
    })) {
      return;
    }
    handleWorkspacePathChange(nextWorkspacePath);
  }, [isTerminal, messageCount, onWorkspacePathChange, windowWorkspacePath, workspacePath]);

  const effectiveWorkspacePath = getEffectiveComposerWorkspacePath({
    workspacePath,
    windowWorkspacePath,
  });
  const sandboxNotice = getCodexSandboxNotice(sandboxMode);

  const handleOpenSandboxSettings = useCallback(() => {
    layout?.openSettings(undefined, 'runtimePermissions');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent(SETTINGS_FOCUS_SECTION_EVENT, {
          detail: {
            sectionId: 'runtimePermissions',
            blink: true,
          },
        }));
      });
    });
  }, [layout]);

  const composerContextContent = !isTerminal && agentId && onWorkspacePathChange ? (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <WorkspacePopover
        windowWorkspacePath={windowWorkspacePath}
        effectiveWorkspacePath={effectiveWorkspacePath}
        sandboxMode={sandboxMode}
        onWorkspacePathChange={onWorkspacePathChange}
        onOpenSettings={handleOpenSandboxSettings}
      />
      {sandboxNotice ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <ComposerSecondaryButton
              type="button"
              onClick={handleOpenSandboxSettings}
              className={`h-7 px-2.5 text-ui-xs ${
                sandboxNotice.tone === 'warning'
                  ? 'text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200'
                  : ''
              }`}
              aria-label={`Open Interpreter access settings. ${sandboxNotice.description}`}
              data-help-title={`Interpreter access: ${sandboxNotice.label}`}
              data-help-description={`Open access settings. ${sandboxNotice.description}`}
            >
              <span>{sandboxNotice.label}</span>
            </ComposerSecondaryButton>
          </TooltipTrigger>
          <TooltipContent side="top">Open access settings. {sandboxNotice.description}</TooltipContent>
        </Tooltip>
      ) : null}
      <ContextPreview agentId={agentId} />
    </div>
  ) : undefined;

  const voiceExitLeadingControl = isVoiceModeActive ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <ComposerSecondaryButton
          type="button"
          chromeSize="icon"
          aria-label={t('help.composer.exitVoice.title')}
          data-help-title={t('help.composer.exitVoice.title')}
          data-help-description={t('help.composer.exitVoice.description')}
          onMouseDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            stopVoiceMode();
          }}
        >
          <Plus className="rotate-45" />
        </ComposerSecondaryButton>
      </TooltipTrigger>
      <TooltipContent side="top">{t('help.composer.exitVoice.title')}</TooltipContent>
    </Tooltip>
  ) : undefined;

  // Voice mode status text helper
  const voiceStatusText = isVoiceModeActive ? (() => {
    const mode = sttSettingsForUi.voiceMode ?? 'conversational';
    if (mode === 'push-to-talk') {
      if (isPushToTalkFinishing) {
        return 'Transcribing';
      }
      return isPushToTalkHeld ? 'Recording' : 'Hold Space to talk';
    }
    if (mode === 'ambient') {
      if (ambientPhase === 'accumulating') {
        return `Say "${getPrimaryAmbientPhrase(sttSettingsForUi.ambientEndPhrases, 'make it so')}" to send`;
      }
      return `Say "${getPrimaryAmbientPhrase(sttSettingsForUi.ambientTriggerPhrases, 'Interpreter')}" to start`;
    }
    return isVoiceWorking ? 'Recording' : 'Listening';
  })() : null;

  const voiceSupportText = isVoiceModeActive
    ? (voiceOverlayText
      ? null
      : ((sttSettingsForUi.voiceMode ?? 'conversational') === 'ambient'
        ? 'Voice mode is ready.'
        : isPushToTalkFinishing
          ? 'Finishing your transcription.'
        : 'Start speaking whenever you are ready.'))
    : null;

  const sttModelLabel = getRuntimeSystemInfo().platform === 'win32'
    ? getSttModelDisplayLabel('moonshine')
    : getSttModelDisplayLabel(voiceModelRequirement?.sttBackend ?? sttSettingsForUi.backend);
  const totalVoiceModelDownloadBytes = voiceModelRequirement
    ? voiceModelRequirement.sttDownloadBytes + voiceModelRequirement.ttsDownloadBytes
    : 0;
  const canSkipVoiceModelInstall = Boolean(
    voiceModelRequirement && voiceModelRequirement.sttInstalled && voiceModelRequirement.ttsInstalled,
  );

  const composerInner = (
    <div
      ref={composerContainerRef}
      data-file-drop-surface="composer"
      data-agent-id={agentId}
      data-morph-composer-target={morphTarget ? 'true' : undefined}
      data-composer-layout={isWide ? 'wide' : 'narrow'}
      className="oa-composer-surface oa-interactive-surface relative flex flex-col transition-[transform,box-shadow,background-color,border-color] duration-200"
      style={{
        ...(composerHeight ? { height: composerHeight } : undefined),
        '--oa-surface-bg-current': showFlash
          ? 'color-mix(in srgb, var(--oa-primary, var(--foreground)) 6%, var(--oa-composer-surface, var(--oa-bg-input, var(--background))) 94%)'
          : isVoiceModeActive
            ? (isVoiceWorking
              ? 'color-mix(in srgb, var(--oa-text, var(--foreground)) 14%, var(--oa-composer-surface, var(--oa-bg-input, var(--background))) 86%)'
              : 'color-mix(in srgb, var(--oa-text, var(--foreground)) 7%, var(--oa-composer-surface, var(--oa-bg-input, var(--background))) 93%)')
            : 'var(--oa-composer-surface, var(--oa-bg-input, var(--background)))',
        '--oa-surface-border-current': isVoiceModeActive && isVoiceWorking
          ? 'color-mix(in srgb, var(--oa-border-strong, var(--oa-border, var(--border))) 62%, transparent)'
          : isVoiceModeActive
            ? 'color-mix(in srgb, var(--oa-border, var(--border)) 78%, transparent)'
          : undefined,
        '--oa-surface-shadow-current': isOver
          ? '0 14px 32px rgba(15, 23, 42, 0.10)'
          : isVoiceModeActive && isVoiceWorking
            ? '0 1px 2px rgba(15, 23, 42, 0.06), 0 0 0 1px color-mix(in srgb, var(--oa-text, var(--foreground)) 10%, transparent), 0 12px 28px rgba(15, 23, 42, 0.10)'
            : isVoiceModeActive
              ? '0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 20px rgba(15, 23, 42, 0.06)'
            : 'var(--oa-composer-shadow, 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 22px rgba(15, 23, 42, 0.04))',
        borderRadius: 'var(--oa-radius-22)',
        transform: isOver ? 'translateY(-1px)' : undefined,
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <style>{`
        .oa-composer-surface .oa-main-composer-placeholder {
          opacity: 0.52;
        }

        /* In voice mode, hide the editor text area contents but preserve layout */
        .voice-mode-active .main-composer-content,
        .voice-mode-active .oa-main-composer-preview,
        .voice-mode-active .oa-main-composer-placeholder {
          visibility: hidden;
        }
      `}</style>

      {/* Suggestion Chips (agent mode only) */}
      {!isTerminal && showSuggestionChips && !isVoiceModeActive && (
        <SuggestionChips
          messageCount={messageCount}
          hasQueuedMessages={hasQueue || isMarketingDemoPromptPlaying}
          isStreaming={isStreaming}
          suggestionsOverride={marketingDemoSuggestions}
          fadeInDelayMs={marketingDemoMode ? 0 : 2000}
          positionMode="overlay"
          externalOpacity={suggestionOverlayOpacity}
          onMeasuredHeightChange={onSuggestionOverlayHeightChange}
          onSuggestionClick={(suggestion) => {
            const messageSource = buildSuggestionChipMessageSource({
              id: suggestion.id,
              label: suggestion.label,
              prompt: suggestion.prompt,
            });

            if (marketingDemoMode) {
              const option = marketingDemoPromptOptionsById.current.get(suggestion.id);
              if (option) {
                playMarketingDemoPrompt(option, messageSource);
                return;
              }
            }

            if (suggestion.action === 'send') {
              void handleSend(suggestion.prompt, undefined, { messageSource });
              return;
            }

            pendingMessageSourceRef.current = messageSource;
            const prompt = suggestion.prompt;
            if (prompt.startsWith('skill:[')) {
              const current = composerRef.current?.getContent() || '';
              const separator = current.length > 0 && !current.endsWith('\n') ? ' ' : '';
              composerRef.current?.setContent(`${current}${separator}${prompt}`);
            } else {
              composerRef.current?.insertText(prompt);
            }
            composerRef.current?.focus();
          }}
        />
      )}

      {/* Voice mode: overlay voice transcript on top of the editor content area */}
      {isVoiceModeActive && (
        <div
          className="absolute left-0 right-0 z-10 overflow-hidden pointer-events-none"
          style={{
            top: 0,
            bottom: '2.75rem', // leave space for controls bar
            paddingLeft: '0.75rem',
            paddingRight: '0.75rem',
            paddingTop: '0.75rem',
          }}
        >
          <div className="flex min-h-full flex-1 min-w-0 flex-col pointer-events-auto">
            <div
              className="inline-flex max-w-max items-center gap-2 rounded-full px-2.5 py-1"
              style={{
                background: isVoiceWorking
                  ? 'color-mix(in srgb, var(--oa-text, var(--foreground)) 12%, transparent)'
                  : 'color-mix(in srgb, var(--oa-text, var(--foreground)) 7%, transparent)',
                color: 'var(--oa-text-strong, var(--foreground))',
                boxShadow: isVoiceWorking
                  ? '0 0 0 1px color-mix(in srgb, var(--oa-text, var(--foreground)) 10%, transparent)'
                  : '0 0 0 1px color-mix(in srgb, var(--oa-border, var(--border)) 64%, transparent)',
              }}
            >
              {isPushToTalkFinishing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <span
                  className={`block size-2 rounded-full transition-[transform,opacity,background-color] duration-150 ${isVoiceWorking ? 'scale-110 opacity-100' : 'opacity-70'}`}
                  style={{
                    background: isVoiceWorking
                      ? 'var(--oa-text-strong, var(--foreground))'
                      : 'color-mix(in srgb, var(--oa-text-muted, var(--text-muted)) 88%, transparent)',
                  }}
                />
              )}
              <span className="text-[11px] font-medium tracking-[0.01em]">
                {voiceStatusText}
              </span>
            </div>

            {voiceOverlayText ? (
              <>
                <p
                  data-testid={VOICE_OVERLAY_TEXT_ID}
                  className="mt-3 w-full break-words text-[15px] leading-6"
                  style={{ color: 'var(--oa-text, var(--foreground))' }}
                >
                  {voiceOverlayText}
                </p>
                {sttSettingsForUi.voiceMode === 'ambient' && ambientPhase === 'accumulating' && (
                  <p
                    className="text-[12px] mt-1 opacity-70"
                    style={{
                      color: 'var(--oa-text-faint, var(--text-muted))',
                      fontStyle: 'italic',
                    }}
                  >
                    Say &ldquo;{getPrimaryAmbientPhrase(sttSettingsForUi.ambientEndPhrases, 'make it so')}&rdquo; to send
                  </p>
                )}
              </>
            ) : (
              <p
                className="mt-3 text-[13px] leading-5"
                style={{
                  color: 'var(--oa-text-faint, var(--text-muted))',
                }}
              >
                {voiceSupportText}
              </p>
            )}
          </div>
        </div>
      )}
      <BaseTiptapComposer
        ref={composerRef}
        placeholder={isTerminal
          ? "Send to terminal..."
          : (marketingDemoMode ? "Pick a demo prompt above" : undefined)}
        onSend={isStreaming && !isTerminal ? handleSteer : handleSend}
        sendButtonLabel="Send message (Enter)"
        autoFocus={false}
        noPadding={true}
        className={`oa-composer-body flex-1 flex flex-col ${isVoiceModeActive ? 'voice-mode-active' : ''}`}
        showControls={true}
        hideControlsOnBlur={false}
        isMainComposer={true}
        editable={!marketingDemoMode}
        agentId={agentId}
        profileShortcutScope={isTerminal ? undefined : agentId}
        leadingControl={voiceExitLeadingControl}
        contextContent={isVoiceModeActive ? undefined : composerContextContent}
        renderSendButton={renderSendButton}
        settingsContent={settingsContent}
        skillsWorkspacePath={effectiveWorkspacePath ?? null}
      />
    </div>
  );

  const emptyStateComposerShell = isWide ? (
    <div style={{ padding: '0 var(--unit-padding-medium)' }}>
      {composerInner}
    </div>
  ) : (
    <div className="px-2">
      {composerInner}
    </div>
  );

  return (
    <div ref={wrapperRef} className="mx-auto w-full max-w-[48rem]">
      {/* Queued messages display (agent mode only) */}
      {!isTerminal && showQueuedMessages && (
        <QueuedMessagesDisplay
          pendingInputs={pendingInputs}
          isStreaming={isStreaming}
          onEdit={handleEditPendingInput}
          onRemove={handleRemovePendingInput}
          onInterruptNow={handleInterruptPendingInput}
          onQueueForEndOfTurn={handleQueuePendingInput}
          onSendAfterNextTool={handleSteerPendingInput}
        />
      )}

      {topAccessory}

      {/* Resize handle */}
      {showResizeHandle && (
        <ResizeHandle
          onMouseDown={handleResizeMouseDown}
          orientation="horizontal"
          showBorder={false}
        />
      )}

      {/* Composer shell */}
      {noBorderPadding ? (
        emptyStateComposerShell
      ) : isWide ? (
        <div style={{ padding: '0 var(--unit-padding-medium) calc(var(--unit-padding) + 2px)' }}>
          {composerInner}
        </div>
      ) : (
        <div className="px-2 pb-2">
          {composerInner}
        </div>
      )}

      <OnboardingModal
        open={isVoiceModelsModalOpen}
        onClose={closeVoiceModelsModal}
        closeOnBackdrop={!isVoiceModelInstallPending}
        closeOnEscape={!isVoiceModelInstallPending}
        panelClassName="max-w-[640px] rounded-[24px] p-6"
        panelStyle={VOICE_MODELS_MODAL_STYLE}
      >
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-[18px] font-medium text-[var(--oa-text-strong)]">{t('voiceModels.modalTitle')}</h3>
              <p className="text-[12px] leading-5 text-[var(--oa-text-muted)]">
                {t('voiceModels.modalDescription')}
              </p>
            </div>
            <ExperimentalBadge />
          </div>

          {voiceModelRequirement && (
            <div
              className="space-y-2 rounded-[14px] p-3"
              style={{
                border: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 52%, transparent)',
                backgroundColor: 'color-mix(in oklch, var(--oa-bg-app) 92%, var(--oa-bg-subtle) 8%)',
              }}
            >
              <div className="flex items-center justify-between gap-3 text-ui-sm">
                <span className="text-[var(--oa-text-muted)]">{sttModelLabel}</span>
                <span className="font-medium text-[var(--oa-text-strong)]">
                  {voiceModelRequirement.sttInstallRequired
                    ? formatDownloadSize(voiceModelRequirement.sttDownloadBytes)
                    : t('voiceModels.noDownloadNeeded')}
                </span>
              </div>
              {voiceModelRequirement.ttsInstallRequired && (
                <div className="flex items-center justify-between gap-3 text-ui-sm">
                  <span className="text-[var(--oa-text-muted)]">TTS model ({voiceModelRequirement.ttsModelId})</span>
                  <span className="font-medium text-[var(--oa-text-strong)]">{formatDownloadSize(voiceModelRequirement.ttsDownloadBytes)}</span>
                </div>
              )}
              <div
                className="flex items-center justify-between gap-3 pt-2 text-ui-sm"
                style={{ borderTop: 'var(--border-width) solid color-mix(in oklch, var(--oa-border) 52%, transparent)' }}
              >
                <span className="text-[var(--oa-text-muted)]">{t('voiceModels.totalDownload')}</span>
                <span className="font-medium text-[var(--oa-text-strong)]">{formatDownloadSize(totalVoiceModelDownloadBytes)}</span>
              </div>
            </div>
          )}

          <p className="text-[12px] leading-5 text-[var(--oa-text-muted)]">
            {t('voiceModels.settingsLater')}
          </p>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeVoiceModelsModal}
              disabled={isVoiceModelInstallPending}
              className="rounded-full"
            >
              {canSkipVoiceModelInstall ? t('common.close') : t('common.notNow')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void handleInstallVoiceModels();
              }}
              disabled={isVoiceModelInstallPending}
              className="rounded-full"
            >
              {isVoiceModelInstallPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('voiceModels.downloadModels')}
            </Button>
          </div>
        </div>
      </OnboardingModal>
    </div>
  );
});

export default ComposerArea;
