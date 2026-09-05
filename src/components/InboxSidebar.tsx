import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Phone, Send, RefreshCw, Loader2, Search, X } from 'lucide-react';
import { useLayoutActions } from '../hooks/useLayout';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { getAppServerOrigin, openExternal, isBrowserDevMode } from '@/ipc';
import type { ChannelStatus, UnifiedMessage, MessagingChannel } from '../../shared/types/messaging';
import { InboxSetupWhatsApp } from './InboxSetupWhatsApp';
import { InboxSetupTelegram } from './InboxSetupTelegram';
import {
  trackInboxFilterChanged,
  trackInboxRefreshed,
  trackInboxSearch,
  trackInboxSetupCompleted,
  trackInboxSetupFailed,
  trackInboxSetupStarted,
  trackInboxThreadOpened,
} from '../utils/telemetry';

type SetupView = 'none' | 'whatsapp' | 'telegram';
type ChannelFilter = 'all' | MessagingChannel;

const CHANNEL_ICONS: Record<MessagingChannel, typeof Mail> = {
  email: Mail,
  whatsapp: Phone,
  telegram: Send,
};
const railRowClass =
  'rounded-[12px] px-3 py-2.5 text-left transition-[background-color,color] duration-150 hover:bg-[var(--oa-bg-hover)]';

