import { useCallback, useEffect, useState } from 'react';
import { getAppServerOrigin, isBrowserDevMode } from '@/ipc';
import { InboxSetupWhatsApp } from '../InboxSetupWhatsApp';

type ChannelStatus = {
  threadId: string | null;
  configured: boolean;
  connected: boolean;
  accountMatches: boolean;
};

async function channelRequest(path: string, method = 'GET', body?: unknown) {
  const origin = isBrowserDevMode() ? '' : await getAppServerOrigin();
  const response = await fetch(`${origin}/api/servers/whatsapp/${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'WhatsApp is unavailable. Try again.');
  return payload;
}

/** The single paired self-chat account may bind exactly one existing thread. */
export function SimpleChannelsSettings({ threadId }: { threadId: string | null }) {
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await channelRequest('thread-binding') as ChannelStatus);
    setError(null);
  }, []);
  useEffect(() => {
    let mounted = true;
    void refresh().catch(() => { if (mounted) setError('Could not check WhatsApp. Try again.'); });
    const onFocus = () => { void refresh().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => { mounted = false; window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const action = async (work: () => Promise<unknown>) => {
    setPending(true); setError(null);
    try { await work(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change WhatsApp connection.'); }
    finally { setPending(false); }
  };
  const bindingMatches = !!threadId && status?.threadId === threadId && status.accountMatches;

  return (
    <section aria-labelledby="simple-channels-heading" className="mt-7 border-t border-foreground/[0.08] pt-5">
      <h2 id="simple-channels-heading" className="text-ui-sm font-medium text-foreground">Durable conversation & channels</h2>
      <p className="mt-1 text-ui-sm leading-5 text-muted-foreground">
        Your ongoing conversation stays on this device. Messages from a paired channel can wake the same thread.
      </p>
      <p className="mt-3 text-ui-sm text-foreground">
        Conversation: <strong>{threadId ? 'On' : 'Not started'}</strong>
        {threadId && <span className="ml-1 font-mono text-ui-xs text-muted-foreground" title={threadId}>· {threadId.slice(0, 12)}</span>}
      </p>
      {!threadId && <p className="mt-1 text-ui-xs text-muted-foreground">Send your first message to create this durable thread, then bind WhatsApp here.</p>}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-ui-sm font-medium text-foreground">WhatsApp</h3>
          <p role="status" className="text-ui-xs text-muted-foreground">
            {!status ? 'Checking connection…' : !status.configured ? 'Not connected' : !status.connected ? 'Reconnecting — open WhatsApp to retry' : bindingMatches ? 'Connected · wakes this conversation' : status.threadId ? 'Connected · bound to another conversation' : 'Connected · choose a conversation to wake'}
          </p>
        </div>
        <div className="flex gap-2">
          {status?.connected && threadId && !bindingMatches && (
            <button type="button" disabled={pending} onClick={() => void action(() => channelRequest('thread-binding', 'PUT', { threadId }))}
              className="rounded-full border border-foreground/[0.12] px-3 py-1.5 text-ui-sm text-foreground hover:bg-foreground/[0.06] disabled:opacity-50">
              {status.threadId ? 'Move binding here' : 'Bind this thread'}
            </button>
          )}
          {status?.threadId && (
            <button type="button" disabled={pending} onClick={() => void action(() => channelRequest('thread-binding', 'DELETE', { threadId: status.threadId }))}
              className="rounded-full px-3 py-1.5 text-ui-sm text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-50">Unbind</button>
          )}
          {status?.configured ? (<>
            {!status.connected && <button type="button" onClick={() => setPairing(true)} className="rounded-full border border-foreground/[0.12] px-3 py-1.5 text-ui-sm text-foreground">Reconnect</button>}
            <button type="button" disabled={pending} onClick={() => void action(async () => {
              if (status.threadId) await channelRequest('thread-binding', 'DELETE', { threadId: status.threadId });
              await channelRequest('disconnect', 'POST');
            })} className="rounded-full px-3 py-1.5 text-ui-sm text-muted-foreground hover:bg-foreground/[0.06] disabled:opacity-50">Disconnect</button>
          </>) : (
            <button type="button" onClick={() => setPairing(true)} className="rounded-full border border-foreground/[0.12] px-3 py-1.5 text-ui-sm text-foreground hover:bg-foreground/[0.06]">Connect</button>
          )}
        </div>
      </div>
      {pairing && <div className="mt-3 overflow-hidden rounded-2xl border border-foreground/[0.1]">
        <InboxSetupWhatsApp onConnected={() => { setPairing(false); void refresh(); }} onCancel={() => setPairing(false)} />
      </div>}
      {error && <p role="alert" className="mt-2 text-ui-sm text-destructive">{error} <button type="button" onClick={() => void refresh().catch(() => setError('Could not check WhatsApp. Try again.'))} className="underline">Retry status</button></p>}
      <details className="mt-4 text-ui-xs text-muted-foreground">
        <summary className="cursor-pointer text-ui-sm">Advanced wake methods</summary>
        <p className="mt-2">Existing local CLI, authenticated webhook, and schedule wake sources can resume a bound thread. Manage their credentials and schedules in Advanced settings; they are not exposed to WhatsApp.</p>
      </details>
    </section>
  );
}
