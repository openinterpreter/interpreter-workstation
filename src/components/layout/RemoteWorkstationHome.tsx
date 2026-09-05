import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchRemoteThreadSnapshot } from '../../../agent/components/RemoteThreadViewer';
import type { PublicThreadSnapshot } from '../../../shared/types/publicThread';
import {
  ConversationHistoryPanel,
  type ConversationPreview,
} from '../ConversationHistoryPanel';
import {
  getRemoteWorkstationEndpoint,
  REMOTE_WORKSTATION_AGENT_TAB_ID,
  REMOTE_WORKSTATION_ROOT,
} from '../../remote/remoteWorkstation';

const REFRESH_INTERVAL_MS = 2500;

export function RemoteWorkstationHome({
  onOpenConversation,
}: {
  onOpenConversation: (conversation: ConversationPreview) => void;
}) {
  const [snapshot, setSnapshot] = useState<PublicThreadSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const endpoint = getRemoteWorkstationEndpoint();

  useEffect(() => {
    if (!endpoint) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await fetchRemoteThreadSnapshot(endpoint, 1);
        if (!cancelled) setSnapshot(next);
      } catch {
        // Keep the last durable entry visible while the remote host reconnects.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const intervalId = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [endpoint]);

  const conversations = useMemo<ConversationPreview[]>(() => snapshot ? [{
    conversationId: snapshot.threadId,
    threadId: snapshot.threadId,
    agentId: REMOTE_WORKSTATION_AGENT_TAB_ID,
    profileId: '',
    workspacePath: REMOTE_WORKSTATION_ROOT,
    title: snapshot.title,
    lastMessagePreview: '',
    messageCount: snapshot.messages.length,
    createdAt: new Date(snapshot.updatedAt).toISOString(),
    updatedAt: new Date(snapshot.updatedAt).toISOString(),
    source: 'active',
    isArchived: false,
    isOpen: true,
    isSelected: false,
  }] : [], [snapshot]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-transparent px-6 py-8">
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center">
        <div className="mb-4 text-ui-sm font-medium text-foreground">Active conversations</div>
        {loading && !snapshot ? (
          <div className="flex items-center gap-2 py-3 text-ui-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading conversations
          </div>
        ) : (
          <ConversationHistoryPanel
            fillHeight={false}
            externalConversations={conversations}
            readOnly
            indicatorToneOverride={snapshot?.status === 'working' ? 'running' : 'idle'}
            onOpenConversation={onOpenConversation}
          />
        )}
      </div>
    </div>
  );
}
