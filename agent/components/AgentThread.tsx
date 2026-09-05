import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { tr } from '../../src/i18n';
import { AgentModelConfig } from '../../shared/types/model';
import { BUILTIN_PROVIDER_IDS, findSupportedResponsesApiBaseUrlOption } from '../../shared/types/provider';
import { useAuth } from '@/contexts/AuthContext';
import { useInterpreterTokenUsage } from '@/hooks/useInterpreterTokenUsage';
import { supabase } from '@/utils/supabase/client';
import { LayoutContext } from '../../src/contexts/LayoutContext';
import { useToast } from '../../src/contexts/ToastContext';
import { formatWorkstationContext, WORKSTATION_CONTEXT_TAG } from '../../shared/utils/formatWorkstationContext';
import { AGENT_THREAD_ID } from '../../shared/element-ids';
import { stripWorkstationContext } from '../../shared/utils/formatWorkstationContext';
import type { MessagingChannel } from '../../shared/types/messaging';
import {
  useChat,
  textContent,
  type ChatMessage,
  type PlanChecklistState,
} from '../../src/hooks/use-chat';
import { agentTabs, getApiUrl, tts as ttsIpc } from '../../src/ipc';
import { useAgentNotifications } from '../hooks/useAgentNotifications';
import { ThreadMessages } from './prompt-kit/thread-messages';
import { ThreadGoalBar } from './ThreadGoalBar';
import { computeUnreadCount } from '../../shared/utils/agentAttention';
import { removeAgentActivity, updateAgentActivity } from '../../src/stores/agentActivityStore';
import {
  addAgentPendingInput,
  findAgentPendingInputBySubmittedText,
  getAgentPendingInputs,
  getNextDispatchableAgentPendingInput,
  isAgentPendingInputSteerLocked,
  normalizeAgentPendingInputSubmittedText,
  removeAgentPendingInput,
  subscribeAgentPendingInputs,
  updateAgentPendingInput,
  updateAgentPendingInputs,
  type AgentPendingInput,
} from '../../src/stores/agentPendingInputStore';
import { setLastSentContext } from './composer/ContextPreview';
import {
  flushSentenceRemainder,
  splitStreamingTextIntoSentences,
  stripMarkdownForTts,
} from '../utils/ttsSentenceQueue';
import type { TtsGetSettingsResponse, TtsSettingsChangedEvent } from '../../electron/ipc/registry';
import { extractSkillMentionsFromText } from '../../shared/utils/skillMentions';
import type { MessageSendSource } from '../../shared/types/messageSendSource';
import type { StreamImageAttachment } from '../../src/lib/codex/api-types';
import {
  INSUFFICIENT_INTERPRETER_TOKENS_KEY,
  INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE,
} from '../../src/lib/codex/errors';
import {
  AGENT_SEED_COMPOSER_EVENT,
  enqueuePendingAgentComposerSeed,
  type AgentSeedComposerDetail,
} from '../../shared/agentEvents';

const ASSISTANT_TTS_ENQUEUE_EVENT = 'assistant-tts:enqueue-sentence';
const ASSISTANT_TTS_STOP_EVENT = 'assistant-tts:stop';
const AGENT_RUNTIME_STEER_EVENT = 'agent-runtime:steer';

interface AssistantTtsSentenceEnqueueDetail {
  text: string;
  messageId: string;
  sentenceIndex: number;
  source?: 'assistant-auto' | 'manual';
}

interface AgentRuntimeSendDetail {
  tabId: string;
  text: string;
  workspacePath?: string | null;
  attachments?: StreamImageAttachment[];
  messageSource?: MessageSendSource | null;
}

interface AgentRuntimeSteerDetail {
  tabId: string;
  pendingInputId: string;
}

interface DesktopUserTokensRow {
  monthly_tokens: number | null;
  purchased_tokens: number | null;
}

// NOTE(victor): Extracted from the inline useEffect guard for unit testability
// (see AgentThread.test.ts). Determines whether a programmatically-created agent
// tab should fire its initial message.
//
// Bug context (restart re-send):
//   createAgentTab() sets initialMessage + requestId on the Tab object
//   (src/utils/layoutHelpers.ts:121-137). These fields are never cleared and
//   persist to localStorage via saveLayoutState() (src/utils/layoutPersistence.ts:16-24).
//   On app restart, loadLayoutState() restores them (src/utils/layoutPersistence.ts:27-43),
//   the React ref (hasSentInitialRef) resets to false, and useChat initializes
//   messages as [] (src/hooks/use-chat.ts:141) before async history fetch resolves
//   (src/hooks/use-chat.ts:159-217). Without the historyLoaded guard, every
//   condition passes and sendMessage fires a duplicate.
//
// Fix: wait for historyLoaded (returned by useChat) before allowing the send.
// The historyLoaded flag is true immediately for new tabs (no history to load)
// and flips to true after the fetch resolves for restored tabs with a codexThreadId.
export function shouldSendInitialMessage(params: {
  initialMessage: string | undefined;
  requestId: string | undefined;
  hasSentInitial: boolean;
  messagesLength: number;
  isStreaming: boolean;
  historyLoaded: boolean;
}): boolean {
  if (!params.initialMessage || !params.requestId || params.hasSentInitial) return false;
  if (params.messagesLength > 0 || params.isStreaming) return false;
  if (!params.historyLoaded) return false;
  return true;
}

