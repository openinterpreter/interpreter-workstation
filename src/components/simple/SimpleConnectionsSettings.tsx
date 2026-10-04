import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Check, Copy, KeyRound, Loader2, Network, Phone, RefreshCw } from 'lucide-react';
import { simpleLive } from '@/ipc';
import { saveWorkstationAccessToken, workstationFetch } from '@/remote/workstationConnection';
import type { WorkstationPairingPayload, WorkstationPairingSession } from '../../../shared/types/workstationConnection';
import { InboxSectionContent } from '../settings/InboxSection';

type LiveStatus = Awaited<ReturnType<typeof simpleLive.status>>;
type TailnetStatus = {
  installed: boolean;
  running: boolean;
  online: boolean;
  backendState: string;
  hostName: string | null;
  dnsName: string | null;
  endpoint: string | null;
  ips: string[];
  error: string | null;
  enabled: boolean;
};

type PairingResult = {
  pairing: WorkstationPairingPayload;
  qrDataUrl: string;
  status?: TailnetStatus;
};

async function connectionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await workstationFetch(`/api/workstation-connection${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Connection request failed (${response.status}).`);
  return body;
}

export function SimpleConnectionsSettings() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tailnet, setTailnet] = useState<TailnetStatus | null>(null);
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const [tailnetPending, setTailnetPending] = useState(false);
  const [tailnetError, setTailnetError] = useState<string | null>(null);
  const [remoteCode, setRemoteCode] = useState('');
  const [remotePending, setRemotePending] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await simpleLive.status());
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Could not check GPT Live setup.');
    });
  }, [refresh]);

  const refreshTailnet = useCallback(async () => {
    setTailnet(await connectionRequest<TailnetStatus>('/tailscale'));
  }, []);

  useEffect(() => {
    void refreshTailnet().catch((cause) => {
      setTailnetError(cause instanceof Error ? cause.message : 'Could not check private access.');
    });
  }, [refreshTailnet]);

  const enableTailnet = async () => {
    setTailnetPending(true);
    setTailnetError(null);
    try {
      const result = await connectionRequest<PairingResult>('/tailscale/enable', { method: 'POST', body: '{}' });
      setPairing(result);
      if (result.status) setTailnet(result.status);
      else await refreshTailnet();
    } catch (cause) {
      setTailnetError(cause instanceof Error ? cause.message : 'Could not enable private access.');
    } finally {
      setTailnetPending(false);
    }
  };

  const refreshPairing = async () => {
    setTailnetPending(true);
    setTailnetError(null);
    try {
      setPairing(await connectionRequest<PairingResult>('/tailscale/pairing', { method: 'POST', body: '{}' }));
    } catch (cause) {
      setTailnetError(cause instanceof Error ? cause.message : 'Could not create a pairing code.');
    } finally {
      setTailnetPending(false);
    }
  };

  const disableTailnet = async () => {
    setTailnetPending(true);
    setTailnetError(null);
    try {
      await connectionRequest<{ success: true }>('/tailscale', { method: 'DELETE' });
      setPairing(null);
      await refreshTailnet();
    } catch (cause) {
      setTailnetError(cause instanceof Error ? cause.message : 'Could not disable private access.');
    } finally {
      setTailnetPending(false);
    }
  };

  const connectRemote = async () => {
    if (!remoteCode.trim() || remotePending) return;
    setRemotePending(true);
    setRemoteError(null);
    try {
      const payload = JSON.parse(remoteCode) as Partial<WorkstationPairingPayload>;
      if (payload.schemaVersion !== 1
        || typeof payload.endpoint !== 'string'
        || typeof payload.pairingToken !== 'string') {
        throw new Error('This pairing code is not valid.');
      }
      const endpoint = new URL(payload.endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
        throw new Error('Private Workstation codes must use HTTPS.');
      }
      const response = await fetch(new URL('/api/workstation-connection/pairings/redeem', endpoint), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingToken: payload.pairingToken }),
      });
      const session = await response.json().catch(() => ({})) as Partial<WorkstationPairingSession> & { error?: string };
      if (!response.ok || typeof session.accessToken !== 'string' || session.schemaVersion !== 1) {
        throw new Error(session.error || 'Could not pair with that Workstation.');
      }
      const access = session.access === 'read-only' ? 'read-only' : 'read-write';
      saveWorkstationAccessToken(endpoint.origin, access, session.accessToken);
      const result = await window.electron?.window.create({
        remoteConnection: {
          endpoint: endpoint.origin,
          access,
          authentication: 'pairing',
        },
      });
      if (window.electron && !result?.success) {
        throw new Error(result?.error || 'Could not open the remote Workstation window.');
      }
      if (!window.electron) {
        const target = new URL(window.location.href);
        target.search = new URLSearchParams({
          surface: 'workstation', endpoint: endpoint.origin, access, auth: 'pairing',
        }).toString();
        window.open(target.toString(), '_blank', 'noopener,noreferrer');
      }
      setRemoteCode('');
    } catch (cause) {
      setRemoteError(cause instanceof Error ? cause.message : 'Could not connect to that Workstation.');
    } finally {
      setRemotePending(false);
    }
  };

  const save = async () => {
    if (!simpleLive.configure || !apiKey.trim()) return;
    setPending(true);
    setError(null);
    try {
      await simpleLive.configure({ apiKey: apiKey.trim() });
      setApiKey('');
      await refresh();
      window.dispatchEvent(new Event('simple-live:configuration-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the OpenAI key.');
    } finally {
      setPending(false);
    }
  };

  const clear = async () => {
    if (!simpleLive.clearCredential) return;
    setPending(true);
    setError(null);
    try {
      await simpleLive.clearCredential();
      await refresh();
      window.dispatchEvent(new Event('simple-live:configuration-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the saved key.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-7">
      <section aria-labelledby="simple-gpt-live-heading">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-foreground/[0.05]">
            <AudioLines className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id="simple-gpt-live-heading" className="text-ui-sm font-medium text-foreground">
                GPT Live
              </h2>
              <span
                className={`size-1.5 rounded-full ${status?.configured ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                aria-label={status?.configured ? 'Configured' : 'Not configured'}
              />
            </div>
            <p className="mt-1 text-ui-sm text-muted-foreground">
              Talk naturally while Interpreter delegates computer work to this same durable conversation.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-[14px] border border-foreground/[0.09] p-3">
          {status?.configured ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground">
                <Check className="size-4 shrink-0" />
                <span className="truncate">
                  {status.source === 'secure' ? 'OpenAI key saved securely on this Mac' : 'Using your configured OpenAI model key'}
                </span>
              </div>
              {status.source === 'secure' && simpleLive.clearCredential ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void clear()}
                  className="shrink-0 rounded-full px-3 py-1.5 text-ui-sm text-muted-foreground hover:bg-foreground/[0.05] disabled:opacity-50"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ) : simpleLive.configure ? (
            <div className="space-y-3">
              <label className="block text-ui-sm font-medium text-foreground" htmlFor="simple-live-api-key">
                OpenAI API key
              </label>
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="simple-live-api-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-…"
                    className="h-9 w-full rounded-full border border-foreground/[0.1] bg-transparent pl-9 pr-3 text-ui-sm outline-none focus:border-foreground/[0.25]"
                  />
                </div>
                <button
                  type="button"
                  disabled={pending || !apiKey.trim()}
                  onClick={() => void save()}
                  className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-foreground px-4 text-ui-sm font-medium text-background disabled:opacity-40"
                >
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Save
                </button>
              </div>
              <p className="text-ui-xs text-muted-foreground">
                Stored with macOS encryption and never exposed back to the interface.
              </p>
            </div>
          ) : (
            <p className="text-ui-sm text-muted-foreground">
              Add an OpenAI model key in Models to enable GPT Live.
            </p>
          )}
          {error ? <p role="alert" className="mt-2 text-ui-sm text-destructive">{error}</p> : null}
        </div>
      </section>

      <section aria-labelledby="simple-whatsapp-heading" className="border-t border-foreground/[0.08] pt-5">
        <div className="mb-2 flex items-center gap-3">
          <Phone className="size-4 text-muted-foreground" />
          <h2 id="simple-whatsapp-heading" className="text-ui-sm font-medium text-foreground">WhatsApp</h2>
        </div>
        <p className="mb-2 text-ui-sm text-muted-foreground">
          Messages sent from your linked self-chat continue this Simple conversation and replies return to WhatsApp.
        </p>
        <InboxSectionContent compact />
      </section>

      <section aria-labelledby="simple-tailnet-heading" className="border-t border-foreground/[0.08] pt-5">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-sky-500/[0.08]">
            <Network className="size-4 text-sky-500/80" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 id="simple-tailnet-heading" className="text-ui-sm font-medium text-foreground">Private connection</h2>
              <span
                className={`size-1.5 rounded-full ${tailnet?.enabled ? 'bg-sky-500' : tailnet?.online ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                aria-label={tailnet?.enabled ? 'Private access enabled' : tailnet?.online ? 'Tailscale ready' : 'Not connected'}
              />
            </div>
            <p className="mt-1 text-ui-sm text-muted-foreground">
              Pair another Interpreter privately with this project. Tailscale stays underneath the experience.
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-[14px] border border-foreground/[0.09] bg-foreground/[0.015]">
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-ui-sm font-medium text-foreground">
                {tailnet?.enabled ? tailnet.hostName || 'This Workstation' : tailnet?.online ? 'Ready to connect' : 'Tailscale is not ready'}
              </p>
              <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
                {tailnet?.enabled && tailnet.endpoint
                  ? tailnet.endpoint.replace(/^https:\/\//, '')
                  : tailnet?.online
                    ? 'Private networking is ready on this Mac.'
                    : tailnet?.error || 'Open Tailscale and sign in on this Mac.'}
              </p>
            </div>
            {tailnet?.enabled ? (
              <button
                type="button"
                disabled={tailnetPending}
                onClick={() => void disableTailnet()}
                className="shrink-0 rounded-full px-3 py-1.5 text-ui-sm text-muted-foreground hover:bg-foreground/[0.05] disabled:opacity-50"
              >
                Turn off
              </button>
            ) : (
              <button
                type="button"
                disabled={tailnetPending || !tailnet?.online}
                onClick={() => void enableTailnet()}
                className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-foreground px-4 text-ui-sm font-medium text-background disabled:opacity-40"
              >
                {tailnetPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Enable
              </button>
            )}
          </div>

          {tailnet?.enabled ? (
            <div className="border-t border-foreground/[0.07] p-3">
              {pairing ? (
                <div className="grid gap-3 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-center">
                  <img
                    src={pairing.qrDataUrl}
                    alt="Pair this private Workstation"
                    className="size-28 rounded-[12px] bg-white p-1"
                  />
                  <div className="min-w-0">
                    <p className="text-ui-sm font-medium text-foreground">Pair this project</p>
                    <p className="mt-1 text-ui-xs leading-relaxed text-muted-foreground">
                      Scan from another Interpreter. The code expires at {new Date(pairing.pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} and works once.
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(JSON.stringify(pairing.pairing))}
                        className="flex h-8 items-center gap-1.5 rounded-full border border-foreground/[0.09] px-3 text-ui-xs text-foreground hover:bg-foreground/[0.04]"
                      >
                        <Copy className="size-3.5" /> Copy code
                      </button>
                      <button
                        type="button"
                        disabled={tailnetPending}
                        onClick={() => void refreshPairing()}
                        className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.04] disabled:opacity-40"
                        aria-label="Create another pairing code"
                      >
                        <RefreshCw className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={tailnetPending}
                  onClick={() => void refreshPairing()}
                  className="flex h-9 items-center gap-2 rounded-full border border-foreground/[0.09] px-4 text-ui-sm text-foreground hover:bg-foreground/[0.04] disabled:opacity-40"
                >
                  {tailnetPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Create pairing code
                </button>
              )}
            </div>
          ) : null}
        </div>
        {tailnetError ? <p role="alert" className="mt-2 text-ui-sm text-destructive">{tailnetError}</p> : null}

        <div className="mt-3 rounded-[14px] border border-foreground/[0.09] p-3">
          <label htmlFor="simple-remote-pairing-code" className="text-ui-sm font-medium text-foreground">
            Open another Workstation
          </label>
          <p className="mt-1 text-ui-xs text-muted-foreground">
            Paste its one-time pairing code. It opens as a separate project window.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              id="simple-remote-pairing-code"
              type="text"
              value={remoteCode}
              onChange={(event) => setRemoteCode(event.target.value)}
              placeholder="Paste pairing code"
              autoComplete="off"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-full border border-foreground/[0.1] bg-transparent px-3 text-ui-sm outline-none focus:border-foreground/[0.25]"
            />
            <button
              type="button"
              disabled={!remoteCode.trim() || remotePending}
              onClick={() => void connectRemote()}
              className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-foreground px-4 text-ui-sm font-medium text-background disabled:opacity-40"
            >
              {remotePending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Connect
            </button>
          </div>
          {remoteError ? <p role="alert" className="mt-2 text-ui-sm text-destructive">{remoteError}</p> : null}
        </div>
      </section>
    </div>
  );
}
