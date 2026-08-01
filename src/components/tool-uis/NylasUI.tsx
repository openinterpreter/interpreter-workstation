import { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { getAppServerOrigin, openExternal, isBrowserDevMode } from '@/ipc';

interface NylasUIProps {
  serverId: string;
}

export function NylasUI({ serverId: _serverId }: NylasUIProps) {
  const [configured, setConfigured] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Helper to get base URL for Nylas-specific routes
  async function getNylasBaseUrl() {
    if (isBrowserDevMode()) {
      return '/api/servers/nylas';
    }
    const origin = await getAppServerOrigin();
    return `${origin}/api/servers/nylas`;
  }

  useEffect(() => {
    checkStatus();
  }, []);

  async function checkStatus() {
    try {
      const baseUrl = await getNylasBaseUrl();
      const response = await fetch(`${baseUrl}/setup/status`);
      const data = await response.json();
      setConfigured(data.configured);
      setEmail(data.email ?? null); // Use ?? for truly optional field
    } catch (error) {
      console.error('Failed to check Nylas status:', error);
    }
  }

  async function handleSetup() {
    try {
      setLoading(true);
      setMessage(null);

      const baseUrl = await getNylasBaseUrl();
      const response = await fetch(`${baseUrl}/setup`, {
        method: 'POST'
      });

      if (!response.ok) {
        setMessage({ type: 'error', text: 'Failed to start OAuth setup' });
        setLoading(false);
        return;
      }

      const { setupUrl } = await response.json();

      // Open OAuth in browser
      await openExternal(setupUrl);

      setMessage({ type: 'success', text: 'Opening browser for authorization...' });

      // Poll for completion
      const pollInterval = setInterval(async () => {
        const statusResponse = await fetch(`${baseUrl}/setup/status`);
        const status = await statusResponse.json();

        if (status.configured) {
          clearInterval(pollInterval);
          setConfigured(true);
          setEmail(status.email);
          setMessage({ type: 'success', text: `Connected: ${status.email}` });
          setLoading(false);
        }
      }, 2000);

      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        setLoading(false);
      }, 300000);

    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    try {
      setLoading(true);
      setMessage(null);

      const baseUrl = await getNylasBaseUrl();
      const response = await fetch(`${baseUrl}/disconnect`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to disconnect');
      }

      setConfigured(false);
      setEmail(null);
      setMessage({ type: 'success', text: 'Disconnected' });
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }

  const messageToneStyle = message?.type === 'success'
    ? {
        border: 'var(--border-width) solid color-mix(in srgb, rgb(34 197 94) 28%, transparent)',
        background: 'color-mix(in srgb, rgb(34 197 94) 10%, transparent)',
      }
    : {
        border: 'var(--border-width) solid color-mix(in srgb, rgb(239 68 68) 24%, transparent)',
        background: 'color-mix(in srgb, rgb(239 68 68) 8%, transparent)',
      };

  return (
    <div
      className="mt-4 pt-4"
      style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)' }}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <h4 className="text-ui-sm font-medium text-foreground">Email Configuration</h4>
          <p className="max-w-2xl text-ui-sm leading-6 text-muted-foreground">
            Connect an email account to let the tool access your mailbox through Nylas.
          </p>
        </div>

        {message && (
          <div
            className="rounded-[14px] px-3 py-2 text-ui-sm"
            style={messageToneStyle}
          >
            {message.text}
          </div>
        )}

        {configured && email ? (
          <div className="space-y-4">
            <div
              className="rounded-[14px] px-3 py-2"
              style={{
                border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)',
                background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 72%, transparent)',
              }}
            >
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Connected
              </div>
              <div className="mt-1 text-ui-sm leading-6 text-foreground">{email}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={handleDisconnect}
                disabled={loading}
                variant="outline"
                size="sm"
              >
                {loading ? 'Disconnecting...' : 'Disconnect Email'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="max-w-2xl text-ui-sm leading-6 text-muted-foreground">
              Connect your email account to access your messages. Supports Gmail, Outlook, Yahoo, and more.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={handleSetup}
                disabled={loading}
                variant="default"
                size="sm"
              >
                {loading ? 'Setting up...' : 'Connect Email Account'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