export function getRecoveredStaleThreadIdForToast(params: {
  initialThreadId: string | undefined;
  historyLoaded: boolean;
  threadId: string | null;
  messagesLength: number;
  error: string | null;
}): string | null {
  const initialThreadId = params.initialThreadId?.trim();
  if (!initialThreadId || !params.historyLoaded) return null;
  if (params.threadId !== null) return null;
  if (params.messagesLength > 0 || params.error) return null;
  return initialThreadId;
}

export function shouldConsumeProgrammaticStartup(params: {
  startupId: string | undefined;
  hasConsumedStartup: boolean;
  messagesLength: number;
  isStreaming: boolean;
  historyLoaded: boolean;
}): boolean {
  if (!params.startupId || params.hasConsumedStartup) return false;
  if (params.isStreaming) return false;
  if (!params.historyLoaded) return false;
  return true;
}

export function hasLockedAfterNextToolPendingInput(
  pendingInputs: AgentPendingInput[],
): boolean {
  return pendingInputs.some((input) => isAgentPendingInputSteerLocked(input));
}

export function moveUnlockedAfterNextToolInputsToEndOfTurn(
  pendingInputs: AgentPendingInput[],
): AgentPendingInput[] {
  return pendingInputs.map((input) => (
    input.stage === 'afterNextTool' && !isAgentPendingInputSteerLocked(input)
      ? {
        ...input,
        stage: 'endOfTurn',
        afterNextToolState: null,
        submittedText: null,
      }
      : input
  ));
}

function isHiddenConversationMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.includes('<compaction') || trimmed.startsWith('<system-notification source="');
}

function seedComposerForAgent(agentId: string, prompt: string, autoSend = false): void {
  const detail: AgentSeedComposerDetail = {
    agentId,
    prompt,
    autoSend,
  };
  enqueuePendingAgentComposerSeed(detail);

  const composer = document.querySelector(
    `[data-agent-id="${CSS.escape(agentId)}"] [contenteditable="true"]`,
  );
  if (!composer) {
    return;
  }

  window.dispatchEvent(new CustomEvent(AGENT_SEED_COMPOSER_EVENT, { detail }));
}

