import { useCallback, useEffect, useState } from 'react';
import { getApiUrl } from '@/ipc';
import { ThreadWakeSources } from '../../../agent/components/ThreadWakeSources';
import { SimpleChannelsSettings } from '../simple/SimpleChannelsSettings';
import { SettingsPane, SettingsSection } from './SettingsSection';

type Thread = { id: string; preview?: string; name?: string };

/** Advanced management of real OIX threads and the existing wake-source API. */
export function DurableThreadsSectionContent() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    try {
      const url = `/api/agent/threads${next ? `?cursor=${encodeURIComponent(next)}` : ''}`;
      const response = await fetch(await getApiUrl(url), { credentials: 'include' });
      if (!response.ok) throw new Error(`Cannot load conversations (${response.status}).`);
      const payload = await response.json() as { data?: Thread[]; nextCursor?: string | null };
      if (!Array.isArray(payload.data) || payload.data.some((item) => typeof item.id !== 'string')) {
        throw new Error('Conversation list is unavailable.');
      }
      setThreads((current) => next ? [...current, ...payload.data!.filter((item) => !current.some((entry) => entry.id === item.id))] : payload.data!);
      setCursor(payload.nextCursor ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cannot load conversations.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <SettingsPane>
    <SettingsSection title="Durable Threads" sectionId="durableThreads"
      description="Each ongoing conversation stays on this device. Select a thread to pair its WhatsApp self-chat or manage supported wake schedules and local commands.">
      <div className="py-4 text-ui-sm">
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-full border border-border px-3 py-1.5 disabled:opacity-50">Refresh conversations</button>
        {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
        {!threads.length && !loading && !error && <p className="mt-3 text-muted-foreground">No threads yet. Send a message in a conversation to create one.</p>}
        <ul aria-label="Existing durable threads" className="mt-3 max-h-52 space-y-1 overflow-y-auto">
          {threads.map((thread) => <li key={thread.id}>
            <button type="button" onClick={() => setSelected(thread.id)} aria-pressed={selected === thread.id}
              className="w-full truncate rounded-xl px-3 py-2 text-left hover:bg-foreground/[0.06] aria-pressed:bg-foreground/[0.08]"
              title={thread.id}>{thread.name || thread.preview || `Conversation ${thread.id.slice(0, 12)}`}</button>
          </li>)}
        </ul>
        {cursor && <button type="button" disabled={loading} onClick={() => void load(cursor)} className="mt-2 text-muted-foreground underline">Load more</button>}
        {selected && threads.some((thread) => thread.id === selected) && <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 font-medium">Selected conversation <span className="font-mono font-normal text-muted-foreground">{selected.slice(0, 12)}</span></p>
          <SimpleChannelsSettings threadId={selected} />
          <div className="mt-5"><ThreadWakeSources threadId={selected} /></div>
        </div>}
      </div>
    </SettingsSection>
  </SettingsPane>;
}