export function InboxSidebar() {
  "use no memo";

  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [setupView, setSetupView] = useState<SetupView>('none');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [connecting, setConnecting] = useState(false);
  const { openEmail, openChat } = useLayoutActions();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const getBaseUrl = useCallback(async () => {
    if (isBrowserDevMode()) return '';
    return getAppServerOrigin();
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const baseUrl = await getBaseUrl();
      const response = await fetch(`${baseUrl}/api/inbox/status`, { credentials: 'include' });
      const data = await response.json();
      setChannels(data.channels || []);
      return data.channels || [];
    } catch (err) {
      console.error('[InboxSidebar] Failed to fetch status:', err);
      return [];
    }
  }, [getBaseUrl]);

  const fetchMessages = useCallback(async (search?: string) => {
    try {
      setError(null);
      const baseUrl = await getBaseUrl();
      const params = new URLSearchParams({ limit: '30' });
      if (search) params.set('search', search);
      if (channelFilter !== 'all') params.set('channel', channelFilter);

      const response = await fetch(`${baseUrl}/api/inbox/messages?${params}`, { credentials: 'include' });
      const data = await response.json();
      const nextMessages = data.messages || [];
      setMessages(nextMessages);
      return nextMessages as UnifiedMessage[];
    } catch (err: any) {
      console.error('[InboxSidebar] Failed to fetch messages:', err);
      setError(err.message || 'Failed to load messages');
      return [] as UnifiedMessage[];
    }
  }, [getBaseUrl, channelFilter]);

  const initialize = useCallback(async () => {
    setLoading(true);
    const channelStatuses = await fetchStatus();
    const anyConfigured = channelStatuses.some((c: ChannelStatus) => c.configured);
    if (anyConfigured) {
      await fetchMessages();
    }
    setLoading(false);
  }, [fetchStatus, fetchMessages]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const anyConfigured = channels.some(c => c.configured);
      if (anyConfigured) {
        fetchMessages(searchQuery || undefined);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [channels, fetchMessages, searchQuery]);

  // Re-fetch when channel filter changes
  useEffect(() => {
    const anyConfigured = channels.some(c => c.configured);
    if (anyConfigured) {
      fetchMessages(searchQuery || undefined);
    }
  }, [channelFilter]);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    if (!searchQuery.trim()) {
      fetchMessages();
      return;
    }
    setSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      const nextMessages = await fetchMessages(searchQuery);
      trackInboxSearch({
        queryLength: searchQuery.trim().length,
        channelFilter,
        resultCount: nextMessages.length,
      });
      setSearching(false);
    }, 300);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery, fetchMessages]);

  const handleMessageClick = (msg: UnifiedMessage) => {
    trackInboxThreadOpened({
      channel: msg.channel,
      unread: msg.unread,
    });
    if (msg.channel === 'email') {
      openEmail(msg.threadId, msg.subject || '(no subject)');
    } else {
      openChat(msg.threadId, msg.channel, msg.from);
    }
  };

  const handleConnectEmail = async (entryPoint: 'empty_state' | 'add_account') => {
    try {
      trackInboxSetupStarted({ channel: 'email', entryPoint });
      setConnecting(true);
      setError(null);
      const baseUrl = await getBaseUrl();
      const response = await fetch(`${baseUrl}/api/servers/nylas/setup`, { method: 'POST', credentials: 'include' });
      if (!response.ok) {
        setError('Failed to start OAuth setup');
        setConnecting(false);
        trackInboxSetupFailed({
          channel: 'email',
          error: 'Failed to start OAuth setup',
          stage: 'oauth_start',
        });
        return;
      }
      const { setupUrl } = await response.json();
      await openExternal(setupUrl);

      const pollInterval = setInterval(async () => {
        const statuses = await fetchStatus();
        if (statuses.some((c: ChannelStatus) => c.channel === 'email' && c.configured)) {
          clearInterval(pollInterval);
          setConnecting(false);
          trackInboxSetupCompleted({ channel: 'email' });
          await fetchMessages();
        }
      }, 2000);
      setTimeout(() => { clearInterval(pollInterval); setConnecting(false); }, 300000);
    } catch (err: any) {
      setError(err.message);
      setConnecting(false);
      trackInboxSetupFailed({
        channel: 'email',
        error: err instanceof Error ? err.message : String(err),
        stage: 'oauth_start',
      });
    }
  };

  const handleRefresh = async () => {
    trackInboxRefreshed({
      channelFilter,
      searchActive: Boolean(searchQuery.trim()),
    });
    setLoading(true);
    await fetchStatus();
    await fetchMessages(searchQuery || undefined);
    setLoading(false);
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Show setup views
  if (setupView === 'whatsapp') {
    return (
      <InboxSetupWhatsApp
        onConnected={() => { setSetupView('none'); initialize(); }}
        onCancel={() => setSetupView('none')}
      />
    );
  }
  if (setupView === 'telegram') {
    return (
      <InboxSetupTelegram
        onConnected={() => { setSetupView('none'); initialize(); }}
        onCancel={() => setSetupView('none')}
      />
    );
  }

  // Loading state
  if (loading && channels.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4">
        <Loader2 className="size-6 animate-spin text-[var(--oa-text-muted)]" />
        <p className="mt-2 text-ui-base text-[var(--oa-text-muted)]">Loading...</p>
      </div>
    );
  }

  const configuredChannels = channels.filter(c => c.configured);
  const unconfiguredChannels = channels.filter(c => !c.configured);

  // No channels configured - show platform rows
  if (configuredChannels.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-auto px-1 py-1 text-[var(--oa-text)]">
        <div className="px-2 pb-5 pt-2">
          <div className="flex items-center gap-2">
            <Mail className="size-4 text-[var(--oa-text-muted)]" />
            <h2 className="text-ui-base font-medium">Inbox</h2>
          </div>
          <p className="mt-3 max-w-[260px] text-ui-sm text-[var(--oa-text-muted)]">
            Connect a messaging account to bring conversations into the Inbox rail.
          </p>
        </div>

        <div className="px-1">
          {error && (
            <div
              className="mb-4 rounded-[12px] px-3 py-2.5 text-ui-sm text-destructive"
              style={{
                background: 'color-mix(in srgb, var(--destructive) 5%, transparent)',
                border:
                  'var(--border-width) solid color-mix(in srgb, var(--destructive) 18%, transparent)',
              }}
            >
              {error}
            </div>
          )}

          <div className="mb-2 px-2 text-ui-xs font-medium tracking-[0.01em] text-[var(--oa-text-muted)]">
            Available channels
          </div>

          <div className="space-y-1">
            <button
              onClick={() => void handleConnectEmail('empty_state')}
              disabled={connecting}
              className={`${railRowClass} w-full disabled:opacity-60`}
              data-help-title={t('help.inbox.connectEmail.title')}
              data-help-description={t('help.inbox.connectEmail.description')}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
                    <Mail className="size-5 text-[var(--oa-text-muted)]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-ui-base font-medium">Email</p>
                    <p className="truncate text-ui-sm text-[var(--oa-text-muted)]">
                      {connecting ? 'Connecting your email account...' : 'Connect your email account'}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-ui-xs text-[var(--oa-text-muted)]">
                  {connecting ? 'Waiting' : 'OAuth'}
                </span>
              </div>
            </button>

            <button
              onClick={() => {
                trackInboxSetupStarted({ channel: 'whatsapp', entryPoint: 'empty_state' });
                setSetupView('whatsapp');
              }}
              className={`${railRowClass} w-full`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
                    <Phone className="size-5 text-[var(--oa-text-muted)]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-ui-base font-medium">WhatsApp</p>
                    <p className="truncate text-ui-sm text-[var(--oa-text-muted)]">
                      Scan a QR code from your phone
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-ui-xs text-[var(--oa-text-muted)]">QR</span>
              </div>
            </button>

            <button
              onClick={() => {
                trackInboxSetupStarted({ channel: 'telegram', entryPoint: 'empty_state' });
                setSetupView('telegram');
              }}
              className={`${railRowClass} w-full`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
                    <Send className="size-5 text-[var(--oa-text-muted)]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-ui-base font-medium">Telegram</p>
                    <p className="truncate text-ui-sm text-[var(--oa-text-muted)]">
                      Connect with a bot token
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-ui-xs text-[var(--oa-text-muted)]">
                  Token
                </span>
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // One or more channels configured - show unified message list
  return (
    <div className="flex h-full flex-col overflow-hidden px-1 py-1 text-[var(--oa-text)]">
      {/* Header */}
      <div className="flex items-center justify-between px-2 pb-2 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <Mail className="size-4 flex-shrink-0 text-[var(--oa-text-muted)]" />
          <h2 className="text-ui-base font-medium">Inbox</h2>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleRefresh}
            disabled={loading}
            title={t('help.inbox.refresh.title')}
            data-help-title={t('help.inbox.refresh.title')}
            data-help-description={t('help.inbox.refresh.description')}
            className="text-[var(--oa-text-muted)]"
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Channel filter pills */}
      <div className="mx-1 flex items-center gap-1 overflow-x-auto py-1">
        {(['all', ...configuredChannels.map(c => c.channel)] as ChannelFilter[]).map(filter => (
          <button
            key={filter}
            onClick={() => {
              trackInboxFilterChanged({ channelFilter: filter });
              setChannelFilter(filter);
            }}
            data-help-title={t('help.inbox.filter.title', { channel: filter === 'all' ? t('help.inbox.filter.all') : filter.charAt(0).toUpperCase() + filter.slice(1) })}
            data-help-description={t('help.inbox.filter.description')}
            className={`rounded-[10px] px-3 py-1.5 text-ui-sm whitespace-nowrap transition-colors ${
              channelFilter === filter
                ? 'bg-black/[0.06] text-[var(--oa-text)] dark:bg-white/[0.08]'
                : 'text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-hover)] hover:text-[var(--oa-text)]'
            }`}
          >
            {filter === 'all' ? 'All' : filter.charAt(0).toUpperCase() + filter.slice(1)}
          </button>
        ))}
      </div>

      {/* Search bar */}
      <div className="px-1 pb-2 pt-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--oa-text-muted)]" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder={t('help.inbox.search.title')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchQuery('');
                searchInputRef.current?.blur();
              }
            }}
            className="w-full !rounded-[var(--control-radius-lg)] py-2 pl-9 pr-8 text-ui-base shadow-none"
            data-help-title={t('help.inbox.search.title')}
            data-help-description={t('help.inbox.search.description')}
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--oa-text-muted)]"
              data-help-title={t('help.inbox.clearSearch.title')}
              data-help-description={t('help.inbox.clearSearch.description')}
            >
              <X className="size-4" />
            </Button>
          )}
          {searching && (
            <Loader2 className="absolute right-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--oa-text-muted)]" />
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          className="mx-1 mt-1 rounded-[12px] px-3 py-2.5 text-ui-sm text-destructive"
          style={{
            background: 'color-mix(in srgb, var(--destructive) 5%, transparent)',
            border:
              'var(--border-width) solid color-mix(in srgb, var(--destructive) 18%, transparent)',
          }}
        >
          {error}
        </div>
      )}

      {/* Message list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-1 pb-2 pt-1">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="size-5 animate-spin text-[var(--oa-text-muted)]" />
          </div>
        ) : messages.length === 0 ? (
          <div className="px-3 py-8">
            <p className="text-ui-base font-medium text-[var(--oa-text)]">
              {searchQuery ? 'No matching messages found' : 'No messages yet'}
            </p>
            <p className="mt-1 text-ui-sm text-[var(--oa-text-muted)]">
              {searchQuery
                ? 'Try a different term or clear your current search.'
                : 'Connected channels will appear here as soon as messages arrive.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {messages.map((msg) => {
              const Icon = CHANNEL_ICONS[msg.channel];
              return (
                <div
                  key={msg.id}
                  onClick={() => handleMessageClick(msg)}
                  className={`${railRowClass} ${msg.unread ? 'bg-black/[0.03] dark:bg-white/[0.045]' : 'bg-transparent'}`}
                  data-help-title={t('help.inbox.message.title', { channel: msg.channel.charAt(0).toUpperCase() + msg.channel.slice(1) })}
                  data-help-description={t('help.inbox.message.description')}
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon className="size-3.5 flex-shrink-0 text-[var(--oa-text-muted)]" />
                      {msg.unread ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className={`truncate text-[13px] leading-5 ${msg.unread ? 'font-medium text-[var(--oa-text)]' : 'text-[var(--oa-text)]/92'}`}>
                        {msg.from || 'Unknown'}
                      </span>
                    </div>
                    <span className="flex-shrink-0 text-[11px] tracking-[0.01em] text-[var(--oa-text-muted)]">
                      {formatDate(msg.date)}
                    </span>
                  </div>
                  {msg.subject && (
                    <div className={`mb-1 truncate text-[13px] leading-5 ${msg.unread ? 'text-[var(--oa-text)]/92' : 'text-[var(--oa-text-muted)]'}`}>
                      {msg.subject}
                    </div>
                  )}
                  <div className="line-clamp-2 text-ui-sm leading-5 text-[var(--oa-text-muted)]">
                    {msg.snippet}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add more accounts section */}
      {unconfiguredChannels.length > 0 && (
        <div
          className="mx-1 mt-2 pt-3"
          style={{
            borderTop:
              'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
          }}
        >
          <p className="mb-2 px-2 text-ui-sm text-[var(--oa-text-muted)]">Add account</p>
          <div className="flex gap-2">
            {unconfiguredChannels.map(ch => {
              const Icon = CHANNEL_ICONS[ch.channel];
              return (
                <Button
                  key={ch.channel}
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-1.5 rounded-full bg-[var(--oa-bg-input)] text-ui-sm shadow-none"
                  data-help-title={t('help.inbox.connectChannel.title', { channel: ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1) })}
                  data-help-description={t('help.inbox.connectChannel.description')}
                  onClick={() => {
                    if (ch.channel === 'email') {
                      void handleConnectEmail('add_account');
                    } else if (ch.channel === 'whatsapp') {
                      trackInboxSetupStarted({ channel: 'whatsapp', entryPoint: 'add_account' });
                      setSetupView('whatsapp');
                    } else if (ch.channel === 'telegram') {
                      trackInboxSetupStarted({ channel: 'telegram', entryPoint: 'add_account' });
                      setSetupView('telegram');
                    }
                  }}
                >
                  <Icon className="size-3.5" />
                  {ch.channel.charAt(0).toUpperCase() + ch.channel.slice(1)}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
