import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, Loader2, Radio, RefreshCw } from 'lucide-react';
import type { ChatMessage, ChatMessagePart } from '../../src/hooks/use-chat';
import { mergeChatHistory } from '../../src/hooks/use-chat';
import type {
  PublicThreadMessage,
  PublicThreadSnapshot,
} from '../../shared/types/publicThread';
import { ThreadMessages } from './prompt-kit/thread-messages';
import { ThreadGoalSummary } from './ThreadGoalSummary';

type RemoteThreadViewerProps = {
  endpoint: string;
  pageSize?: number;
  onReady?: () => void;
  onTitleChange?: (title: string) => void;
  embedded?: boolean;
};

const DEFAULT_PAGE_SIZE = 4;

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function isSnapshot(value: unknown): value is PublicThreadSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<PublicThreadSnapshot>;
  return snapshot.schemaVersion === 1
    && typeof snapshot.threadId === 'string'
    && typeof snapshot.title === 'string'
    && typeof snapshot.status === 'string'
    && Array.isArray(snapshot.messages)
    && typeof snapshot.page === 'object'
    && snapshot.page !== null;
}

function toChatMessage(message: PublicThreadMessage): ChatMessage {
  const parts: ChatMessagePart[] = message.parts.map((part): ChatMessagePart => {
    if (part.kind === 'text') {
      return { kind: 'text', content: part.content };
    }
    return {
      kind: 'tool-call',
      toolCall: {
        id: part.id,
        type: 'mcpToolCall',
        label: part.label,
        state: part.state,
        output: part.output,
      },
    };
  });
  return {
    id: message.id,
    role: message.role,
    parts,
    attachments: [],
  };
}

