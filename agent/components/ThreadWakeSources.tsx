import { useCallback, useEffect, useState } from 'react';
import { getApiUrl } from '../../src/ipc';

type Source = {
  id: string; kind: 'schedule' | 'command'; status: string;
  nextAt?: string; at?: string; message?: string; argv?: string[]; everyMs?: number; error?: string;
};
type Event = { eventId: string; sourceId: string; status: string; error?: string };

export function wakeLocalDateTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ThreadWakeIndicator({ threadId }: { threadId: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const response = await fetch(await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/wake-sources`), { credentials: 'include' });
        if (!response.ok) return;
        const data = await response.json() as { sources: Source[] };
        if (live && Array.isArray(data.sources)) setCount(data.sources.filter(source => source.status !== 'cancelled').length);
      } catch { /* Passive indicator; detailed error stays in the editor. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [threadId]);
  return count ? <span className="absolute right-3 top-3 z-10 rounded-full border border-border bg-background px-2 py-1 text-xs" title={`${count} persistent wake sources`} data-testid="thread-wake-indicator">● {count}</span> : null;
}

/** Ordinary thread accessory, not a separate conversation mode. */
export function ThreadWakeSources({ threadId, readOnly = false }: { threadId: string; readOnly?: boolean }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [kind, setKind] = useState<'schedule' | 'command'>('schedule');
  const [message, setMessage] = useState('');
  const [when, setWhen] = useState('');
  const [interval, setIntervalValue] = useState('');
  const [command, setCommand] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const response = await fetch(await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/wake-sources`), { credentials: 'include' });
    if (!response.ok) throw new Error(`Wake sources unavailable (${response.status})`);
    const data = await response.json() as Partial<{ sources: Source[]; events: Event[] }>;
    if (!Array.isArray(data.sources) || !Array.isArray(data.events)) {
      throw new Error('Invalid wake source response');
    }
    setSources(data.sources);
    setEvents(data.events);
    setError('');
  }, [threadId]);

  useEffect(() => {
    void refresh().catch(e => setError(String(e)));
    const timer = window.setInterval(() => void refresh().catch(e => setError(String(e))), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const reset = () => { setEditing(null); setMessage(''); setWhen(''); setIntervalValue(''); setCommand(''); };
  const edit = (source: Source) => {
    setEditing(source.id); setKind(source.kind); setMessage(source.message ?? '');
    setWhen(wakeLocalDateTime(source.nextAt ?? source.at));
    setIntervalValue(source.everyMs ? String(source.everyMs / 60_000) : '');
    setCommand(JSON.stringify(source.argv ?? []));
  };
  const save = async () => {
    try {
      const id = editing ?? crypto.randomUUID();
      const body = kind === 'schedule'
        ? { kind, message, at: new Date(when).toISOString(), ...(interval ? { everyMs: Number(interval) * 60_000 } : {}) }
        : { kind, argv: JSON.parse(command) };
      const response = await fetch(await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/wake-sources/${encodeURIComponent(id)}`), {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? 'Save failed');
      reset(); setError(''); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
  };
  const cancel = async (id: string) => {
    try {
      const response = await fetch(await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/wake-sources/${encodeURIComponent(id)}`), { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error('Cancel failed');
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  return <div className="rounded-lg border border-border px-3 py-2 text-xs" data-testid="thread-wake-sources">
    <details>
      <summary className="cursor-pointer font-medium">{sources.some(s => s.status !== 'cancelled') ? '● ' : '○ '}Automations · {sources.filter(s => s.status !== 'cancelled').length}</summary>
      <div className="mt-2 space-y-2">
        {sources.filter(s => s.status !== 'cancelled').map(source => <div key={source.id} className="flex items-center gap-2 rounded border border-border p-2">
          <span className="min-w-0 flex-1 truncate">{source.kind === 'schedule'
            ? `Schedule · ${source.nextAt ? new Date(source.nextAt).toLocaleString() : 'done'} · ${source.message}`
            : `Command · ${source.argv?.join(' ')}`}</span>
          <span title={source.error} className={source.status === 'error' ? 'text-red-500' : 'text-muted-foreground'}>{source.status}{source.error ? ` · ${source.error}` : ''}</span>
          {!readOnly && <><button type="button" onClick={() => edit(source)}>Edit</button><button type="button" onClick={() => void cancel(source.id)}>Cancel</button></>}
        </div>)}
        {events.filter(e => e.status !== 'admitted').map(e => <div key={`${e.sourceId}:${e.eventId}`} className="text-muted-foreground">Input {e.eventId}: {e.error ?? (e.status === 'offered' ? 'waiting for native admission' : 'waiting')}</div>)}
        {!readOnly && <div className="space-y-1">
          <select aria-label="Wake source type" value={kind} onChange={e => setKind(e.target.value as 'schedule' | 'command')}><option value="schedule">Schedule</option><option value="command">Command</option></select>
          {kind === 'schedule' ? <div className="flex gap-1"><input aria-label="Upcoming time" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /><input aria-label="Message" placeholder="Message" value={message} onChange={e => setMessage(e.target.value)} /><input aria-label="Repeat minutes" type="number" min="1" placeholder="Repeat minutes (optional)" value={interval} onChange={e => setIntervalValue(e.target.value)} /></div>
            : <input aria-label="Command arguments" className="w-full" placeholder={'["/absolute/executable", "argument"]'} value={command} onChange={e => setCommand(e.target.value)} />}
          <button type="button" onClick={() => void save()}>{editing ? 'Save' : 'Add source'}</button> {editing && <button type="button" onClick={reset}>Discard</button>}
        </div>}
        {error && <div role="alert" className="text-red-500">{error}</div>}
      </div>
    </details>
  </div>;
}
