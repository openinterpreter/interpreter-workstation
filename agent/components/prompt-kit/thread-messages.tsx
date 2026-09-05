import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2, Play, Square } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import {
  draftHasVisibleContent,
  textContent,
  type ChatMessage,
  type ToolCallInfo,
} from '../../../src/hooks/use-chat';
import { tts as ttsIpc } from '../../../src/ipc';
import { showContextMenu, type ContextMenuItem } from '../../../src/ipc';
import {
  DetachedToolCallRail,
  ToolCallGroup,
  type DetachedToolCall,
} from './tool-fallback';
import { Markdown } from './markdown';
import { TextShimmer } from './text-shimmer';
import { ThreadErrorWithLayout } from './thread-error-display';
import {
  stripMarkdownForTtsHighlight,
  splitTextForTtsPlayback,
} from '../../utils/ttsSentenceQueue';
import {
  ChatContainerRoot,
  ChatContainerContent,
  ChatContainerScrollAnchor,
  ScrollToBottomButton,
} from './chat-container';
import { stripWorkstationContext } from '../../../shared/utils/formatWorkstationContext';
import {
  TYPING_INDICATOR_ID,
  TYPING_INDICATOR_DOT_CLASS,
  USER_MESSAGE_CONTENT_ID,
  MESSAGE_ID,
} from '../../../shared/element-ids';
import {
  buildVerticalEdgeMask,
} from '../../../src/components/ui/ProgressiveBlurOverlay';
import {
  AssistantActivityIndicator,
} from './assistant-activity-indicator';
import { AnimatedCopyButton, MessageActionButton } from '../../../src/components/ui/message-action-button';
import { cn } from '../../../src/lib/utils';
import { tr } from '../../../src/i18n';
import { collapsePastedContentToLabels } from '../composer/attachment/pastedContent';
import { copyTextToClipboard } from '../../../src/utils/clipboard';
import { AttachmentChipBody } from '../composer/attachment/AttachmentChipBody';
import '../composer/attachment/attachment.css';

const ASSISTANT_TTS_STOP_EVENT = 'assistant-tts:stop';
const ASSISTANT_TTS_ENQUEUE_EVENT = 'assistant-tts:enqueue-sentence';
const ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT = 'assistant-tts:message-speaking';
const ASSISTANT_TTS_MANUAL_PLAY_REQUEST_EVENT = 'assistant-tts:manual-play-request';

interface AssistantTtsSentenceEnqueueDetail {
  text: string;
  messageId: string;
  sentenceIndex: number;
  source?: 'assistant-auto' | 'manual';
}

interface AssistantTtsManualPlayRequestDetail {
  agentId: string;
  messageId: string;
  sentences: string[];
  modelId: string;
}

interface AssistantTtsMessageSpeakingDetail {
  messageId: string | null;
  sentenceIndex: number | null;
  text: string | null;
}

export interface ActiveSpeakingSentence {
  messageId: string | null;
  sentenceIndex: number | null;
  text: string | null;
}

export function isSelectedTtsModelInstalled(
  selectedModelId: string,
  models: Array<{ id: string; installed: boolean }>,
): boolean {
  return models.some((model) => model.id === selectedModelId && model.installed);
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function isCompactionMessage(content: string): boolean {
  return content.includes('<compaction');
}

function isSystemNotification(content: string): boolean {
  const text = content.trim();
  const openingPrefix = '<system-notification source="';
  const closingTag = '</system-notification>';
  if (!text.startsWith(openingPrefix) || !text.endsWith(closingTag)) return false;
  const openingTagEnd = text.indexOf('>');
  if (openingTagEnd === -1) return false;
  const openingTag = text.slice(0, openingTagEnd + 1);
  if (!openingTag.endsWith('">')) return false;
  const source = openingTag.slice(openingPrefix.length, -2);
  return source.length > 0 && !source.includes('"');
}

export function shouldShowIdleStreamingActivity({
  isUser,
  isStreaming,
  showTextActivity,
  hasRunningToolCall,
}: {
  isUser: boolean;
  isStreaming: boolean | undefined;
  showTextActivity: boolean;
  hasRunningToolCall: boolean;
}): boolean {
  return Boolean(
    !isUser &&
    isStreaming &&
    !showTextActivity &&
    !hasRunningToolCall,
  );
}

function messageEndsWithLiveActivity({
  message,
  isStreaming,
}: {
  message: ChatMessage;
  isStreaming: boolean;
}): boolean {
  if (!isStreaming || message.role !== 'assistant') {
    return false;
  }

  const groups = groupMessageParts(message.parts);
  const lastGroup = groups[groups.length - 1];
  const showTextActivity = Boolean(
    lastGroup
    && lastGroup.type === 'text'
    && lastGroup.content.trim().length > 0,
  );
  const hasRunningToolCall = message.parts.some(
    (part) => part.kind === 'tool-call' && part.toolCall.state === 'loading',
  );

  return shouldShowIdleStreamingActivity({
    isUser: false,
    isStreaming,
    showTextActivity,
    hasRunningToolCall,
  }) || Boolean(
    lastGroup?.type === 'activity-group'
    && lastGroup.toolCalls.some((toolCall) => toolCall.state === 'loading'),
  );
}

export function shouldShowTrailingRunningIndicator({
  isStreaming,
  showOptimisticThinking,
  visibleStreamingMessage,
  detachedToolCalls,
}: {
  isStreaming: boolean;
  showOptimisticThinking: boolean;
  visibleStreamingMessage: ChatMessage | null;
  detachedToolCalls: DetachedToolCall[];
}): boolean {
  if (!isStreaming) {
    return false;
  }

  if (showOptimisticThinking) {
    return false;
  }

  if (detachedToolCalls.length > 0) {
    return false;
  }

  if (!visibleStreamingMessage) {
    return true;
  }

  return !messageEndsWithLiveActivity({
    message: visibleStreamingMessage,
    isStreaming,
  });
}

export function getStreamingTailKind({
  showOptimisticThinking,
  visibleStreamingMessage,
  reasoningHandoffActive,
}: {
  showOptimisticThinking: boolean;
  visibleStreamingMessage: ChatMessage | null;
  reasoningHandoffActive: boolean;
}): 'optimistic' | 'message' | 'none' {
  if (showOptimisticThinking) {
    return 'optimistic';
  }

  if (visibleStreamingMessage && !reasoningHandoffActive) {
    return 'message';
  }

  return 'none';
}

// ---------------------------------------------------------------------------
// TypingDots
// ---------------------------------------------------------------------------

export function TypingDots() {
  return (
    <span
      className="inline-flex items-center"
      data-testid={TYPING_INDICATOR_ID}
    >
      <AssistantActivityIndicator
        className={TYPING_INDICATOR_DOT_CLASS}
      />
    </span>
  );
}

function TrailingRunningIndicator() {
  return (
    <div
      className="w-full max-w-[var(--thread-max-width)] mx-auto"
      style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}
    >
      <div className="flex items-center justify-start pt-3 pb-2">
        <AssistantActivityIndicator
          size={9}
          className="ml-1"
          testId="thread-trailing-running-indicator"
        />
      </div>
    </div>
  );
}

function advancePacedIndex(text: string, current: number): number {
  if (current >= text.length) {
    return text.length;
  }

  const remaining = text.length - current;
  const step = remaining > 220
    ? 24
    : remaining > 120
      ? 18
      : remaining > 48
        ? 10
        : 4;
  const target = Math.min(text.length, current + step);

  if (target === text.length) {
    return target;
  }

  for (let cursor = target; cursor > current; cursor -= 1) {
    const value = text[cursor - 1];
    if (value && /[\s.,!?;:)\]}]/.test(value)) {
      return cursor;
    }
  }

  return target;
}

