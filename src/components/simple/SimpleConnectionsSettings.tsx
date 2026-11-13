import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Check, KeyRound, Loader2 } from 'lucide-react';
import { simpleLive } from '@/ipc';

type LiveStatus = Awaited<ReturnType<typeof simpleLive.status>>;

export function SimpleConnectionsSettings() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await simpleLive.status());
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Could not check GPT Live setup.');
    });
  }, [refresh]);

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
                  {status.source === 'secure' ? 'OpenAI key saved securely on this device' : 'Using your configured OpenAI model key'}
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
                Stored securely on this device and never exposed back to the interface.
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
    </div>
  );
}
