/**
 * InboxSetupTelegram Component
 *
 * Inline sidebar component for Telegram bot token setup.
 */

import { useState } from 'react';
import { Loader2, X, Send } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { getAppServerOrigin, isBrowserDevMode, openExternal } from '@/ipc';
import {
  trackInboxSetupCancelled,
  trackInboxSetupCompleted,
  trackInboxSetupFailed,
} from '../utils/telemetry';

interface InboxSetupTelegramProps {
  onConnected: () => void;
  onCancel: () => void;
}

export function InboxSetupTelegram({ onConnected, onCancel }: InboxSetupTelegramProps) {
  "use no memo";

  const [botToken, setBotToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    if (!botToken.trim()) return;

    try {
      setError(null);
      setConnecting(true);

      const baseUrl = isBrowserDevMode()
        ? ''
        : await getAppServerOrigin();

      const response = await fetch(`${baseUrl}/api/servers/telegram/setup`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to connect');
      }

      trackInboxSetupCompleted({ channel: 'telegram' });
      onConnected();
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      trackInboxSetupFailed({
        channel: 'telegram',
        error: message,
        stage: 'token_submit',
      });
    } finally {
      setConnecting(false);
    }
  };

  const dividerStyle = {
    borderColor:
      'color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
  };

  const panelStyle = {
    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 60%, transparent)',
    backgroundColor:
      'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 36%, transparent)',
  };

  return (
    <div className="flex h-full flex-col overflow-auto px-3 py-3 text-[var(--oa-text)]">
      <div
        className="flex items-start justify-between gap-4 px-1 pb-4"
        style={{ borderBottom: 'var(--border-width) solid', ...dividerStyle }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-[10px] bg-black/[0.04] dark:bg-white/[0.06]">
              <Send className="size-4 text-[var(--oa-text-muted)]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-ui-base font-medium">Connect Telegram</h2>
              <p className="mt-1 text-ui-sm text-[var(--oa-text-muted)]">
                Add a bot token to route Telegram messages into Inbox.
              </p>
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            trackInboxSetupCancelled({ channel: 'telegram' });
            onCancel();
          }}
          className="text-[var(--oa-text-muted)]"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-1 py-4">
        <div className="space-y-2">
          <p className="text-ui-sm text-[var(--oa-text-muted)]">
            Create a bot with{' '}
            <button
              onClick={() => openExternal('https://t.me/BotFather')}
              className="text-[var(--oa-link)] underline-offset-4 hover:underline"
            >
              @BotFather
            </button>
            {' '}on Telegram, then paste the token here.
          </p>
        </div>

        <div className="space-y-3 rounded-[18px] px-4 py-4" style={panelStyle}>
          <div className="space-y-1.5">
            <label className="block text-ui-sm font-medium text-[var(--oa-text)]">
              Bot token
            </label>
            <p className="text-ui-sm text-[var(--oa-text-muted)]">
              The token usually looks like{' '}
              <code className="rounded-[6px] bg-black/[0.04] px-1.5 py-0.5 text-[var(--oa-text)] dark:bg-white/[0.06]">
                123456:ABC-DEF...
              </code>
              .
            </p>
          </div>
          <Input
            type="text"
            placeholder="123456:ABC-DEF..."
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConnect();
              if (e.key === 'Escape') {
                trackInboxSetupCancelled({ channel: 'telegram' });
                onCancel();
              }
            }}
            className="w-full text-ui-base"
            disabled={connecting}
          />

          {error && (
            <div
              className="rounded-[14px] px-3 py-2.5 text-ui-sm text-destructive"
              style={{
                background: 'color-mix(in srgb, var(--destructive) 5%, transparent)',
                border:
                  'var(--border-width) solid color-mix(in srgb, var(--destructive) 18%, transparent)',
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="space-y-2 pt-4"
          style={{ borderTop: 'var(--border-width) solid', ...dividerStyle }}
        >
          <p className="text-ui-sm font-medium text-[var(--oa-text)]">What happens next</p>
          <p className="text-ui-sm text-[var(--oa-text-muted)]">
            We verify the token, connect the bot, and return you to the Inbox rail when the setup is complete.
          </p>
        </div>
      </div>

      <div
        className="mt-auto flex items-center justify-between gap-3 px-1 pt-3"
        style={{ borderTop: 'var(--border-width) solid', ...dividerStyle }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            trackInboxSetupCancelled({ channel: 'telegram' });
            onCancel();
          }}
          className="text-[var(--oa-text-muted)]"
        >
          Cancel
        </Button>
        <Button
          onClick={handleConnect}
          disabled={!botToken.trim() || connecting}
          className="flex items-center justify-center gap-2"
        >
          {connecting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Connecting...
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </div>
    </div>
  );
}
