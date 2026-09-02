import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Loader2, Radio, RefreshCw } from 'lucide-react';
import type { ChatMessage, ChatMessagePart } from '../../src/hooks/use-chat';
import { mergeChatHistory } from '../../src/hooks/use-chat';
import type {
  PublicThreadMessage,
  PublicThreadSnapshot,
} from '../../shared/types/publicThread';
import { ThreadMessages } from './prompt-kit/thread-messages';

type RemoteThreadViewerProps = {
  endpoint: string;
};

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

async function fetchSnapshot(
  endpoint: string,
  before?: string | null,
): Promise<PublicThreadSnapshot> {
  const url = new URL(`${normalizeEndpoint(endpoint)}/snapshot`, window.location.href);
  url.searchParams.set('limit', '24');
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

export function RemoteThreadViewer({ endpoint }: RemoteThreadViewerProps) {
  const [snapshot, setSnapshot] = useState<PublicThreadSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const next = await fetchSnapshot(endpoint);
      applySnapshot(next, 'newer');
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Live thread is unavailable');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [applySnapshot, endpoint]);

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
      const older = await fetchSnapshot(endpoint, cursor);
      applySnapshot(older, 'older');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load older activity');
    } finally {
      setLoadingOlder(false);
    }
  }, [applySnapshot, endpoint, loadingOlder, snapshot?.page.nextCursor]);

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--oa-bg-app)] text-[var(--oa-text)]">
      <header className="shrink-0 border-b border-[var(--oa-border)] bg-[var(--oa-bg-app)] px-4 py-3">
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
      </header>
      {snapshot.goal ? (
        <div className="shrink-0 border-b border-[var(--oa-border)] bg-[var(--oa-bg-subtle)] px-4 py-2">
          <div className="mx-auto flex max-w-[56rem] items-center gap-2 text-ui-xs">
            <span className="font-medium text-[var(--oa-text-strong)]">Goal</span>
            <p className="min-w-0 flex-1 truncate text-[var(--oa-text-muted)]" title={snapshot.goal.objective}>
              {snapshot.goal.objective}
            </p>
            <span className="capitalize text-[var(--oa-text-faint)]">{snapshot.goal.status}</span>
          </div>
        </div>
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
        hasOlderHistory={snapshot.page.hasMore}
        loadingOlderHistory={loadingOlder}
        onLoadOlderHistory={loadOlder}
        activeThreadId={snapshot.threadId}
        isEditorPane
      />
    </div>
  );
}
