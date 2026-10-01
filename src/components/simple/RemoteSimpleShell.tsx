import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, Settings2 } from 'lucide-react';
import { projectDocument } from './SimpleInterface';
import { remoteSimpleClient, type RemoteConnection } from './remoteSimpleClient';
import { RemoteWorkstationsSection } from './RemoteWorkstationsSection';

type Snapshot = { bundle: string; revision: string; diagnostic: string | null; projectId: string };

/** One independently mounted remote instrument; no local active-window ownership coupling. */
export function RemoteSimpleShell({ connection, windowId, onClose }: {
  connection: RemoteConnection; windowId: string; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'agent'; text: string }>>([]);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [capabilities, interfaceState, conversation] = await Promise.all([
        remoteSimpleClient.capabilities(connection.id), remoteSimpleClient.readInterface(connection.id),
        remoteSimpleClient.conversation(connection.id),
      ]);
      if (capabilities.projectId !== connection.projectId || capabilities.threadId !== connection.threadId
          || interfaceState.projectId !== connection.projectId) throw new Error('Remote project identity changed');
      setSnapshot(previous => previous?.revision === interfaceState.revision
        ? { ...previous, diagnostic: interfaceState.diagnostic } : interfaceState);
      setMessages(conversation.messages); setStatus('connected'); setError(null);
    } catch (cause) { setStatus('disconnected'); setError(cause instanceof Error ? cause.message : 'Could not reconnect'); }
  }, [connection]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (status !== 'connected') return;
    let alive = true;
    let stream: EventSource | null = null;
    void remoteSimpleClient.eventsUrl(connection.id).then(url => {
      if (!alive) return;
      stream = new EventSource(url);
      stream.addEventListener('interface', () => { void remoteSimpleClient.readInterface(connection.id).then(next => {
      if (next.projectId !== connection.projectId) throw new Error('Remote project identity changed');
      setSnapshot(previous => previous?.revision === next.revision ? { ...previous, diagnostic: next.diagnostic } : next);
      }).catch(() => setStatus('disconnected')); });
      stream.addEventListener('delta', (event) => {
      try { const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (payload.text) setMessages(items => {
          const last = items[items.length - 1];
          return last?.role === 'agent' ? [...items.slice(0, -1), { role: 'agent', text: last.text + payload.text }]
            : [...items, { role: 'agent', text: payload.text! }];
        }); } catch { /* Ignore a damaged stream event; history remains authoritative. */ }
      });
      stream.addEventListener('completed', () => { void remoteSimpleClient.conversation(connection.id).then(value => setMessages(value.messages)); });
      stream.onerror = () => { setStatus('disconnected'); stream?.close(); };
    }).catch(() => setStatus('disconnected'));
    return () => { alive = false; stream?.close(); };
  }, [connection.id, connection.projectId, status]);

  async function send(message: string, source: 'composer' | 'interface' | 'voice') {
    if (!message.trim() || status !== 'connected') return;
    try {
      await remoteSimpleClient.send(connection.id, windowId, message.trim(), source);
      setText(''); setError(null);
      setMessages(items => [...items, { role: 'user', text: message.trim() }]);
    } catch (cause) { setStatus('disconnected'); setError(cause instanceof Error ? cause.message : 'Message not delivered'); }
  }

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !snapshot?.bundle || !event.data) return;
      if (event.data.type === 'interpreter-simple-interact') {
        setExpanded(false); setSettings(false);
        return;
      }
      if (event.data.type !== 'interpreter-simple-action' || typeof event.data.message !== 'string') return;
      setExpanded(false); setSettings(false);
      void send(event.data.message, 'interface');
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  });

  function submit(event: FormEvent) { event.preventDefault(); void send(text, 'composer'); }

  return <div data-remote-simple="true" className="relative h-screen w-full bg-background text-foreground">
    <main aria-label="Remote interface" className="absolute inset-0">
      {snapshot?.bundle ? <iframe key={`${connection.projectId}:${snapshot.revision}`} title="Remote generated interface" ref={frame}
        sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={projectDocument(snapshot.bundle)} className="h-full w-full border-0" />
        : <div className="p-12 text-muted-foreground">Opening remote interface…</div>}
    </main>
    <div className="absolute bottom-5 left-1/2 z-30 flex w-[calc(100%-1.5rem)] max-w-[680px] -translate-x-1/2 flex-col gap-1.5">
      {(expanded || settings) && <section aria-label={settings ? 'Remote Settings' : 'Remote conversation drawer'}
        className="flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-sky-700/40 bg-background/95 shadow-xl backdrop-blur-xl"
        style={{ height: 'min(65vh,640px)' }}>
        <header className="flex h-10 items-center justify-between px-4 text-ui-sm text-muted-foreground">
          <span>{settings ? 'Remote Settings' : 'Remote conversation'}</span>
          <button type="button" aria-label="Close remote drawer" onClick={() => { setExpanded(false); setSettings(false); }}><ChevronDown className="size-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {settings ? <RemoteWorkstationsSection /> : messages.map((message, index) => <p key={index} className="mb-3 whitespace-pre-wrap text-ui-sm">
            <strong>{message.role === 'agent' ? 'Interpreter' : 'You'}:</strong> {message.text}
          </p>)}
        </div>
      </section>}
      <section aria-label="Remote conversation" className="relative rounded-[22px] border border-sky-700/50 bg-background/95 px-3 pb-2 pt-2 shadow-xl backdrop-blur-xl">
        <div aria-hidden="true" className="absolute bottom-4 left-0 top-4 w-[2px] rounded-full bg-sky-500" />
        <div className="flex h-7 items-center justify-between gap-2 px-2 text-ui-xs text-muted-foreground">
          <span className="truncate">Remote · {connection.projectId.slice(0, 8)} · {status}</span>
          <div className="flex gap-2"><button type="button" aria-label="Close remote project" onClick={onClose}>Close</button>
            <button type="button" aria-label="Open remote settings" onClick={() => { setSettings(true); setExpanded(false); }}><Settings2 className="size-4" /></button>
            <button type="button" aria-label={expanded ? 'Collapse remote conversation' : 'Expand remote conversation'}
              onClick={() => { setExpanded(!expanded); setSettings(false); }}>{expanded ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}</button></div>
        </div>
        <form onSubmit={submit} className="flex gap-2"><input aria-label="Message remote Interpreter" value={text}
          onChange={event => setText(event.target.value)} disabled={status !== 'connected'} placeholder="Ask Interpreter…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-ui-sm" />
          <button type="submit" disabled={!text.trim() || status !== 'connected'} className="rounded-lg px-3 text-ui-sm">Send</button>
          <button type="button" disabled={status !== 'connected'} aria-label="Stop remote turn"
            onClick={() => void remoteSimpleClient.stop(connection.id).catch(() => setStatus('disconnected'))} className="rounded-lg px-2 text-ui-xs">Stop</button></form>
        {snapshot?.diagnostic && <p role="status" className="text-ui-xs">Interface edit needs fixing; last working version remains visible.</p>}
        {error && <p role="alert" className="text-ui-xs text-destructive">{error}
          <button type="button" onClick={() => void refresh()} className="ml-2 underline">Reconnect</button></p>}
      </section>
    </div>
  </div>;
}