function usePacedText(text: string, active: boolean): string {
  const [visible, setVisible] = useState(() => active ? '' : text);

  useEffect(() => {
    if (!active) {
      setVisible(text);
      return;
    }

    if (!text) {
      setVisible('');
      return;
    }

    if (!text.startsWith(visible)) {
      setVisible(text);
      return;
    }

    if (visible.length >= text.length) {
      return;
    }

    const timer = window.setTimeout(() => {
      setVisible((value) => {
        if (!text.startsWith(value)) {
          return text;
        }

        return text.slice(0, advancePacedIndex(text, value.length));
      });
    }, 24);

    return () => {
      window.clearTimeout(timer);
    };
  }, [active, text, visible]);

  return active ? visible : text;
}

type MessagePartGroup =
  | { type: 'text'; content: string }
  | { type: 'activity-group'; toolCalls: ToolCallInfo[] };

export type OrphanApprovalAnchor =
  | { kind: 'activity-group'; messageId: string; groupIndex: number }
  | { kind: 'empty'; messageId: string };

export function collectLastAssistantMessageIdsInTurns(
  messages: ChatMessage[],
  streamingMessage: ChatMessage | null,
): Set<string> {
  const ordered = streamingMessage ? [...messages, streamingMessage] : messages;
  const ids = new Set<string>();

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (!current || current.role !== 'assistant') {
      continue;
    }

    const next = ordered[index + 1];
    if (next?.role === 'assistant') {
      continue;
    }

    ids.add(current.id);
  }

  return ids;
}

export function groupMessageParts(parts: ChatMessage['parts']): MessagePartGroup[] {
  const nextGroups: MessagePartGroup[] = [];

  for (const part of parts) {
    if (part.kind === 'text') {
      nextGroups.push({ type: 'text', content: part.content });
      continue;
    }

    const lastGroup = nextGroups[nextGroups.length - 1];
    if (lastGroup && lastGroup.type === 'activity-group') {
      lastGroup.toolCalls.push(part.toolCall);
    } else {
      nextGroups.push({ type: 'activity-group', toolCalls: [part.toolCall] });
    }
  }

  return nextGroups;
}

export function settleInactiveReasoningParts(
  parts: ChatMessage['parts'],
  isStreaming: boolean,
): ChatMessage['parts'] {
  if (isStreaming) {
    return parts;
  }

  let changed = false;
  const nextParts = parts.map((part) => {
    if (
      part.kind !== 'tool-call'
      || part.toolCall.type !== 'reasoning'
      || part.toolCall.state !== 'loading'
    ) {
      return part;
    }

    changed = true;
    return {
      kind: 'tool-call' as const,
      toolCall: {
        ...part.toolCall,
        state: 'complete' as const,
      },
    };
  });

  return changed ? nextParts : parts;
}

export function collectToolCallIds(groups: MessagePartGroup[]): Set<string> {
  const toolCallIds = new Set<string>();

  for (const group of groups) {
    if (group.type === 'text') {
      continue;
    }

    for (const toolCall of group.toolCalls) {
      if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
        toolCallIds.add(toolCall.id);
      }
    }
  }

  return toolCallIds;
}

export function collectDetachedToolCalls(
  messages: ChatMessage[],
  streamingMessage: ChatMessage | null,
): DetachedToolCall[] {
  const allMessages = streamingMessage ? [...messages, streamingMessage] : messages;
  const timeline: Array<{ kind: 'text' } | { kind: 'tool'; toolCall: ToolCallInfo }> = [];

  for (const message of allMessages) {
    for (const part of message.parts) {
      if (part.kind === 'text') {
        if (part.content.trim().length > 0) {
          timeline.push({ kind: 'text' });
        }
        continue;
      }

      timeline.push({
        kind: 'tool',
        toolCall: part.toolCall,
      });
    }
  }

  const detached: DetachedToolCall[] = [];
  const seen = new Set<string>();
  let hasLaterContent = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (!entry) {
      continue;
    }

    if (entry.kind === 'text') {
      hasLaterContent = true;
      continue;
    }

    const isExplicitBackgroundWait = entry.toolCall.backgroundState === 'waiting'
      || entry.toolCall.backgroundState === 'interacted';
    const isReasoning = entry.toolCall.type === 'reasoning';

    if (
      !isReasoning
      && typeof entry.toolCall.id === 'string'
      && entry.toolCall.id.length > 0
      && entry.toolCall.state === 'loading'
      && (isExplicitBackgroundWait || hasLaterContent)
      && !seen.has(entry.toolCall.id)
    ) {
      seen.add(entry.toolCall.id);
      detached.unshift({
        toolCallId: entry.toolCall.id,
        toolCall: entry.toolCall,
      });
    }

    hasLaterContent = true;
  }

  return detached;
}

function isVisibleBackgroundTarget(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
}

function flashBackgroundTarget(node: HTMLElement) {
  node.classList.remove('animate-highlight');
  // Force restart so repeated reveals stay visible.
  void node.offsetWidth;
  node.classList.add('animate-highlight');
}

function isApprovalAnchorEligibleMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') {
    return false;
  }

  const rawContent = textContent(message).trim();
  if (isCompactionMessage(rawContent)) {
    return false;
  }
  if (isSystemNotification(rawContent)) {
    return false;
  }

  return true;
}

export function getOrphanApprovalAnchor(
  messages: ChatMessage[],
  streamingMessage: ChatMessage | null,
): OrphanApprovalAnchor | null {
  const allMessages = streamingMessage ? [...messages, streamingMessage] : messages;

  for (let messageIndex = allMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = allMessages[messageIndex];
    if (!message || !isApprovalAnchorEligibleMessage(message)) {
      continue;
    }

    const groups = groupMessageParts(message.parts);
    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
      const group = groups[groupIndex];
      if (
        group?.type === 'activity-group'
        && group.toolCalls.some((toolCall) => toolCall.state === 'loading')
      ) {
        return {
          kind: 'activity-group',
          messageId: message.id,
          groupIndex,
        };
      }
    }
  }

  for (let messageIndex = allMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = allMessages[messageIndex];
    if (!message || !isApprovalAnchorEligibleMessage(message)) {
      continue;
    }

    const groups = groupMessageParts(message.parts);
    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
      if (groups[groupIndex]?.type === 'activity-group') {
        return {
          kind: 'activity-group',
          messageId: message.id,
          groupIndex,
        };
      }
    }

    return { kind: 'empty', messageId: message.id };
  }

  return null;
}

// ---------------------------------------------------------------------------
// OptimisticThinkingLoader
// ---------------------------------------------------------------------------

export function OptimisticThinkingLoader({
  previousRole,
  textOverride,
  showDisclosure = false,
}: {
  previousRole?: 'user' | 'assistant' | null;
  textOverride?: string | null;
  showDisclosure?: boolean;
}) {
  const [cycleOffset, setCycleOffset] = useState(() => Math.floor(Math.random() * OPTIMISTIC_THINKING_MESSAGES.length));
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStepIndex((current) => {
        const next = (current + 1) % (OPTIMISTIC_THINKING_MESSAGES.length + 1);
        if (next === 0) {
          setCycleOffset(Math.floor(Math.random() * OPTIMISTIC_THINKING_MESSAGES.length));
        }
        return next;
      });
    }, OPTIMISTIC_THINKING_STAGE_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const cycledText = stepIndex < OPTIMISTIC_THINKING_MESSAGES.length
    ? OPTIMISTIC_THINKING_MESSAGES[(cycleOffset + stepIndex) % OPTIMISTIC_THINKING_MESSAGES.length]!
    : OPTIMISTIC_THINKING_SLOW_MESSAGE;
  const text = textOverride ?? cycledText;

  return (
    <div
      className={cn(
        'oa-thread-message oa-thread-message--assistant group w-full',
        previousRole ? (previousRole === 'assistant' ? 'oa-thread-message--continuation' : 'oa-thread-message--turn-gap') : undefined,
      )}
    >
      <div
        className="w-full max-w-[var(--thread-max-width)] mx-auto"
        style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}
      >
        <div
          className="oa-thread-message-shell transition-colors"
          style={{ paddingTop: '2px' }}
        >
          <div className="thread-message-select break-words text-[15px] leading-[1.7rem] text-foreground">
            <div className="oa-thread-message-group-gap">
              <div
                className="oa-tool-call oa-tool-call--optimistic"
                aria-live="polite"
                data-disclosure-visible={showDisclosure ? 'true' : undefined}
              >
                <div className="oa-tool-trigger-button">
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <div className="oa-inline-disclosure-row min-w-0 flex flex-1 items-center">
                      <TextShimmer text={text} active className="oa-tool-title" />
                      <span aria-hidden="true" className="oa-tool-disclosure">
                        <ChevronRight className="size-4" />
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompactionDivider
// ---------------------------------------------------------------------------