export function buildConversationRestartPrompt(messages: ChatMessage[]): string {
  const transcript = messages
    .map((message) => {
      const content = stripWorkstationContext(textContent(message)).trim();
      if (!content || isHiddenConversationMessage(content)) return null;
      const speaker = message.role === 'user' ? 'User' : 'Assistant';
      return `${speaker}:\n${content}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join('\n\n');

  if (!transcript) {
    return 'Start a fresh chat and continue helping me.';
  }

  return `Continue this conversation in a fresh chat. Here is the conversation so far:\n\n${transcript}`;
}

export function getAgentThreadRuntimeKey(params: {
  agentId: string;
  conversationId?: string;
}): string {
  return params.conversationId?.trim() || params.agentId;
}

interface AgentThreadProps {
  agentId: string;
  conversationId?: string;
  codexThreadId?: string;
  callerToken: string;
  workspacePath?: string;
  agentChannel?: MessagingChannel;
  isVisible: boolean;
  onLabelUpdate?: (agentId: string, label: string, isRunning: boolean) => void;
  onMessageCountChange?: (agentId: string, count: number) => void;
  onCodexThreadIdAssigned?: (agentId: string, threadId: string) => void;
  modelConfig: AgentModelConfig;
  didSwitchRuntimeDuringConversation?: boolean;
  onModelConfigUpdate: (agentId: string, modelConfig: AgentModelConfig) => void;
  startupId?: string;
  requestId?: string;
  initialMessage?: string;
  systemPrompt?: string;
  emptyLabel?: string;
  isEditorPane?: boolean;
  onStartupConsumed?: (agentId: string, startupId: string) => void;
  suggestionOverlayHeight?: number;
  onSuggestionOverlayOpacityChange?: (opacity: number) => void;
  readOnly?: boolean;
}

export function AgentThread({
  agentId,
  conversationId: providedConversationId,
  codexThreadId,
  callerToken,
  isVisible,
  onLabelUpdate,
  onMessageCountChange,
  onCodexThreadIdAssigned,
  workspacePath,
  modelConfig,
  didSwitchRuntimeDuringConversation,
  startupId,
  requestId,
  initialMessage,
  systemPrompt,
  emptyLabel = tr('common.newAgent'),
  isEditorPane,
  onStartupConsumed,
  suggestionOverlayHeight,
  onSuggestionOverlayOpacityChange,
  readOnly = false,
}: AgentThreadProps) {
  const runtimeKey = useMemo(
    () => getAgentThreadRuntimeKey({ agentId, conversationId: providedConversationId }),
    [agentId, providedConversationId],
  );

  return (
    <AgentThreadWithRuntime
      key={runtimeKey}
      agentId={agentId}
      isVisible={isVisible}
      callerToken={callerToken}
      onLabelUpdate={onLabelUpdate}
      onMessageCountChange={onMessageCountChange}
      modelConfig={modelConfig}
      didSwitchRuntimeDuringConversation={didSwitchRuntimeDuringConversation}
      codexThreadId={codexThreadId}
      onCodexThreadIdAssigned={onCodexThreadIdAssigned}
      workspacePath={workspacePath}
      startupId={startupId}
      requestId={requestId}
      initialMessage={initialMessage}
      systemPrompt={systemPrompt}
      emptyLabel={emptyLabel}
      isEditorPane={isEditorPane}
      onStartupConsumed={onStartupConsumed}
      suggestionOverlayHeight={suggestionOverlayHeight}
      onSuggestionOverlayOpacityChange={onSuggestionOverlayOpacityChange}
      readOnly={readOnly}
    />
  );
}

function AgentThreadWithRuntime({
  agentId,
  isVisible,
  callerToken,
  onLabelUpdate,
  onMessageCountChange,
  modelConfig,
  didSwitchRuntimeDuringConversation,
  codexThreadId,
  onCodexThreadIdAssigned,
  workspacePath,
  startupId,
  requestId,
  initialMessage,
  systemPrompt,
  emptyLabel,
  isEditorPane,
  onStartupConsumed,
  suggestionOverlayHeight,
  onSuggestionOverlayOpacityChange,
  readOnly,
}: {
  agentId: string;
  isVisible: boolean;
  callerToken: string;
  onLabelUpdate?: (agentId: string, label: string, isRunning: boolean) => void;
  onMessageCountChange?: (agentId: string, count: number) => void;
  modelConfig: AgentModelConfig;
  didSwitchRuntimeDuringConversation?: boolean;
  codexThreadId?: string;
  onCodexThreadIdAssigned?: (agentId: string, threadId: string) => void;
  workspacePath?: string;
  startupId?: string;
  requestId?: string;
  initialMessage?: string;
  systemPrompt?: string;
  emptyLabel: string;
  isEditorPane?: boolean;
  onStartupConsumed?: (agentId: string, startupId: string) => void;
  suggestionOverlayHeight?: number;
  onSuggestionOverlayOpacityChange?: (opacity: number) => void;
  readOnly: boolean;
}) {
  const { showToast } = useToast();
  const handleCommittedUserMessage = useCallback(({ text }: { text: string }) => {
    const pendingInput = findAgentPendingInputBySubmittedText(
      agentId,
      text,
      ['afterNextTool', 'interrupting'],
    );
    if (!pendingInput) {
      return false;
    }

    removeAgentPendingInput(agentId, pendingInput.id);
    setLastSentContext(agentId, pendingInput.contextSnapshot);
    return true;
  }, [agentId]);
  const {
    messages,
    streamingMessage,
    historyLoaded,
    hasOlderHistory,
    loadingOlderHistory,
    loadOlderHistory,
    isStreaming,
    error,
    errorDetails,
    errorEndpointBaseUrl,
    retrying,
    planChecklist,
    showError: showChatError,
    sendMessage: rawSendMessage,
    stopGeneration,
    stopBackgroundProcess,
    threadId,
  } = useChat(modelConfig.profileId || '', {
    agentId,
    callerToken,
    model: modelConfig.modelId,
    codexProfileId: modelConfig.codexProfileId,
    customEndpoint: modelConfig.baseURL,
    customApiKey: modelConfig.apiKey,
    reasoningEffort: modelConfig.reasoningEffort,
    initialThreadId: codexThreadId,
    workspacePath,
    system: systemPrompt,
    onCommittedUserMessage: handleCommittedUserMessage,
  });
  const previousErrorForToastRef = useRef<string | null>(null);
  const pendingInputs = useSyncExternalStore(
    subscribeAgentPendingInputs,
    () => getAgentPendingInputs(agentId),
    () => getAgentPendingInputs(agentId),
  );

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('persistent-layer:plan-update', {
      detail: {
        agentId,
        planChecklist,
      } satisfies { agentId: string; planChecklist: PlanChecklistState | null },
    }));
  }, [agentId, planChecklist]);

  const layout = useContext(LayoutContext);
  const layoutRef = useRef(layout);
  const { isAuthenticated, user } = useAuth();
  const { totalCredits: cachedInterpreterCredits } = useInterpreterTokenUsage();

  const voiceResetRef = useRef<{ enabled: boolean; phrase: string }>({
    enabled: false,
    phrase: '',
  });
  const consumedStartupIdsRef = useRef<Set<string>>(new Set());
  const pendingStartupConsumeIdsRef = useRef<Set<string>>(new Set());
  const closeOnStartupCompletionRef = useRef(false);
  const startupRunStartedRef = useRef(false);
  const startupCompletionRequestIdRef = useRef<string | null>(null);
  const currentTurnId = streamingMessage?.serverMessageId ?? null;

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    let canceled = false;

    void ttsIpc.getSettings()
      .then((response: TtsGetSettingsResponse) => {
        if (canceled) return;
        voiceResetRef.current = {
          enabled: response.settings.voiceResetEnabled,
          phrase: response.settings.voiceResetPhrase,
        };
      })
      .catch(() => {});

    const unsubscribe = ttsIpc.onSettingsChanged((event: TtsSettingsChangedEvent) => {
      voiceResetRef.current = {
        enabled: event.settings.voiceResetEnabled,
        phrase: event.settings.voiceResetPhrase,
      };
    });

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (startupCompletionRequestIdRef.current && isStreaming) {
      startupRunStartedRef.current = true;
      return;
    }

    if (!startupCompletionRequestIdRef.current || isStreaming || !startupRunStartedRef.current) {
      return;
    }

    const completionError = error ? String(error) : undefined;
    if (!threadId && !completionError) {
      return;
    }

    const completedRequestId = startupCompletionRequestIdRef.current;
    startupRunStartedRef.current = false;
    startupCompletionRequestIdRef.current = null;
    void agentTabs.completed({
      requestId: completedRequestId,
      ...(threadId ? { threadId } : {}),
      ...(completionError ? { error: completionError } : {}),
      messages,
    }).catch((error: unknown) => {
      console.error('[AgentThread] Failed to report startup completion', {
        agentId,
        requestId: completedRequestId,
        error,
      });
    });

    if (!closeOnStartupCompletionRef.current) {
      return;
    }
    closeOnStartupCompletionRef.current = false;
    layoutRef.current?.closeTab(agentId);
  }, [agentId, error, isStreaming, messages, threadId]);

  const enrichMessageWithRuntimeContext = useCallback((text: string) => {
    const ctx = layoutRef.current?.getWorkstationContext();
    if (!ctx) {
      return text;
    }

    const formatted = formatWorkstationContext(ctx);
    return `<${WORKSTATION_CONTEXT_TAG}>\n${formatted}\n</${WORKSTATION_CONTEXT_TAG}>\n${text}`;
  }, []);

  const isHostedInterpreterProfile = modelConfig.provider === 'hosted'
    && modelConfig.providerId === BUILTIN_PROVIDER_IDS.HOSTED;

  const hasAvailableInterpreterCredits = useCallback(async (): Promise<boolean> => {
    if (!isHostedInterpreterProfile) {
      return true;
    }

    if (!isAuthenticated || !user?.id) {
      return true;
    }

    if (typeof cachedInterpreterCredits === 'number' && cachedInterpreterCredits > 0) {
      return true;
    }

    let tokens: DesktopUserTokensRow | null = null;
    try {
      const { data, error } = await supabase
        .from('desktop_user_tokens')
        .select('monthly_tokens, purchased_tokens')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        return true;
      }
      if (!data) {
        return true;
      }
      tokens = data as DesktopUserTokensRow;
    } catch (checkError) {
      console.warn('[AgentThread] Failed to preflight Interpreter token balance', {
        agentId,
        error: checkError,
      });
      return true;
    }

    const remainingCredits = Math.max(
      0,
      Number(tokens.monthly_tokens ?? 0) + Number(tokens.purchased_tokens ?? 0),
    );
    return remainingCredits > 0;
  }, [
    agentId,
    cachedInterpreterCredits,
    isAuthenticated,
    isHostedInterpreterProfile,
    user,
  ]);

  const dispatchRuntimeMessage = useCallback((
    runtimeText: string,
    plainText: string,
    options?: {
      workspacePath?: string | null;
      attachments?: import('../../src/lib/codex/api-types').StreamImageAttachment[];
      messageSource?: MessageSendSource | null;
    },
  ) => {
    const { enabled, phrase } = voiceResetRef.current;
    console.log('[VoiceReset] check:', { enabled, phrase, textSnippet: plainText.slice(0, 100), agentId });
    if (enabled && phrase && plainText.toLowerCase().includes(phrase.toLowerCase())) {
      console.log('[VoiceReset] phrase matched — resetting agent tab', agentId);
      layoutRef.current?.resetAgentTab(agentId, { autoStartVoiceMode: true });
      return;
    }

    if (!isHostedInterpreterProfile || (typeof cachedInterpreterCredits === 'number' && cachedInterpreterCredits > 0)) {
      rawSendMessage(runtimeText, options);
      return;
    }

    void hasAvailableInterpreterCredits().then((hasCredits) => {
      if (!hasCredits) {
        showChatError(INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE);
        return;
      }

      rawSendMessage(runtimeText, options);
    });
  }, [
    agentId,
    cachedInterpreterCredits,
    hasAvailableInterpreterCredits,
    isHostedInterpreterProfile,
    rawSendMessage,
    showChatError,
  ]);

  const sendMessage = useCallback((
    text: string,
    options?: {
      workspacePath?: string | null;
      attachments?: import('../../src/lib/codex/api-types').StreamImageAttachment[];
      messageSource?: MessageSendSource | null;
    },
  ) => {
    dispatchRuntimeMessage(
      enrichMessageWithRuntimeContext(text),
      text,
      options,
    );
  }, [dispatchRuntimeMessage, enrichMessageWithRuntimeContext]);

  useEffect(() => {
    const activeStartupId = startupId;
    if (!activeStartupId) {
      return;
    }
    const startupIsReady = shouldConsumeProgrammaticStartup({
      startupId: activeStartupId,
      hasConsumedStartup: consumedStartupIdsRef.current.has(activeStartupId)
        || pendingStartupConsumeIdsRef.current.has(activeStartupId),
      messagesLength: messages.length,
      isStreaming,
      historyLoaded,
    });
    if (!startupIsReady) {
      console.info('[AgentThread] Startup pending', {
        agentId,
        startupId: activeStartupId,
        hasConsumedStartup: consumedStartupIdsRef.current.has(activeStartupId)
          || pendingStartupConsumeIdsRef.current.has(activeStartupId),
        messagesLength: messages.length,
        isStreaming,
        historyLoaded,
      });
      return;
    }

    pendingStartupConsumeIdsRef.current.add(activeStartupId);
    console.info('[AgentThread] Consuming startup', {
      agentId,
      startupId: activeStartupId,
    });
    void agentTabs.consumeStartup({
      agentId,
      startupId: activeStartupId,
    }).then((response: {
      success: boolean;
      startup: {
        initialMessage?: string;
        attachments?: import('../../src/lib/codex/api-types').StreamImageAttachment[];
        completionDisposition: 'keep_open' | 'close_tab';
      } | null;
      error?: string;
    }) => {
      pendingStartupConsumeIdsRef.current.delete(activeStartupId);
      if (!response.success) {
        console.error('[AgentThread] Failed to consume startup', {
          agentId,
          startupId: activeStartupId,
          error: response.error,
        });
        return;
      }

      consumedStartupIdsRef.current.add(activeStartupId);
      onStartupConsumed?.(agentId, activeStartupId);

      const startup = response.startup;
      if (!startup?.initialMessage) {
        console.info('[AgentThread] Startup consumed without initial message', {
          agentId,
          startupId: activeStartupId,
        });
        return;
      }

      closeOnStartupCompletionRef.current = startup.completionDisposition === 'close_tab';
      startupCompletionRequestIdRef.current = activeStartupId;
      startupRunStartedRef.current = false;
      const sendStartupMessage = systemPrompt?.trim()
        ? (messageText: string, sendOptions?: {
            attachments?: StreamImageAttachment[];
            workspacePath?: string | null;
            messageSource?: MessageSendSource | null;
          }) => dispatchRuntimeMessage(messageText, messageText, sendOptions)
        : sendMessage;
      console.info('[AgentThread] Sending startup message', {
        agentId,
        startupId: activeStartupId,
        hasAttachments: Boolean(startup.attachments?.length),
        completionDisposition: startup.completionDisposition,
      });
      sendStartupMessage(startup.initialMessage, {
        attachments: startup.attachments,
      });
    }).catch((error: unknown) => {
      pendingStartupConsumeIdsRef.current.delete(activeStartupId);
      console.error('[AgentThread] Startup consume threw', {
        agentId,
        startupId: activeStartupId,
        error,
      });
    });
  }, [
    agentId,
    historyLoaded,
    isStreaming,
    messages.length,
    onStartupConsumed,
    rawSendMessage,
    sendMessage,
    startupId,
    systemPrompt,
  ]);

  const [readAssistantMessages, setReadAssistantMessages] = useState(false);
  const ttsSentenceStateRef = useRef<{
    messageId: string | null;
    consumedChars: number;
    remainder: string;
    sentenceIndex: number;
  }>({
    messageId: null,
    consumedChars: 0,
    remainder: '',
    sentenceIndex: 0,
  });
  const wasStreamingRef = useRef(false);
  const skipNextTtsFlushRef = useRef(false);

  const allMessages = streamingMessage ? [...messages, streamingMessage] : messages;
  const hasInitializedActivityRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const unreadCountRef = useRef(0);
  const staleThreadToastRef = useRef<string | null>(null);

  const resetTtsSentenceState = useCallback(() => {
    ttsSentenceStateRef.current = {
      messageId: null,
      consumedChars: 0,
      remainder: '',
      sentenceIndex: 0,
    };
  }, []);

  const enqueueAssistantSentence = useCallback((text: string, messageId: string, sentenceIndex: number) => {
    const detail: AssistantTtsSentenceEnqueueDetail = {
      text,
      messageId,
      sentenceIndex,
      source: 'assistant-auto',
    };
    window.dispatchEvent(new CustomEvent<AssistantTtsSentenceEnqueueDetail>(ASSISTANT_TTS_ENQUEUE_EVENT, { detail }));
  }, []);

  useEffect(() => {
    const handleStop = () => {
      skipNextTtsFlushRef.current = true;
      resetTtsSentenceState();
    };

    window.addEventListener(ASSISTANT_TTS_STOP_EVENT, handleStop);
    return () => {
      window.removeEventListener(ASSISTANT_TTS_STOP_EVENT, handleStop);
    };
  }, [resetTtsSentenceState]);

  useEffect(() => {
    let canceled = false;

    void ttsIpc.getSettings()
      .then((response: TtsGetSettingsResponse) => {
        if (canceled) return;
        setReadAssistantMessages(response.settings.readAssistantMessages);
      })
      .catch((error: unknown) => {
        console.error('[TTS] Failed to load settings for assistant auto-read:', error);
      });

    const unsubscribe = ttsIpc.onSettingsChanged((event: TtsSettingsChangedEvent) => {
      setReadAssistantMessages(event.settings.readAssistantMessages);
    });

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (readAssistantMessages) return;
    resetTtsSentenceState();
  }, [readAssistantMessages, resetTtsSentenceState]);

  useEffect(() => {
    if (!readAssistantMessages) {
      wasStreamingRef.current = isStreaming;
      return;
    }

    const state = ttsSentenceStateRef.current;
    const assistantStreamingMessage = streamingMessage && streamingMessage.role === 'assistant'
      ? streamingMessage
      : null;

    if (assistantStreamingMessage) {
      if (state.messageId !== assistantStreamingMessage.id) {
        state.messageId = assistantStreamingMessage.id;
        state.consumedChars = 0;
        state.remainder = '';
        state.sentenceIndex = 0;
        skipNextTtsFlushRef.current = false;
      }

      const content = textContent(assistantStreamingMessage) ?? '';
      if (content.length < state.consumedChars) {
        state.consumedChars = 0;
        state.remainder = '';
      }

      const delta = content.slice(state.consumedChars);
      state.consumedChars = content.length;

      if (delta.length > 0) {
        const splitResult = splitStreamingTextIntoSentences(`${state.remainder}${delta}`);
        state.remainder = splitResult.remainder;
        for (const sentence of splitResult.completedSentences) {
          const spokenSentence = stripMarkdownForTts(sentence);
          if (spokenSentence.length === 0) {
            continue;
          }
          enqueueAssistantSentence(spokenSentence, assistantStreamingMessage.id, state.sentenceIndex);
          state.sentenceIndex += 1;
        }
      }
    }

    if (wasStreamingRef.current && !isStreaming && state.messageId) {
      if (!skipNextTtsFlushRef.current) {
        const tailSentence = flushSentenceRemainder(state.remainder);
        if (tailSentence) {
          const spokenSentence = stripMarkdownForTts(tailSentence);
          if (spokenSentence.length > 0) {
            enqueueAssistantSentence(spokenSentence, state.messageId, state.sentenceIndex);
          }
        }
      }
      skipNextTtsFlushRef.current = false;
      resetTtsSentenceState();
    }

    wasStreamingRef.current = isStreaming;
  }, [
    enqueueAssistantSentence,
    isStreaming,
    readAssistantMessages,
    resetTtsSentenceState,
    streamingMessage,
  ]);

  const queuePendingInput = useCallback(async (
    text: string,
    options?: {
      workspacePath?: string | null;
      contextSnapshot?: AgentPendingInput["contextSnapshot"];
      messageSource?: MessageSendSource | null;
      stage?: AgentPendingInput["stage"];
    },
  ): Promise<{ success: boolean }> => {
    const previewText = text.trim();
    if (!previewText) {
      return { success: false };
    }

    const stage = options?.stage ?? 'endOfTurn';
    addAgentPendingInput({
      id: crypto.randomUUID(),
      agentId,
      draftText: text,
      previewText,
      messageText: text,
      afterNextToolState: stage === 'afterNextTool' ? 'local' : null,
      submittedText: null,
      workspacePath: options?.workspacePath,
      contextSnapshot: options?.contextSnapshot ?? null,
      messageSource: options?.messageSource ?? null,
      stage,
      createdAt: Date.now(),
    });
    return { success: true };
  }, [agentId]);

  const steerPendingInput = useCallback(async (pendingInputId: string): Promise<void> => {
    const pendingInput = getAgentPendingInputs(agentId).find((input) => input.id === pendingInputId);
    if (!pendingInput) {
      return;
    }

    if (pendingInput.stage !== 'afterNextTool' || isAgentPendingInputSteerLocked(pendingInput)) {
      return;
    }

    if (!isStreaming) {
      updateAgentPendingInput(agentId, pendingInputId, (input) => ({
        ...input,
        stage: 'endOfTurn',
        afterNextToolState: null,
        submittedText: null,
      }));
      return;
    }

    if (!threadId || !currentTurnId) {
      return;
    }

    const runtimeText = enrichMessageWithRuntimeContext(pendingInput.messageText);
    updateAgentPendingInput(agentId, pendingInputId, (input) => ({
      ...input,
      submittedText: normalizeAgentPendingInputSubmittedText(runtimeText),
      stage: 'afterNextTool',
      afterNextToolState: 'submitting',
    }));

    const extracted = extractSkillMentionsFromText(runtimeText);

    const handleSteerFailure = (error: unknown) => {
      updateAgentPendingInput(agentId, pendingInputId, (input) => ({
        ...input,
        stage: 'endOfTurn',
        afterNextToolState: null,
        submittedText: null,
      }));

      const code = (error as Error & { code?: string }).code;
      if (code === 'active_turn_not_steerable') {
        showToast(tr('thread.toast.midTurnFollowUpUnavailable'), 'info', 5000);
        return;
      }
      if (code === 'other') {
        showToast(tr('thread.toast.afterToolCallSubmitFailed'), 'error', 7000);
      }
    };

    let response: Response;
    try {
      response = await fetch(await getApiUrl('/api/agent/chat/steer'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          turnId: currentTurnId,
          message: extracted.text,
          skills: extracted.skills,
        }),
      });
    } catch (error) {
      handleSteerFailure(error);
      return;
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      let errorMessage = 'Failed to steer turn.';
      let errorCode: string | undefined;
      if (payload) {
        if (payload.error) {
          errorMessage = payload.error;
        }
        errorCode = payload.code;
      }
      const error = new Error(errorMessage);
      (error as Error & { code?: string }).code = errorCode;
      handleSteerFailure(error);
      return;
    }

    updateAgentPendingInput(agentId, pendingInputId, (input) => ({
      ...input,
      submittedText: normalizeAgentPendingInputSubmittedText(runtimeText),
      stage: 'afterNextTool',
      afterNextToolState: 'submitted',
    }));
  }, [
    agentId,
    currentTurnId,
    enrichMessageWithRuntimeContext,
    isStreaming,
    showToast,
    threadId,
  ]);

  useEffect(() => {
    if (!isStreaming || !threadId || !currentTurnId) {
      return;
    }

    const pendingSteer = pendingInputs.find((input) => (
      input.stage === 'afterNextTool'
      && input.afterNextToolState === 'local'
    ));
    if (!pendingSteer) {
      return;
    }

    void steerPendingInput(pendingSteer.id);
  }, [
    currentTurnId,
    isStreaming,
    pendingInputs,
    steerPendingInput,
    threadId,
  ]);

  useEffect(() => {
    const handleSend = (e: CustomEvent<AgentRuntimeSendDetail>) => {
      if (e.detail.tabId !== agentId) return;
      const text = e.detail.text.trim();
      const attachments = e.detail.attachments ?? [];
      if (!text && attachments.length === 0) return;
      if (isStreaming) {
        if (attachments.length > 0) {
          showToast(tr('thread.toast.imageFollowUpAfterResponse'), 'error', 7000);
          return;
        }
        void queuePendingInput(text, {
          workspacePath: e.detail.workspacePath,
          messageSource: e.detail.messageSource,
          stage: 'afterNextTool',
        });
        return;
      }
      sendMessage(text, {
        workspacePath: e.detail.workspacePath,
        attachments,
        messageSource: e.detail.messageSource,
      });
    };

    const handleSteer = (e: CustomEvent<AgentRuntimeSteerDetail>) => {
      if (e.detail.tabId !== agentId) return;
      void steerPendingInput(e.detail.pendingInputId);
    };

    const handleGetState = (e: CustomEvent<{ tabId: string; callback: (state: { isRunning: boolean }) => void }>) => {
      if (e.detail.tabId !== agentId) return;
      e.detail.callback({ isRunning: isStreaming });
    };

    const handleCancel = (e: CustomEvent<{ tabId: string }>) => {
      if (e.detail.tabId !== agentId) return;
      updateAgentPendingInputs(agentId, moveUnlockedAfterNextToolInputsToEndOfTurn);
      stopGeneration();
    };

    window.addEventListener('agent-runtime:send', handleSend as EventListener);
    window.addEventListener(AGENT_RUNTIME_STEER_EVENT, handleSteer as EventListener);
    window.addEventListener('agent-runtime:get-state', handleGetState as EventListener);
    window.addEventListener('agent-runtime:cancel', handleCancel as EventListener);

    return () => {
      window.removeEventListener('agent-runtime:send', handleSend as EventListener);
      window.removeEventListener(AGENT_RUNTIME_STEER_EVENT, handleSteer as EventListener);
      window.removeEventListener('agent-runtime:get-state', handleGetState as EventListener);
      window.removeEventListener('agent-runtime:cancel', handleCancel as EventListener);
    };
  }, [agentId, isStreaming, queuePendingInput, sendMessage, showToast, steerPendingInput, stopGeneration]);

  useEffect(() => {
    if (isStreaming) {
      return;
    }

    if (hasLockedAfterNextToolPendingInput(pendingInputs)) {
      return;
    }

    if (pendingInputs.some((input) => input.stage === 'afterNextTool')) {
      updateAgentPendingInputs(agentId, moveUnlockedAfterNextToolInputsToEndOfTurn);
      return;
    }

    const nextInput = getNextDispatchableAgentPendingInput(agentId);
    if (!nextInput) {
      return;
    }

    removeAgentPendingInput(agentId, nextInput.id);
    setLastSentContext(agentId, nextInput.contextSnapshot);

    const runtimeText = enrichMessageWithRuntimeContext(nextInput.messageText);
    dispatchRuntimeMessage(runtimeText, nextInput.messageText, {
      workspacePath: nextInput.workspacePath,
      messageSource: nextInput.messageSource,
    });
  }, [
    agentId,
    dispatchRuntimeMessage,
    enrichMessageWithRuntimeContext,
    isStreaming,
    pendingInputs,
  ]);

  const queueAfterNextTool = useCallback(async (text: string): Promise<{ success: boolean }> => {
    return queuePendingInput(text, { stage: 'afterNextTool' });
  }, [queuePendingInput]);

  const sendNow = useCallback((text: string) => {
    sendMessage(text);
  }, [sendMessage]);

  useAgentNotifications({
    agentId,
    isRunning: isStreaming,
    queueAfterNextTool,
    sendNow,
  });

  useEffect(() => {
    if (!threadId || !onCodexThreadIdAssigned) return;
    onCodexThreadIdAssigned(agentId, threadId);
  }, [agentId, onCodexThreadIdAssigned, threadId]);

  useEffect(() => {
    // This effect re-runs on every render where `error` is set, but we only want
    // to show the toast once per error. previousErrorForToastRef remembers the
    // last error we already toasted; if it hasn't changed, do nothing this time.
    if (error === previousErrorForToastRef.current) {
      return;
    }
    previousErrorForToastRef.current = error;
    if (error === INSUFFICIENT_INTERPRETER_TOKENS_MESSAGE) {
      showToast(tr(INSUFFICIENT_INTERPRETER_TOKENS_KEY), 'error', 8000);
    }
  }, [error, showToast]);

  useEffect(() => {
    const recoveredThreadId = getRecoveredStaleThreadIdForToast({
      initialThreadId: codexThreadId,
      historyLoaded,
      threadId,
      messagesLength: messages.length,
      error,
    });
    if (!recoveredThreadId || staleThreadToastRef.current === recoveredThreadId) return;
    staleThreadToastRef.current = recoveredThreadId;
    showToast(tr('thread.toast.previousChatUnavailable'), 'info', 5000);
  }, [codexThreadId, error, historyLoaded, messages.length, showToast, threadId]);

  useEffect(() => {
    if (!onMessageCountChange) return;
    onMessageCountChange(agentId, messages.length);
  }, [messages.length, agentId, onMessageCountChange]);

  useEffect(() => {
    if (!historyLoaded) return;

    const unreadCount = computeUnreadCount({
      hasInitialized: hasInitializedActivityRef.current,
      previousMessageCount: previousMessageCountRef.current,
      nextMessageCount: messages.length,
      previousUnreadCount: unreadCountRef.current,
      isVisible,
    });

    const prevUnread = unreadCountRef.current;
    const prevMsgCount = previousMessageCountRef.current;

    hasInitializedActivityRef.current = true;
    previousMessageCountRef.current = messages.length;
    unreadCountRef.current = unreadCount;

    // Skip store update if nothing actually changed — avoids a
    // feedback loop where a tab-switch visibility flip triggers
    // useAgentActivityMap → EditorLayout re-render → cascade.
    if (unreadCount === prevUnread && messages.length === prevMsgCount) return;

    updateAgentActivity(agentId, {
      messageCount: messages.length,
      unreadCount,
    });
    void agentTabs.reportActivity({
      agentId,
      activity: {
        messageCount: messages.length,
        unreadCount,
      },
    });
  }, [agentId, historyLoaded, isVisible, messages.length]);

  useEffect(() => {
    const last = allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    const lastMessagePreview = last
      ? stripWorkstationContext(textContent(last) || '').trim().slice(0, 200)
      : '';
    const label = lastMessagePreview ? lastMessagePreview.slice(0, 100) : emptyLabel;
    const updatedAt = lastMessagePreview ? new Date().toISOString() : null;

    updateAgentActivity(agentId, {
      label,
      isRunning: isStreaming,
      lastMessagePreview,
      updatedAt,
    });
    void agentTabs.reportActivity({
      agentId,
      activity: {
        label,
        isRunning: isStreaming,
        lastMessagePreview,
        updatedAt,
      },
    });

    if (!onLabelUpdate) return;
    onLabelUpdate(agentId, label, isStreaming);
  }, [allMessages, agentId, emptyLabel, onLabelUpdate, isStreaming]);

  useEffect(() => {
    return () => {
      removeAgentActivity(agentId);
    };
  }, [agentId]);

  const hasSentInitialRef = useRef(false);
  useEffect(() => {
    if (!shouldSendInitialMessage({
      initialMessage,
      requestId,
      hasSentInitial: hasSentInitialRef.current,
      messagesLength: messages.length,
      isStreaming,
      historyLoaded,
    })) return;
    hasSentInitialRef.current = true;
    sendMessage(initialMessage!);
  }, [initialMessage, requestId, messages.length, isStreaming, historyLoaded, sendMessage]);

  const openSettings = layout?.openSettings;
  const retryWithContinue = useCallback(() => {
    sendMessage('Continue');
  }, [sendMessage]);
  const startNewChatWithHistory = useCallback(() => {
    const prompt = buildConversationRestartPrompt(messages);
    const newAgentId = layoutRef.current?.resetAgentTab(agentId);
    if (!newAgentId) {
      return;
    }
    seedComposerForAgent(newAgentId, prompt);
  }, [agentId, messages]);

  return (
    <div
      className="agent-thread app-agent-thread-surface"
      data-testid={AGENT_THREAD_ID(agentId)}
      data-active={isVisible.toString()}
      style={{
        display: isVisible ? 'flex' : 'none',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        width: '100%',
        overflow: 'hidden',
        background: 'transparent',
        color: 'var(--oa-text, var(--foreground))',
      }}
      data-agent-id={agentId}
    >
      {threadId ? <ThreadGoalBar threadId={threadId} readOnly={readOnly} /> : null}
      <ThreadMessages
        agentId={agentId}
        messages={messages}
        streamingMessage={streamingMessage}
        isStreaming={isStreaming}
        error={error}
        errorDetails={errorDetails}
        errorEndpointBaseUrl={errorEndpointBaseUrl}
        retrying={retrying}
        historyLoaded={historyLoaded}
        hasOlderHistory={hasOlderHistory}
        loadingOlderHistory={loadingOlderHistory}
        onLoadOlderHistory={loadOlderHistory}
        activeThreadId={threadId}
        onStopBackgroundProcess={readOnly ? undefined : stopBackgroundProcess}
        isEditorPane={isEditorPane}
        openSettings={readOnly ? undefined : openSettings}
        onStartNewChatWithHistory={readOnly ? undefined : startNewChatWithHistory}
        onRetry={readOnly ? undefined : retryWithContinue}
        showProfileSwitchWarning={didSwitchRuntimeDuringConversation === true}
        suggestionOverlayHeight={suggestionOverlayHeight}
        onSuggestionOverlayOpacityChange={onSuggestionOverlayOpacityChange}
        providerLabel={
          modelConfig.provider === 'local'
            ? (modelConfig.codexProfileId ?? 'local')
            : modelConfig.provider === 'api'
              ? (findSupportedResponsesApiBaseUrlOption(modelConfig.baseURL)?.id ?? 'api')
              : modelConfig.provider
        }
      />
    </div>
  );
}
