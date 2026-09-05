/**
 * ChatView Component
 *
 * Chat-style message view for WhatsApp and Telegram threads.
 * Shows chat bubbles with outgoing right-aligned, incoming left-aligned.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2, Phone, MessageCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { getAppServerOrigin, isBrowserDevMode } from '@/ipc';
import type { MessagingChannel } from '../../shared/types/messaging';
import type { UnifiedThread } from '../../shared/types/messaging';
import {
  trackInboxLoadFailed,
  trackInboxMessageSendFailed,
  trackInboxMessageSent,
} from '../utils/telemetry';

interface ChatViewProps {
  tabId: string;
  threadId: string;
  channel: MessagingChannel;
}

export function ChatView({ tabId: _tabId, threadId, channel }: ChatViewProps) {
  "use no memo";

  const { t } = useTranslation();
  const [thread, setThread] = useState<UnifiedThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const getBaseUrl = useCallback(async () => {
    if (isBrowserDevMode()) return '';
    return getAppServerOrigin();
  }, []);

  const fetchThread = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const baseUrl = await getBaseUrl();
      const response = await fetch(`${baseUrl}/api/inbox/thread/${channel}/${encodeURIComponent(threadId)}`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('Failed to fetch thread');
      }
      const data = await response.json();
      setThread(data);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      trackInboxLoadFailed({
        surface: 'thread',
        channel,
        error: message,
      });
    } finally {
      setLoading(false);
    }
  }, [channel, threadId, getBaseUrl]);

  useEffect(() => {
    fetchThread();
    // Auto-refresh every 10 seconds for chat channels
    const interval = setInterval(fetchThread, 10000);
    return () => clearInterval(interval);
  }, [fetchThread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.messages]);

  const handleSend = async () => {
    if (!message.trim() || sending) return;

    const trimmedMessage = message.trim();

    try {
      setSending(true);
      const baseUrl = await getBaseUrl();
      const response = await fetch(`${baseUrl}/api/inbox/send`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, threadId, message: trimmedMessage }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send message');
      }

      trackInboxMessageSent({
        channel,
        messageLength: trimmedMessage.length,
      });
      setMessage('');
      // Refresh to show sent message
      await fetchThread();
      inputRef.current?.focus();
    } catch (err: any) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      trackInboxMessageSendFailed({
        channel,
        messageLength: trimmedMessage.length,
        error: errorMessage,
      });
    } finally {
      setSending(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const ChannelIcon = channel === 'whatsapp' ? Phone : MessageCircle;

  const contentWidthClass = 'mx-auto w-full max-w-3xl';

  if (loading && !thread) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="size-6 animate-spin text-[var(--oa-text-faint)]" />
          <p className="text-ui-sm text-[var(--oa-text-muted)]">Loading conversation…</p>
        </div>
      </div>
    );
  }

  if (error && !thread) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--destructive)_9%,transparent)] text-destructive">
            <ChannelIcon className="size-5" />
          </div>
          <p className="mt-4 text-ui-base font-medium text-[var(--oa-text-strong)]">Failed to load chat</p>
          <p className="mt-2 text-ui-sm leading-6 text-[var(--oa-text-muted)]">{error}</p>
          <Button variant="secondary" size="sm" onClick={fetchThread} className="mt-5 rounded-full">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const chatTitle = thread?.participants?.[0]?.name || thread?.subject || `Chat ${threadId}`;
  const messageCount = thread?.messages.length ?? 0;

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div
        className="px-5 py-4"
        style={{ borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 70%, transparent)' }}
      >
        <div className={`${contentWidthClass} flex min-w-0 items-center gap-3`}>
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full"
            style={{
              background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 74%, transparent)',
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)',
            }}
          >
            <ChannelIcon className="size-4 text-[var(--oa-text-muted)]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-ui-xs uppercase tracking-[0.08em] text-[var(--oa-text-faint)]">{channel}</p>
            <h2 className="truncate text-ui-lg font-medium text-[var(--oa-text-strong)]">{chatTitle}</h2>
          </div>
          <div className="hidden shrink-0 text-right sm:block">
            <div className="text-ui-xs text-[var(--oa-text-faint)]">
              {messageCount === 0 ? 'No messages yet' : `${messageCount} message${messageCount === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className={`${contentWidthClass} space-y-3`}>
          {messageCount === 0 ? (
            <div className="py-10 text-center text-ui-sm text-[var(--oa-text-muted)]">
              This thread does not have messages yet.
            </div>
          ) : (
            thread?.messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className="max-w-[82%] rounded-[18px] px-4 py-3"
                  style={{
                    background: msg.isOutgoing
                      ? 'color-mix(in srgb, var(--oa-primary) 10%, var(--oa-surface-center, var(--popover)) 90%)'
                      : 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 76%, transparent)',
                    border: `var(--border-width) solid ${msg.isOutgoing
                      ? 'color-mix(in srgb, var(--oa-primary) 18%, var(--oa-border, var(--border)) 82%)'
                      : 'color-mix(in srgb, var(--oa-border, var(--border)) 72%, transparent)'}`,
                  }}
                >
                  {!msg.isOutgoing && thread.participants.length > 2 && (
                    <p className="mb-1.5 text-ui-xs text-[var(--oa-text-faint)]">{msg.from}</p>
                  )}
                  <p className="whitespace-pre-wrap break-words text-ui-sm leading-6 text-[var(--oa-text)]">
                    {msg.body}
                  </p>
                  <p className="mt-2 text-ui-xs text-[var(--oa-text-faint)]">
                    {formatDate(msg.date)}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {error && (
        <div className="px-5 pb-3">
          <div
            className={`${contentWidthClass} rounded-[14px] px-3 py-2.5 text-ui-sm text-destructive`}
            style={{
              background: 'color-mix(in srgb, var(--destructive) 6%, transparent)',
              border: 'var(--border-width) solid color-mix(in srgb, var(--destructive) 18%, transparent)',
            }}
          >
            {error}
          </div>
        </div>
      )}

      <div
        className="px-5 pb-5 pt-4"
        style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 70%, transparent)' }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className={`${contentWidthClass} flex items-end gap-3`}
        >
          <Input
            ref={inputRef}
            type="text"
            placeholder="Write a reply"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="min-h-[var(--oa-control-h-lg)] flex-1 rounded-[18px] border-[var(--oa-border)] bg-[var(--oa-bg-input)] px-4"
            disabled={sending}
            data-help-title={t('help.chat.messageInput.title')}
            data-help-description={t('help.chat.messageInput.description')}
          />
          <Button
            type="submit"
            variant="secondary"
            size="icon"
            disabled={!message.trim() || sending}
            className="shrink-0 rounded-full"
            data-help-title={t('help.chat.send.title')}
            data-help-description={t('help.chat.send.description')}
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