export function CompactionDivider() {
  return (
    <div
      className="w-full max-w-[var(--thread-max-width)] mx-auto"
      style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}
    >
      <div className="flex items-center gap-2 py-4 text-muted-foreground">
        <div
          className="flex-1"
          style={{ borderTop: 'var(--border-width) dashed var(--border)' }}
        />
        <span className="text-ui-xs whitespace-nowrap">
          Conversation Compacted
        </span>
        <div
          className="flex-1"
          style={{ borderTop: 'var(--border-width) dashed var(--border)' }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StickyUserMessageHeader
// ---------------------------------------------------------------------------

interface StickyUserMessageContextValue {
  registerMessage: (id: string, content: string, element: HTMLElement) => void;
  unregisterMessage: (id: string) => void;
}

const StickyUserMessageContext = createContext<StickyUserMessageContextValue>({
  registerMessage: () => {},
  unregisterMessage: () => {},
});

const WIDE_USER_MESSAGE_BREAKPOINT = 640;
const EDITOR_TOP_FADE = '42px';
const SIDEBAR_TOP_FADE = '52px';
const EDITOR_BOTTOM_FADE =
  'calc(var(--thread-scroll-bottom-clearance, 7rem) * 0.52)';
const SIDEBAR_BOTTOM_FADE =
  'calc(var(--thread-scroll-bottom-clearance, 7rem) * 0.56)';
const THREAD_HORIZONTAL_INSET = 'var(--unit-padding-medium)';
const EDITOR_THREAD_TOP_INSET = 'calc(var(--unit-padding) * 2.5)';
const SIDEBAR_THREAD_TOP_INSET = 'calc(var(--unit-padding) * 1.75)';
const OPTIMISTIC_THINKING_MESSAGES = [
  tr('thread.optimistic.interpreting'),
  tr('thread.optimistic.working'),
  tr('thread.optimistic.onMyWay'),
] as const;
const OPTIMISTIC_THINKING_SLOW_MESSAGE = tr('thread.optimistic.slow');
const OPTIMISTIC_THINKING_STAGE_MS = 5000;
const REASONING_HANDOFF_HOLD_MS = 5000;

function isReasoningHandoffCandidate(message: ChatMessage | null): boolean {
  if (!message) {
    return false;
  }

  const groups = groupMessageParts(message.parts);
  const hasVisibleText = groups.some(
    (group) => group.type === 'text' && group.content.trim().length > 0,
  );
  if (hasVisibleText) {
    return false;
  }

  return groups.some(
    (group) => group.type === 'activity-group' && group.toolCalls.some((toolCall) => toolCall.type === 'reasoning'),
  );
}

export function UserMessageBubble({
  content,
  attachments = [],
  isPinned = false,
  isWideLayout = false,
  onClick,
}: {
  content: string;
  attachments?: Array<{ id: string; kind: 'image'; name: string }>;
  isPinned?: boolean;
  isWideLayout?: boolean;
  onClick?: () => void;
}) {
  const outerJustify = 'flex justify-end';
  const bubbleWidthStyle = {
    width: 'fit-content',
    maxWidth: isWideLayout
      ? 'min(100%, calc(var(--thread-max-width) * 0.72))'
      : 'min(100%, calc(var(--thread-max-width) * 0.84))',
  };
  const pinnedPreview = useMemo(
    () => stripMarkdownForTtsHighlight(collapsePastedContentToLabels(content)),
    [content],
  );

  return (
    <div
      className="w-full max-w-[var(--thread-max-width)] mx-auto"
      style={{
        padding: `0 ${THREAD_HORIZONTAL_INSET}`,
      }}
    >
      <div className={outerJustify}>
        <div
          data-testid={isPinned ? undefined : USER_MESSAGE_CONTENT_ID}
          className={cn('thread-message-select', isPinned ? 'oa-user-message-bubble--pinned' : undefined)}
          onClick={onClick}
          style={{
            color: 'var(--oa-text, var(--foreground))',
            background:
              'var(--oa-composer-surface, var(--oa-bg-input, var(--background)))',
            border:
              'var(--border-width) solid var(--oa-composer-border, var(--oa-border, var(--border)))',
            borderRadius: 'var(--oa-radius-18)',
            padding: '0.5rem 1rem',
            boxShadow:
              'var(--oa-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.04))',
            ...bubbleWidthStyle,
          }}
        >
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="composer-attachment-chip"
                  data-attachment-kind="pasted-text"
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    borderColor: 'rgba(255, 255, 255, 0.14)',
                    color: 'var(--oa-text, var(--foreground))',
                  }}
                >
                  <AttachmentChipBody
                    kind="pasted-text"
                    label={attachment.name}
                  />
                </span>
              ))}
            </div>
          ) : null}
          {isPinned ? (
            <div
              className="oa-user-message-markdown oa-user-message-markdown--pinned text-[15px] leading-6"
              dir="auto"
            >
              {pinnedPreview}
            </div>
          ) : (
            content.trim().length > 0 ? (
              <Markdown
                className="oa-user-message-markdown break-words text-[15px] leading-6"
                renderFileCollections={false}
              >
                {content}
              </Markdown>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}

interface UserMessageEntry {
  index: number;
  id: string;
  content: string;
}

function useStickyUserMessageHeader({
  scrollContainer,
  isWideUserLayout,
  topOffset,
  userMessageEntries,
  virtualizer,
  virtualBlockTop,
}: {
  scrollContainer: HTMLElement | null;
  isWideUserLayout: boolean;
  topOffset: string;
  userMessageEntries: UserMessageEntry[];
  virtualizer: Virtualizer<HTMLElement, Element> | null;
  // Pixel offset from the scroll container's top to the start of the
  // virtualized messages block. Sticky calculations need to compare
  // scrollTop against an absolute item offset, not the virtualizer-local one.
  virtualBlockTop: number;
}) {
  // Kept as a no-op shim so per-message register/unregister calls in MessageBubble
  // remain valid. Position-based sticky no longer depends on DOM refs.
  const contextValue = useMemo<StickyUserMessageContextValue>(
    () => ({
      registerMessage: () => {},
      unregisterMessage: () => {},
    }),
    [],
  );

  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [pinnedContent, setPinnedContent] = useState<string | null>(null);
  const [transitionDirection, setTransitionDirection] = useState<'up' | 'down'>('down');
  const prevPinnedIdRef = useRef<string | null>(null);
  const lastScrollTopRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const lastUpdateRef = useRef(0);

  // Look up entries by id without recomputing in the scroll hot path.
  const entriesById = useMemo(() => {
    const map = new Map<string, UserMessageEntry>();
    for (const entry of userMessageEntries) map.set(entry.id, entry);
    return map;
  }, [userMessageEntries]);

  const computePinned = useCallback(() => {
    if (!scrollContainer || !virtualizer || userMessageEntries.length === 0) {
      if (prevPinnedIdRef.current !== null) {
        prevPinnedIdRef.current = null;
        setPinnedId(null);
        setPinnedContent(null);
      }
      return;
    }

    const scrollTop = scrollContainer.scrollTop;
    const scrollingDown = scrollTop >= lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    const cache = virtualizer.measurementsCache;
    let candidate: UserMessageEntry | null = null;

    for (const entry of userMessageEntries) {
      const measurement = cache[entry.index];
      // If a message hasn't been measured yet (never been near the viewport),
      // we can't decide whether it's scrolled past. Skip; estimate is unreliable.
      if (!measurement) continue;

      const itemTopInContainer = virtualBlockTop + measurement.start;
      const itemHeight = measurement.size;
      const threshold = Math.max(20, itemHeight - 18);
      const relativeTop = itemTopInContainer - scrollTop;

      if (relativeTop < -threshold) {
        if (!candidate || measurement.start > (cache[candidate.index]?.start ?? -Infinity)) {
          candidate = entry;
        }
      }
    }

    const nextId = candidate?.id ?? null;
    if (nextId !== prevPinnedIdRef.current) {
      setTransitionDirection(scrollingDown ? 'down' : 'up');
      prevPinnedIdRef.current = nextId;
      setPinnedId(nextId);
      setPinnedContent(candidate?.content ?? null);
    } else if (candidate && candidate.content !== pinnedContent) {
      setPinnedContent(candidate.content);
    }
  }, [pinnedContent, scrollContainer, userMessageEntries, virtualBlockTop, virtualizer]);

  useEffect(() => {
    if (!scrollContainer) return;

    const THROTTLE_MS = 100;

    const handleScroll = () => {
      const now = performance.now();
      if (now - lastUpdateRef.current < THROTTLE_MS) {
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            lastUpdateRef.current = performance.now();
            computePinned();
          });
        }
        return;
      }
      lastUpdateRef.current = now;
      computePinned();
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    // Initial compute so a re-mount with non-zero scrollTop picks up immediately.
    handleScroll();
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [scrollContainer, computePinned]);

  const scrollToMessage = useCallback(() => {
    if (!virtualizer || !pinnedId) return;
    const entry = entriesById.get(pinnedId);
    if (!entry) return;
    virtualizer.scrollToIndex(entry.index, { align: 'start', behavior: 'smooth' });
  }, [entriesById, pinnedId, virtualizer]);

  return {
    contextValue,
    header: pinnedId && pinnedContent !== null ? (
      <div
        className="absolute inset-x-0 z-20 pointer-events-none"
        style={{ top: topOffset }}
      >
        <button
          type="button"
          onClick={scrollToMessage}
          className="w-full text-left pointer-events-auto"
          style={{
            animation: `sticky-slide-${transitionDirection} 150ms ease-out`,
          }}
        >
          <UserMessageBubble
            content={pinnedContent}
            isPinned
            isWideLayout={isWideUserLayout}
          />
        </button>
        <style>{`
          @keyframes sticky-slide-down {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes sticky-slide-up {
            from { opacity: 0; transform: translateY(4px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>
    ) : null,
  };
}


// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

export interface MessageBubbleProps {
  agentId: string;
  msg: ChatMessage;
  previousRole?: ChatMessage['role'] | null;
  isStreaming?: boolean;
  activeSpeakingSentence?: ActiveSpeakingSentence | null;
  orphanApprovalAnchor?: OrphanApprovalAnchor | null;
  activeThreadId?: string | null;
  isWideUserLayout?: boolean;
  activeDetachedToolCallIds?: Set<string>;
  hoveredDetachedToolCallId?: string | null;
  onHoverDetachedToolCallId?: (toolCallId: string | null) => void;
  showAssistantInlineActions?: boolean;
}

function messageOwnsToolCallId(msg: ChatMessage, toolCallId: string | null | undefined): boolean {
  if (!toolCallId) return false;
  return msg.parts.some((part) => part.kind === 'tool-call' && part.toolCall.id === toolCallId);
}

function messageIsActiveSpeakingTarget(
  msg: ChatMessage,
  speaking: ActiveSpeakingSentence | null | undefined,
): boolean {
  if (!speaking?.messageId) return false;
  return speaking.messageId === msg.id || speaking.messageId === msg.serverMessageId;
}

function messageOwnsApprovalAnchor(
  msg: ChatMessage,
  anchor: OrphanApprovalAnchor | null | undefined,
): boolean {
  if (!anchor) return false;
  return anchor.messageId === msg.id;
}

// Custom comparator: most committed messages don't need to re-render when
// transient props (active speaking sentence, hovered tool call, etc.) change
// somewhere else in the thread. This skip is what keeps streaming deltas
// from forcing every prior turn to diff.
export function arePropsEqualForBubble(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  if (prev.msg !== next.msg) return false;
  if (prev.agentId !== next.agentId) return false;
  if (prev.previousRole !== next.previousRole) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.activeThreadId !== next.activeThreadId) return false;
  if (prev.isWideUserLayout !== next.isWideUserLayout) return false;
  if (prev.showAssistantInlineActions !== next.showAssistantInlineActions) return false;

  const prevSpeaking = messageIsActiveSpeakingTarget(prev.msg, prev.activeSpeakingSentence);
  const nextSpeaking = messageIsActiveSpeakingTarget(next.msg, next.activeSpeakingSentence);
  if (prevSpeaking !== nextSpeaking) return false;
  if (prevSpeaking && prev.activeSpeakingSentence !== next.activeSpeakingSentence) return false;

  const prevAnchor = messageOwnsApprovalAnchor(prev.msg, prev.orphanApprovalAnchor);
  const nextAnchor = messageOwnsApprovalAnchor(next.msg, next.orphanApprovalAnchor);
  if (prevAnchor !== nextAnchor) return false;
  if (prevAnchor && prev.orphanApprovalAnchor !== next.orphanApprovalAnchor) return false;

  const prevHoverOwns = messageOwnsToolCallId(prev.msg, prev.hoveredDetachedToolCallId);
  const nextHoverOwns = messageOwnsToolCallId(next.msg, next.hoveredDetachedToolCallId);
  if (prevHoverOwns !== nextHoverOwns) return false;
  if (prevHoverOwns && prev.hoveredDetachedToolCallId !== next.hoveredDetachedToolCallId) return false;

  // activeDetachedToolCallIds: only matters if this message owns a tool call
  // currently in the detached set. Otherwise its identity churn is noise.
  const prevSet = prev.activeDetachedToolCallIds;
  const nextSet = next.activeDetachedToolCallIds;
  if (prevSet !== nextSet) {
    for (const part of next.msg.parts) {
      if (part.kind !== 'tool-call') continue;
      const id = part.toolCall.id;
      if (!id) continue;
      if ((prevSet?.has(id) ?? false) !== (nextSet?.has(id) ?? false)) {
        return false;
      }
    }
  }

  return true;
}

function MessageBubbleInner({
  agentId,
  msg,
  previousRole,
  isStreaming,
  activeSpeakingSentence,
  orphanApprovalAnchor,
  activeThreadId,
  isWideUserLayout = false,
  activeDetachedToolCallIds,
  hoveredDetachedToolCallId,
  onHoverDetachedToolCallId,
  showAssistantInlineActions = false,
}: MessageBubbleProps) {
  const isUser = msg.role === 'user';
  const stickyCtx = useContext(StickyUserMessageContext);
  const elRef = useRef<HTMLDivElement>(null);
  const wasAssistantSpeakingRef = useRef(false);
  const [isManualSpeakRequested, setIsManualSpeakRequested] = useState(false);
  const [isTtsButtonHovered, setIsTtsButtonHovered] = useState(false);

  // For user messages: strip workstation context, detect special messages
  const rawContent = textContent(msg);
  const displayContent = useMemo(() => {
    if (!isUser) return rawContent;
    return stripWorkstationContext(rawContent || '');
  }, [isUser, rawContent]);

  const ttsPlaybackSentences = useMemo(
    () => splitTextForTtsPlayback(rawContent || ''),
    [rawContent],
  );

  const normalizedParts = useMemo(
    () => settleInactiveReasoningParts(msg.parts, Boolean(!isUser && isStreaming)),
    [isStreaming, isUser, msg.parts],
  );
  const groups = useMemo(() => groupMessageParts(normalizedParts), [normalizedParts]);
  const knownToolCallIds = useMemo(() => collectToolCallIds(groups), [groups]);

  const lastGroup = groups[groups.length - 1];
  const lastTextGroupIndex = useMemo(() => {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (groups[index]?.type === 'text') {
        return index;
      }
    }
    return -1;
  }, [groups]);
  const liveText = useMemo(() => {
    const group = lastTextGroupIndex >= 0 ? groups[lastTextGroupIndex] : null;
    return group?.type === 'text' ? group.content : '';
  }, [groups, lastTextGroupIndex]);
  const pacedText = usePacedText(liveText, Boolean(!isUser && isStreaming));

  const showTextActivity = Boolean(
    !isUser &&
    isStreaming &&
    lastGroup &&
    lastGroup.type === 'text' &&
    lastGroup.content.trim().length > 0,
  );
  const hasRunningToolCall = normalizedParts.some(
    (part) => part.kind === 'tool-call' && part.toolCall.state === 'loading',
  );
  const showIdleStreamingActivity = shouldShowIdleStreamingActivity({
    isUser,
    isStreaming,
    showTextActivity,
    hasRunningToolCall,
  });
  const idleToolCalls = useMemo<ToolCallInfo[]>(
    () => showIdleStreamingActivity
      ? [{ id: `idle-${msg.id}`, type: 'reasoning', label: 'Working', state: 'loading' }]
      : [],
    [msg.id, showIdleStreamingActivity],
  );
  const renderedGroups = useMemo<MessagePartGroup[]>(() => {
    if (idleToolCalls.length === 0) {
      return groups;
    }

    const last = groups[groups.length - 1];
    if (last?.type === 'activity-group') {
      return [
        ...groups.slice(0, -1),
        { type: 'activity-group', toolCalls: [...last.toolCalls, ...idleToolCalls] } satisfies MessagePartGroup,
      ];
    }

    return [...groups, { type: 'activity-group', toolCalls: idleToolCalls }];
  }, [groups, idleToolCalls]);

  const isAssistantSpeaking = useMemo(() => {
    if (isUser || !activeSpeakingSentence?.messageId) return false;
    return activeSpeakingSentence.messageId === msg.id || activeSpeakingSentence.messageId === msg.serverMessageId;
  }, [activeSpeakingSentence, isUser, msg.id, msg.serverMessageId]);

  useEffect(() => {
    if (wasAssistantSpeakingRef.current && !isAssistantSpeaking) {
      setIsManualSpeakRequested(false);
    }

    wasAssistantSpeakingRef.current = isAssistantSpeaking;
  }, [isAssistantSpeaking]);

  useEffect(() => {
    const handleStop = () => {
      setIsManualSpeakRequested(false);
    };

    window.addEventListener(ASSISTANT_TTS_STOP_EVENT, handleStop);
    return () => {
      window.removeEventListener(ASSISTANT_TTS_STOP_EVENT, handleStop);
    };
  }, []);

  const stopPlayback = useCallback(() => {
    setIsManualSpeakRequested(false);
    window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));
  }, []);

  const getSelectedTtsModelStatus = useCallback(async (): Promise<{ installed: boolean; modelId: string }> => {
    try {
      const [settingsResponse, modelsResponse] = await Promise.all([
        ttsIpc.getSettings(),
        ttsIpc.listModels(),
      ]);
      const modelId = settingsResponse.settings.modelId;
      return {
        installed: isSelectedTtsModelInstalled(modelId, modelsResponse.models),
        modelId,
      };
    } catch {
      return {
        installed: true,
        modelId: '',
      };
    }
  }, []);

  const handleTtsButtonClick = useCallback(async () => {
    if (isAssistantSpeaking || isManualSpeakRequested) {
      stopPlayback();
      return;
    }

    if (isUser || isStreaming || ttsPlaybackSentences.length === 0) {
      return;
    }

    const selectedModelStatus = await getSelectedTtsModelStatus();
    if (!selectedModelStatus.installed) {
      const detail: AssistantTtsManualPlayRequestDetail = {
        agentId,
        messageId: msg.id,
        sentences: ttsPlaybackSentences,
        modelId: selectedModelStatus.modelId,
      };
      window.dispatchEvent(
        new CustomEvent<AssistantTtsManualPlayRequestDetail>(
          ASSISTANT_TTS_MANUAL_PLAY_REQUEST_EVENT,
          { detail },
        ),
      );
      return;
    }

    window.dispatchEvent(new Event(ASSISTANT_TTS_STOP_EVENT));
    setIsManualSpeakRequested(true);
    ttsPlaybackSentences.forEach((sentence, sentenceIndex) => {
      const detail: AssistantTtsSentenceEnqueueDetail = {
        text: sentence,
        messageId: msg.id,
        sentenceIndex,
        source: 'manual',
      };
      window.dispatchEvent(
        new CustomEvent<AssistantTtsSentenceEnqueueDetail>(ASSISTANT_TTS_ENQUEUE_EVENT, { detail }),
      );
    });
  }, [
    agentId,
    isAssistantSpeaking,
    isManualSpeakRequested,
    isStreaming,
    isUser,
    msg.id,
    stopPlayback,
    getSelectedTtsModelStatus,
    ttsPlaybackSentences,
  ]);

  const handleAssistantContextMenu = useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    if (isUser || !rawContent || rawContent.trim().length === 0 || isStreaming) {
      return;
    }

    event.preventDefault();

    const items: ContextMenuItem[] = [
      { label: tr('common.copyMessage'), action: 'copy-message' },
      { label: tr('common.readAloud'), action: 'read-aloud' },
    ];

    const action = await showContextMenu(items, 'chat_message');
    if (action === 'copy-message') {
      await copyTextToClipboard(rawContent);
      return;
    }
    if (action === 'read-aloud') {
      await handleTtsButtonClick();
    }
  }, [handleTtsButtonClick, isStreaming, isUser, rawContent]);

  const isTtsStopMode = isAssistantSpeaking || isManualSpeakRequested;
  const showSpinner = !isAssistantSpeaking && isManualSpeakRequested && !isTtsButtonHovered;

  // Register user messages for the sticky header
  useEffect(() => {
    if (!isUser || !elRef.current) return;
    stickyCtx.registerMessage(msg.id, displayContent, elRef.current);
    return () => stickyCtx.unregisterMessage(msg.id);
  }, [isUser, msg.id, displayContent, stickyCtx]);

  // Compaction messages render as a divider
  if (isCompactionMessage(rawContent)) {
    return <CompactionDivider />;
  }

  // System notifications are hidden
  if (msg.role === 'assistant' && isSystemNotification(rawContent)) {
    return null;
  }

  // --- User bubble ---
  if (isUser) {
    return (
      <div
        className={cn(
          'oa-thread-message oa-thread-message--user group w-full',
          previousRole ? (previousRole === msg.role ? 'oa-thread-message--continuation' : 'oa-thread-message--turn-gap') : undefined,
        )}
        ref={elRef}
        data-testid={MESSAGE_ID(msg.id)}
        data-message-id={msg.serverMessageId || msg.id}
      >
        <UserMessageBubble
          content={displayContent}
          attachments={msg.attachments}
          isWideLayout={isWideUserLayout}
        />
      </div>
    );
  }

  // --- Assistant transcript content ---
  return (
    <div
      className={cn(
        'oa-thread-message oa-thread-message--assistant group w-full',
        previousRole ? (previousRole === msg.role ? 'oa-thread-message--continuation' : 'oa-thread-message--turn-gap') : undefined,
        rawContent && !isStreaming && showAssistantInlineActions ? 'oa-thread-message--with-actions' : undefined,
      )}
      data-testid={MESSAGE_ID(msg.id)}
      data-message-id={msg.serverMessageId || msg.id}
      onContextMenu={handleAssistantContextMenu}
    >
      <div
        className="w-full max-w-[var(--thread-max-width)] mx-auto"
        style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}
      >
        <div
          className="oa-thread-message-shell transition-colors"
          style={{
            paddingTop: '2px',
          }}
        >
          <div
            className="thread-message-select break-words text-[15px] leading-[1.7rem] text-foreground"
            style={{
              maxWidth: '100%',
            }}
          >
            {renderedGroups.map((group, i) =>
              group.type === 'text' ? (
                <div
                  key={i}
                  className={i > 0 ? 'oa-thread-message-group-gap' : undefined}
                  data-component="text-part"
                >
                  <div data-slot="text-part-body">
                    <Markdown streaming={Boolean(isStreaming && i === lastTextGroupIndex)}>
                      {i === lastTextGroupIndex && isStreaming ? pacedText : group.content}
                    </Markdown>
                  </div>
                </div>
              ) : (
                <div key={i} className="oa-thread-message-group-gap">
                  <ToolCallGroup
                    toolCalls={group.toolCalls}
                    knownToolCallIds={knownToolCallIds}
                    allowOrphanApprovals={
                      orphanApprovalAnchor?.kind === 'activity-group'
                      && orphanApprovalAnchor.messageId === msg.id
                      && orphanApprovalAnchor.groupIndex === i
                    }
                    threadId={activeThreadId ?? undefined}
                    agentId={agentId}
                    activeDetachedToolCallIds={activeDetachedToolCallIds}
                    hoveredDetachedToolCallId={hoveredDetachedToolCallId}
                    onHoverDetachedToolCallId={onHoverDetachedToolCallId}
                  />
                </div>
              ),
            )}
            {orphanApprovalAnchor?.kind === 'empty' && orphanApprovalAnchor.messageId === msg.id && (
              <ToolCallGroup
                toolCalls={[]}
                knownToolCallIds={knownToolCallIds}
                allowOrphanApprovals
                threadId={activeThreadId ?? undefined}
                agentId={agentId}
                activeDetachedToolCallIds={activeDetachedToolCallIds}
                hoveredDetachedToolCallId={hoveredDetachedToolCallId}
                onHoverDetachedToolCallId={onHoverDetachedToolCallId}
              />
            )}
          </div>

          {rawContent && !isStreaming && showAssistantInlineActions && (
            <div className="oa-thread-message-actions flex items-center gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
              <MessageActionButton
                onClick={handleTtsButtonClick}
                onMouseEnter={() => setIsTtsButtonHovered(true)}
                onMouseLeave={() => setIsTtsButtonHovered(false)}
                label={isTtsStopMode ? 'Stop playback' : 'Play message'}
                icon={showSpinner ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isTtsStopMode ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-current" />
                )}
              />
              <AnimatedCopyButton text={rawContent} label="Copy message" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageBubble = React.memo(MessageBubbleInner, arePropsEqualForBubble);

// ---------------------------------------------------------------------------
// ThreadMessages
// ---------------------------------------------------------------------------

export interface ThreadMessagesProps {
  agentId: string;
  messages: ChatMessage[];
  streamingMessage: ChatMessage | null;
  isStreaming: boolean;
  error: string | null;
  errorDetails: string | null;
  errorEndpointBaseUrl: string | null;
  retrying: string | null;
  historyLoaded: boolean;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
  onLoadOlderHistory?: () => Promise<void>;
  activeThreadId?: string | null;
  onStopBackgroundProcess?: (toolCallIds?: string[]) => Promise<void>;
  isEditorPane?: boolean;
  openSettings?: (workspace?: undefined, tab?: string) => void;
  onStartNewChatWithHistory?: () => void;
  onRetry?: () => void;
  showProfileSwitchWarning?: boolean;
  providerLabel?: string;
  suggestionOverlayHeight?: number;
  onSuggestionOverlayOpacityChange?: (opacity: number) => void;
  chatResizeBehavior?: 'instant' | 'smooth';
}

export const ThreadMessages: FC<ThreadMessagesProps> = ({
  agentId,
  messages,
  streamingMessage,
  isStreaming,
  error,
  errorDetails,
  errorEndpointBaseUrl,
  retrying,
  historyLoaded,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  onLoadOlderHistory,
  activeThreadId,
  onStopBackgroundProcess,
  isEditorPane,
  openSettings,
  onStartNewChatWithHistory,
  onRetry,
  showProfileSwitchWarning = false,
  providerLabel,
  suggestionOverlayHeight = 0,
  onSuggestionOverlayOpacityChange,
  chatResizeBehavior = 'smooth',
}) => {
  "use no memo";

  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null,
  );
  const orphanApprovalAnchor = useMemo(
    () => getOrphanApprovalAnchor(messages, streamingMessage && draftHasVisibleContent(streamingMessage) ? streamingMessage : null),
    [messages, streamingMessage],
  );
  const visibleStreamingMessage = useMemo(
    () => streamingMessage && draftHasVisibleContent(streamingMessage) ? streamingMessage : null,
    [streamingMessage],
  );
  const reasoningHandoffCandidate = useMemo(
    () => isReasoningHandoffCandidate(visibleStreamingMessage),
    [visibleStreamingMessage],
  );
  const [reasoningHandoff, setReasoningHandoff] = useState<{ messageId: string; startedAt: number } | null>(null);
  const [reasoningHandoffNow, setReasoningHandoffNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isStreaming || !visibleStreamingMessage || !reasoningHandoffCandidate) {
      setReasoningHandoff(null);
      return;
    }

    setReasoningHandoff((current) => {
      if (current?.messageId === visibleStreamingMessage.id) {
        return current;
      }

      return {
        messageId: visibleStreamingMessage.id,
        startedAt: Date.now(),
      };
    });
  }, [isStreaming, reasoningHandoffCandidate, visibleStreamingMessage]);

  useEffect(() => {
    if (!reasoningHandoff) {
      return;
    }

    const remainingMs = REASONING_HANDOFF_HOLD_MS - (Date.now() - reasoningHandoff.startedAt);
    if (remainingMs <= 0) {
      setReasoningHandoffNow(Date.now());
      return;
    }

    const timer = window.setTimeout(() => {
      setReasoningHandoffNow(Date.now());
    }, remainingMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [reasoningHandoff]);

  const reasoningHandoffActive = Boolean(
    reasoningHandoff
    && visibleStreamingMessage
    && reasoningHandoff.messageId === visibleStreamingMessage.id
    && reasoningHandoffCandidate
    && (reasoningHandoffNow - reasoningHandoff.startedAt) < REASONING_HANDOFF_HOLD_MS,
  );
  const showOptimisticThinking = isStreaming && (!visibleStreamingMessage || reasoningHandoffActive);
  const detachedToolCalls = useMemo(
    () => collectDetachedToolCalls(messages, visibleStreamingMessage),
    [messages, visibleStreamingMessage],
  );
  const showTrailingRunningIndicator = useMemo(
    () => shouldShowTrailingRunningIndicator({
      isStreaming,
      showOptimisticThinking,
      visibleStreamingMessage,
      detachedToolCalls,
    }),
    [detachedToolCalls, isStreaming, showOptimisticThinking, visibleStreamingMessage],
  );
  const streamingTailKind = useMemo(
    () => getStreamingTailKind({
      showOptimisticThinking,
      visibleStreamingMessage,
      reasoningHandoffActive,
    }),
    [reasoningHandoffActive, showOptimisticThinking, visibleStreamingMessage],
  );
  const lastAssistantMessageIdsInTurns = useMemo(
    () => collectLastAssistantMessageIdsInTurns(messages, visibleStreamingMessage),
    [messages, visibleStreamingMessage],
  );
  const activeDetachedToolCallIds = useMemo(
    () => new Set(detachedToolCalls.map((entry) => entry.toolCallId)),
    [detachedToolCalls],
  );
  const [hoveredDetachedToolCallId, setHoveredDetachedToolCallId] = useState<string | null>(null);
  const [activeSpeakingSentence, setActiveSpeakingSentence] = useState<ActiveSpeakingSentence | null>(null);
  const [isWideUserLayout, setIsWideUserLayout] = useState(false);
  const [hasScrolledContent, setHasScrolledContent] = useState(false);
  const threadTopInset = isEditorPane ? EDITOR_THREAD_TOP_INSET : SIDEBAR_THREAD_TOP_INSET;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const backgroundRevealResetRef = useRef<number | null>(null);
  const previousSuggestionOverlayHeightRef = useRef(0);
  const virtualBlockRef = useRef<HTMLDivElement>(null);
  const [virtualBlockTop, setVirtualBlockTop] = useState(0);
  const prependAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  // Virtualize the committed-messages list. Streaming tail, detached rail,
  // retry/error indicators, and the scroll anchor stay as siblings after
  // the virtualized block (they're either short-lived or singletons).
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainer,
    estimateSize: () => 240,
    overscan: 4,
    // Use stable item ids so measurement cache survives reorders / streaming
    // appends. ChatMessage.id is stable for committed messages.
    getItemKey: (index) => messages[index]?.id ?? index,
    // scrollMargin = distance from the scroll element's top to the
    // virtualized block's top. Recomputed in the effect below whenever
    // pre-content (history loader) toggles.
    scrollMargin: virtualBlockTop,
  });

  const userMessageEntries = useMemo<UserMessageEntry[]>(
    () => messages
      .map((message, index): UserMessageEntry | null => message.role === 'user'
        ? { index, id: message.id, content: stripWorkstationContext(textContent(message) || '') }
        : null)
      .filter((entry): entry is UserMessageEntry => entry !== null),
    [messages],
  );

  useEffect(() => {
    const node = wrapperRef.current;
    if (node) {
      const scrollable =
        node.querySelector('[data-chat-scroll-container="true"]') ?? node.firstElementChild ?? node;
      setScrollContainer(scrollable as HTMLElement);
    }
    return () => {
      setScrollContainer(null);
      setHasScrolledContent(false);
    };
  }, [activeThreadId, isEditorPane]);

  // Track the virtualized block's offset within the scroll element. This
  // becomes scrollMargin for the virtualizer and feeds the sticky-header's
  // absolute-position calculation.
  useEffect(() => {
    const node = virtualBlockRef.current;
    if (!node || !scrollContainer) return;

    const update = () => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const next = nodeRect.top - containerRect.top + scrollContainer.scrollTop;
      setVirtualBlockTop((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [scrollContainer, historyLoaded]);

  useEffect(() => {
    if (!scrollContainer) return;

    const syncScrolledState = () => {
      setHasScrolledContent(scrollContainer.scrollTop > 4);
      const distanceFromBottom = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
      );
      const nextOpacity = distanceFromBottom <= 28
        ? 1
        : distanceFromBottom >= 168
          ? 0
          : 1 - ((distanceFromBottom - 28) / 140);
      onSuggestionOverlayOpacityChange?.(nextOpacity);
    };

    syncScrolledState();
    scrollContainer.addEventListener('scroll', syncScrolledState, {
      passive: true,
    });
    const observer = new ResizeObserver(syncScrolledState);
    observer.observe(scrollContainer);
    return () => {
      scrollContainer.removeEventListener('scroll', syncScrolledState);
      observer.disconnect();
      onSuggestionOverlayOpacityChange?.(1);
    };
  }, [onSuggestionOverlayOpacityChange, scrollContainer]);

  useEffect(() => {
    if (!scrollContainer || !hasOlderHistory || !onLoadOlderHistory) return;

    const maybeLoadOlder = () => {
      if (scrollContainer.scrollTop > 320 || loadingOlderHistory) return;
      prependAnchorRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
      };
      void onLoadOlderHistory();
    };

    scrollContainer.addEventListener('scroll', maybeLoadOlder, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', maybeLoadOlder);
  }, [hasOlderHistory, loadingOlderHistory, onLoadOlderHistory, scrollContainer]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!scrollContainer || loadingOlderHistory || !anchor) return;
    const addedHeight = scrollContainer.scrollHeight - anchor.scrollHeight;
    scrollContainer.scrollTop = anchor.scrollTop + Math.max(0, addedHeight);
    prependAnchorRef.current = null;
  }, [loadingOlderHistory, messages.length, scrollContainer]);

  useEffect(() => {
    if (!scrollContainer) {
      previousSuggestionOverlayHeightRef.current = suggestionOverlayHeight;
      return;
    }

    const previousHeight = previousSuggestionOverlayHeightRef.current;
    previousSuggestionOverlayHeightRef.current = suggestionOverlayHeight;

    if (suggestionOverlayHeight <= previousHeight) {
      return;
    }

    const distanceFromBottom = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
    );
    const wasPinnedToBottom = distanceFromBottom <= Math.max(56, previousHeight + 24);

    if (!wasPinnedToBottom) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [scrollContainer, suggestionOverlayHeight]);

  const revealDetachedToolCall = useCallback((toolCallId: string) => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(toolCallId)
      : toolCallId.replace(/["\\]/g, '\\$&');

    const flash = () => {
      const targets = Array.from(root.querySelectorAll<HTMLElement>(`[data-tool-call-id="${escaped}"]`));
      const target = targets.find(isVisibleBackgroundTarget) ?? targets[0];
      if (!target) {
        return;
      }

      setHoveredDetachedToolCallId(toolCallId);
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashBackgroundTarget(target);

      if (backgroundRevealResetRef.current !== null) {
        window.clearTimeout(backgroundRevealResetRef.current);
      }

      backgroundRevealResetRef.current = window.setTimeout(() => {
        target.classList.remove('animate-highlight');
        setHoveredDetachedToolCallId((current) => current === toolCallId ? null : current);
        backgroundRevealResetRef.current = null;
      }, 1800);
    };

    // The owning message may be virtualized out of the DOM. Scroll the
    // virtualizer to that message first, then flash on the next frame once
    // the row is mounted.
    const ownerIndex = messages.findIndex((message) =>
      message.parts.some((part) => part.kind === 'tool-call' && part.toolCall.id === toolCallId),
    );
    if (ownerIndex >= 0) {
      virtualizer.scrollToIndex(ownerIndex, { align: 'center', behavior: 'auto' });
      requestAnimationFrame(() => requestAnimationFrame(flash));
      return;
    }

    flash();
  }, [messages, virtualizer]);

  useEffect(() => () => {
    if (backgroundRevealResetRef.current !== null) {
      window.clearTimeout(backgroundRevealResetRef.current);
    }
  }, []);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;

    const updateWideLayout = () => {
      setIsWideUserLayout(node.clientWidth >= WIDE_USER_MESSAGE_BREAKPOINT);
    };

    updateWideLayout();

    const observer = new ResizeObserver(updateWideLayout);
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeThreadId, isEditorPane]);

  useEffect(() => {
    const handleSpeakingMessage = (event: Event) => {
      const detail = (event as CustomEvent<AssistantTtsMessageSpeakingDetail>).detail;
      setActiveSpeakingSentence({
        messageId: detail?.messageId ?? null,
        sentenceIndex: Number.isInteger(detail?.sentenceIndex) ? detail.sentenceIndex : null,
        text: typeof detail?.text === 'string' ? detail.text : null,
      });
    };

    window.addEventListener(
      ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT,
      handleSpeakingMessage as EventListener,
    );

    return () => {
      window.removeEventListener(
        ASSISTANT_TTS_MESSAGE_SPEAKING_EVENT,
        handleSpeakingMessage as EventListener,
      );
    };
  }, []);

  const { contextValue, header } = useStickyUserMessageHeader({
    scrollContainer,
    isWideUserLayout,
    topOffset: threadTopInset,
    userMessageEntries,
    virtualizer,
    virtualBlockTop,
  });
  const viewportMaskImage = buildVerticalEdgeMask({
    topFade: hasScrolledContent
      ? isEditorPane
        ? EDITOR_TOP_FADE
        : SIDEBAR_TOP_FADE
      : '0px',
    bottomFade: isEditorPane ? EDITOR_BOTTOM_FADE : SIDEBAR_BOTTOM_FADE,
  });

  return (
    <StickyUserMessageContext.Provider value={contextValue}>
      <div ref={wrapperRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ChatContainerRoot
          key={`${activeThreadId ?? 'draft'}-${isEditorPane ? 'editor' : 'sidebar'}`}
          className="flex-1 min-h-0"
          resizeBehavior={chatResizeBehavior}
          style={{
            paddingTop: threadTopInset,
            paddingRight: THREAD_HORIZONTAL_INSET,
            paddingBottom: 'var(--unit-padding)',
            paddingLeft: THREAD_HORIZONTAL_INSET,
            '--thread-max-width': isEditorPane
              ? '56rem'
              : '42rem',
          }}
        >
          {header}
          <ChatContainerContent
            className="flex min-h-full flex-col items-stretch gap-0"
            viewportStyle={{
              maskImage: viewportMaskImage,
              WebkitMaskImage: viewportMaskImage,
              scrollPaddingBottom: 'var(--thread-scroll-bottom-clearance, 7rem)',
            }}
            style={{
              paddingBottom:
                'var(--thread-scroll-bottom-clearance, 7rem)',
            }}
          >
          {/* History loading indicator */}
          {(!historyLoaded || loadingOlderHistory) && (
            <div className="w-full">
              <div
                className="w-full max-w-[var(--thread-max-width)] mx-auto"
                style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}
              >
                <TypingDots />
              </div>
            </div>
          )}

          {/*
            Committed messages — virtualized. Each row is absolutely positioned
            within a container of height = virtualizer.getTotalSize(). Off-screen
            messages are unmounted; the virtualizer keeps measurement state per
            stable item key so heights persist across re-mounts on scroll.
          */}
          <div
            ref={virtualBlockRef}
            className="oa-thread-virtual-block w-full"
            style={{
              position: 'relative',
              height: messages.length > 0 ? `${virtualizer.getTotalSize()}px` : 0,
              minHeight: 0,
              flexShrink: 0,
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const message = messages[virtualItem.index];
              if (!message) return null;
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                    // `display: flow-root` establishes a new block formatting
                    // context so the MessageBubble's `margin-top` (from
                    // oa-thread-message--turn-gap / --continuation) does NOT
                    // collapse out of this wrapper. Without this, the inner
                    // margin escapes the wrapper's offsetHeight; the
                    // virtualizer under-counts the row, the next row's
                    // translateY lands too high, and the previous row's
                    // tool-card sits visually under the next row's text —
                    // so clicking the text hits the tool-card button.
                    display: 'flow-root',
                  }}
                >
                  <MessageBubble
                    agentId={agentId}
                    msg={message}
                    previousRole={virtualItem.index > 0 ? messages[virtualItem.index - 1]?.role ?? null : null}
                    showAssistantInlineActions={lastAssistantMessageIdsInTurns.has(message.id)}
                    activeSpeakingSentence={activeSpeakingSentence}
                    orphanApprovalAnchor={orphanApprovalAnchor}
                    activeThreadId={activeThreadId}
                    isWideUserLayout={isWideUserLayout}
                    activeDetachedToolCallIds={activeDetachedToolCallIds}
                    hoveredDetachedToolCallId={hoveredDetachedToolCallId}
                    onHoverDetachedToolCallId={setHoveredDetachedToolCallId}
                  />
                </div>
              );
            })}
          </div>

          {/* Keep the streaming tail mutually exclusive in normal flow.
              Overlapping exit/enter rows here causes a one-frame height spike. */}
          {streamingTailKind === 'optimistic' ? (
            <motion.div
              key="optimistic-thinking"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: reduceMotion ? 0 : 0.2,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <OptimisticThinkingLoader
                previousRole={messages.length > 0 ? messages[messages.length - 1]?.role ?? null : null}
                textOverride={reasoningHandoffActive ? 'Reasoning' : null}
                showDisclosure={reasoningHandoffActive}
              />
            </motion.div>
          ) : null}

          {streamingTailKind === 'message' && visibleStreamingMessage ? (
            <motion.div
              key={`streaming-${visibleStreamingMessage.id}`}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: reduceMotion ? 0 : 0.22,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <MessageBubble
                key={visibleStreamingMessage.id}
                agentId={agentId}
                msg={visibleStreamingMessage}
                previousRole={messages.length > 0 ? messages[messages.length - 1]?.role ?? null : null}
                isStreaming={isStreaming}
                showAssistantInlineActions={lastAssistantMessageIdsInTurns.has(visibleStreamingMessage.id)}
                activeSpeakingSentence={activeSpeakingSentence}
                orphanApprovalAnchor={orphanApprovalAnchor}
                activeThreadId={activeThreadId}
                isWideUserLayout={isWideUserLayout}
                activeDetachedToolCallIds={activeDetachedToolCallIds}
                hoveredDetachedToolCallId={hoveredDetachedToolCallId}
                onHoverDetachedToolCallId={setHoveredDetachedToolCallId}
              />
            </motion.div>
          ) : null}

          {detachedToolCalls.length > 0 ? (
            <div
              className="w-full max-w-[var(--thread-max-width)] mx-auto"
              style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}
            >
              <DetachedToolCallRail
                toolCalls={detachedToolCalls}
                onStopProcess={(toolCallIds) => onStopBackgroundProcess?.(toolCallIds)}
                hoveredToolCallId={hoveredDetachedToolCallId}
                onHoverToolCallId={setHoveredDetachedToolCallId}
                onRevealToolCall={revealDetachedToolCall}
              />
            </div>
          ) : null}

          {/* Retrying indicator */}
          {retrying && (
            <div className="w-full max-w-[var(--thread-max-width)] mx-auto" style={{ padding: `0 ${THREAD_HORIZONTAL_INSET}` }}>
              <div className="text-ui-xs text-muted-foreground py-1">
                {t('errors.chat.retrying', { message: retrying })}
              </div>
            </div>
          )}

          {showTrailingRunningIndicator ? <TrailingRunningIndicator /> : null}

          {/* Error display */}
          {error && (
            <ThreadErrorWithLayout
              rawError={error}
              errorDetails={errorDetails}
              requestEndpointBaseUrl={errorEndpointBaseUrl}
              openSettings={openSettings}
              onStartNewChatWithHistory={onStartNewChatWithHistory}
              onRetry={onRetry}
              showProfileSwitchWarning={showProfileSwitchWarning}
              providerLabel={providerLabel}
            />
          )}

          {suggestionOverlayHeight > 0 ? (
            <div
              aria-hidden="true"
              className="w-full shrink-0"
              style={{ height: suggestionOverlayHeight }}
            />
          ) : null}

            <ChatContainerScrollAnchor />
          </ChatContainerContent>

          <ScrollToBottomButton />
        </ChatContainerRoot>
      </div>
    </StickyUserMessageContext.Provider>
  );
};