export async function fetchRemoteThreadSnapshot(
  endpoint: string,
  pageSize: number,
  before?: string | null,
): Promise<PublicThreadSnapshot> {
  const url = new URL(`${normalizeEndpoint(endpoint)}/snapshot`, window.location.href);
  url.searchParams.set('limit', String(pageSize));
  if (before) url.searchParams.set('before', before);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Live thread is unavailable (${response.status})`);
  const payload: unknown = await response.json();
  if (!isSnapshot(payload)) throw new Error('Live thread returned an invalid snapshot');
  return payload;
}

export function RemoteThreadViewer({
  endpoint,
  pageSize = DEFAULT_PAGE_SIZE,
  onReady,
  onTitleChange,
  embedded = false,
}: RemoteThreadViewerProps) {
  const [snapshot, setSnapshot] = useState<PublicThreadSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialPositioned, setInitialPositioned] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  const readySignalledRef = useRef(false);
  const gesturePrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  const signalReady = useCallback(() => {
    if (readySignalledRef.current) return;
    readySignalledRef.current = true;
    onReady?.();
  }, [onReady]);

  const applySnapshot = useCallback((next: PublicThreadSnapshot, direction: 'older' | 'newer') => {
    const incoming = next.messages.map(toChatMessage);
    setMessages((current) => mergeChatHistory(current, incoming, direction));
    setSnapshot((current) => direction === 'older' && current
      ? {
          ...current,
          page: next.page,
          eventCursor: next.eventCursor ?? current.eventCursor,
        }
      : next);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await fetchRemoteThreadSnapshot(endpoint, pageSize);
      applySnapshot(next, 'newer');
      onTitleChangeRef.current?.(next.title);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Live thread is unavailable');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [applySnapshot, endpoint, pageSize]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const intervalId = window.setInterval(() => void refresh(true), 2500);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const loadOlder = useCallback(async () => {
    const cursor = snapshot?.page.nextCursor;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await fetchRemoteThreadSnapshot(endpoint, pageSize, cursor);
      applySnapshot(older, 'older');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load older activity');
    } finally {
      setLoadingOlder(false);
    }
  }, [applySnapshot, endpoint, loadingOlder, pageSize, snapshot?.page.nextCursor]);

  const armHistoryPaging = useCallback(() => {
    if (!initialPositioned) return;

    // A short page cannot create a native scroll event. Treat every distinct
    // upward gesture at the top as another request for history until enough
    // content exists to scroll normally.
    const scrollContainer = viewerRef.current?.querySelector<HTMLElement>(
      '[data-chat-scroll-container="true"]',
    );
    if (
      snapshot?.page.nextCursor
      && !loadingOlder
      && !gesturePrependAnchorRef.current
      && scrollContainer
      && scrollContainer.scrollTop <= 320
    ) {
      gesturePrependAnchorRef.current = {
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
      };
      void loadOlder();
    }
  }, [initialPositioned, loadOlder, loadingOlder, snapshot?.page.nextCursor]);

  useLayoutEffect(() => {
    const anchor = gesturePrependAnchorRef.current;
    if (loadingOlder || !anchor) return;
    const scrollContainer = viewerRef.current?.querySelector<HTMLElement>(
      '[data-chat-scroll-container="true"]',
    );
    if (!scrollContainer) return;
    const addedHeight = scrollContainer.scrollHeight - anchor.scrollHeight;
    scrollContainer.scrollTop = anchor.scrollTop + Math.max(0, addedHeight);
    gesturePrependAnchorRef.current = null;
  }, [loadingOlder, messages.length]);

  useLayoutEffect(() => {
    if (!snapshot || initialPositioned) return;
    if (messages.length === 0) {
      setInitialPositioned(true);
      return;
    }
    const scrollContainer = viewerRef.current?.querySelector<HTMLElement>(
      '[data-chat-scroll-container="true"]',
    );
    if (!scrollContainer) return;

    let frameId = 0;
    let frameCount = 0;
    let stableFrames = 0;
    let previousHeight = -1;

    const positionAtBottom = () => {
      frameCount += 1;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      const distanceFromBottom = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
      );
      if (scrollContainer.scrollHeight === previousHeight && distanceFromBottom <= 1) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      previousHeight = scrollContainer.scrollHeight;

      if (stableFrames >= 2 || frameCount >= 20) {
        setInitialPositioned(true);
        return;
      }
      frameId = window.requestAnimationFrame(positionAtBottom);
    };

    positionAtBottom();
    return () => window.cancelAnimationFrame(frameId);
  }, [initialPositioned, messages.length, snapshot]);

  useEffect(() => {
    if (initialPositioned) signalReady();
  }, [initialPositioned, signalReady]);

  useEffect(() => {
    if (!loading && !snapshot && error) signalReady();
  }, [error, loading, signalReady, snapshot]);

  const statusLabel = useMemo(() => {
    if (!snapshot) return 'Connecting';
    if (snapshot.status === 'working') return 'Working now';
    return snapshot.status.charAt(0).toUpperCase() + snapshot.status.slice(1);
  }, [snapshot]);

  if (loading && !snapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--oa-bg-app)] text-[var(--oa-text-muted)]">
        <div className="flex items-center gap-2 text-ui-sm">
          <Loader2 className="size-4 animate-spin" />
          Joining the live thread
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--oa-bg-app)] px-6 text-center">
        <div className="max-w-sm">
          <p className="text-ui-base font-medium text-[var(--oa-text-strong)]">The live thread is reconnecting</p>
          <p className="mt-2 text-ui-sm leading-6 text-[var(--oa-text-muted)]">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--oa-border)] px-3 py-2 text-ui-sm text-[var(--oa-text)] hover:bg-[var(--oa-bg-hover)]"
          >
            <RefreshCw className="size-3.5" />
            Reconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={viewerRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--oa-bg-app)] text-[var(--oa-text)]"
      style={{ visibility: initialPositioned ? 'visible' : 'hidden' }}
      aria-busy={!initialPositioned}
      onWheelCapture={(event) => {
        if (event.deltaY < 0) armHistoryPaging();
      }}
      onTouchStartCapture={(event) => {
        touchStartYRef.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMoveCapture={(event) => {
        const startY = touchStartYRef.current;
        const currentY = event.touches[0]?.clientY;
        if (startY != null && currentY != null && currentY > startY) {
          armHistoryPaging();
        }
      }}
      onKeyDownCapture={(event) => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
          armHistoryPaging();
        }
      }}
    >
      {!embedded ? <header className="shrink-0 border-b border-[var(--oa-border)] bg-[var(--oa-bg-app)] px-4 py-3">
        <div className="mx-auto flex max-w-[56rem] items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[6.08px] border border-[var(--oa-border)] bg-[var(--oa-bg-subtle)]">
            <Radio className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-ui-sm font-medium text-[var(--oa-text-strong)]">{snapshot.title}</h1>
            <div className="mt-0.5 flex items-center gap-1.5 text-ui-xs text-[var(--oa-text-faint)]">
              <span className={`size-1.5 rounded-full ${snapshot.status === 'working' ? 'animate-pulse bg-emerald-500' : 'bg-[var(--oa-text-faint)]'}`} />
              {statusLabel}
            </div>
          </div>
          <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--oa-border)] px-2.5 py-1.5 text-ui-xs text-[var(--oa-text-muted)]">
            <Eye className="size-3.5" />
            Read only
          </div>
        </div>
      </header> : null}
      {snapshot.goal ? (
        <ThreadGoalSummary
          objective={snapshot.goal.objective}
          status={snapshot.goal.status}
          readOnly
        />
      ) : null}
      {error ? (
        <div className="shrink-0 border-b border-[var(--oa-border)] px-4 py-1.5 text-center text-ui-xs text-[var(--oa-text-muted)]">
          Connection interrupted. Showing the last durable snapshot while reconnecting.
        </div>
      ) : null}
      <ThreadMessages
        agentId="remote-thread-viewer"
        messages={messages}
        streamingMessage={null}
        isStreaming={snapshot.status === 'working'}
        error={null}
        errorDetails={null}
        errorEndpointBaseUrl={null}
        retrying={null}
        historyLoaded
        // Remote history is intentionally advanced only by the explicit
        // wheel/touch/key handlers above. ThreadMessages also has a generic
        // "near the top" scroll loader for ordinary chats; enabling both
        // makes layout resizes (for example, closing a file tab) look like
        // repeated user gestures and can stampede the remote snapshot route.
        hasOlderHistory={false}
        loadingOlderHistory={loadingOlder}
        activeThreadId={snapshot.threadId}
        isEditorPane
        chatResizeBehavior={initialPositioned ? 'smooth' : 'instant'}
      />
    </div>
  );
}
