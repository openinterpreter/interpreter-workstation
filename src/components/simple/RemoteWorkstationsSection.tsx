import { useCallback, useEffect, useState } from 'react';
import { apiRequest, writeClipboardText } from '@/ipc';
import { remoteSimpleClient, type RemoteConnection, type RemoteOffer } from './remoteSimpleClient';

type OfferDisplay = { qr: RemoteOffer; qrImage: string; code: string };

export function RemoteWorkstationsSection({ projectId, windowId }: { projectId?: string; windowId?: string }) {
  const [connections, setConnections] = useState<RemoteConnection[]>([]);
  const [health, setHealth] = useState<Record<string, 'checking' | 'connected' | 'unavailable'>>({});
  const [offerText, setOfferText] = useState('');
  const [code, setCode] = useState('');
  const [display, setDisplay] = useState<OfferDisplay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshConnections = useCallback(async (alive: () => boolean = () => true) => {
    try {
      const items = await remoteSimpleClient.list();
      if (!alive()) return;
      setConnections(items);
      setHealth(Object.fromEntries(items.map(item => [item.id, 'checking'])));
      await Promise.all(items.map(async item => {
        let state: 'connected' | 'unavailable' = 'unavailable';
        try {
          const capability = await remoteSimpleClient.capabilities(item.id);
          if (capability.projectId === item.projectId && capability.threadId === item.threadId) state = 'connected';
        } catch { /* A stored connection can be offline or expired. */ }
        if (alive()) setHealth(previous => ({ ...previous, [item.id]: state }));
      }));
    } catch { if (alive()) setError('Could not load connections.'); }
  }, []);
  useEffect(() => { let alive = true; void refreshConnections(() => alive); return () => { alive = false; }; }, [refreshConnections]);

  async function connect() {
    setBusy(true); setError(null);
    try {
      const offer = JSON.parse(offerText) as RemoteOffer;
      const connected = await remoteSimpleClient.connect(offer, code.trim().toUpperCase());
      setConnections(items => [...items, connected]); setHealth(previous => ({ ...previous, [connected.id]: 'connected' }));
      setCode(''); setOfferText('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection failed'); }
    finally { setBusy(false); }
  }

  async function showPairing() {
    if (!projectId || !windowId) return;
    setBusy(true); setError(null);
    try {
      const response = await apiRequest({ method: 'POST', path: '/api/simple-interface/projects/pairing', body: { projectId, windowId } });
      if (!response.ok) throw new Error('Private hosting is not available for this project.');
      setDisplay(response.data as OfferDisplay);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Pairing unavailable'); }
    finally { setBusy(false); }
  }

  async function disconnect(id: string) {
    setBusy(true); setError(null);
    try {
      const outcome = await remoteSimpleClient.disconnect(id);
      setConnections(items => items.filter(item => item.id !== id));
      if (!outcome.revoked) setError('Disconnected locally. The remote session could not be revoked; it will expire on the host.');
    } catch { setError('Could not disconnect this remote project.'); }
    finally { setBusy(false); }
  }

  return <section aria-label="Remote Workstations" className="mt-6 space-y-3 border-t border-border pt-5 text-ui-sm">
    <h2 className="font-medium">Remote Workstations</h2>
    <p className="text-muted-foreground">Connect a project over your private tailnet. Device enrollment is separate from project pairing.</p>
    {connections.map(item => <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      <span className="truncate">Remote project {item.projectId.slice(0, 8)} · {health[item.id] === 'connected' ? 'Connected' : health[item.id] === 'unavailable' ? 'Unavailable' : 'Checking'}</span>
      <button type="button" disabled={busy || health[item.id] !== 'connected'} onClick={() => void window.electron?.window.create({ simpleInterfacePicker: true })} className="shrink-0 underline">Open window</button>
      <button type="button" disabled={busy} onClick={() => void disconnect(item.id)} className="shrink-0 underline">Disconnect</button>
    </div>)}
    <button type="button" disabled={busy} onClick={() => void refreshConnections()} className="underline">Refresh status</button>
    <details><summary className="cursor-pointer">Connect a remote project</summary>
      <div className="mt-2 space-y-2"><label className="block">Pairing offer
        <textarea aria-label="Pairing offer" className="mt-1 w-full rounded-md border border-border bg-background p-2" value={offerText}
          onChange={event => setOfferText(event.target.value)} placeholder="Paste the project's QR text or copyable pairing offer" /></label>
        <label className="block">One-time code<input aria-label="One-time code" autoComplete="off"
          className="mt-1 w-full rounded-md border border-border bg-background p-2" value={code} onChange={event => setCode(event.target.value)} /></label>
        <button type="button" disabled={busy || !offerText.trim() || !code.trim()} onClick={() => void connect()}
          className="rounded-md border border-border px-3 py-1.5">Connect</button></div>
    </details>
    {projectId && windowId && <div><button type="button" disabled={busy} onClick={() => void showPairing()}
      className="rounded-md border border-border px-3 py-1.5">Pair this project with another device</button>
      {display && <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
        <img src={display.qrImage} alt="Project pairing QR" width={196} height={196} />
        <p>Expires in two minutes. The one-time code is not in the QR.</p>
        <button type="button" onClick={() => void writeClipboardText(JSON.stringify(display.qr))} className="underline">Copy pairing offer</button>
        <p>Code: <span className="font-mono">{display.code}</span></p>
        <button type="button" onClick={() => void writeClipboardText(display.code)} className="underline">Copy code</button>
      </div>}</div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
