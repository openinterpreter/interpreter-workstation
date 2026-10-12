import { useEffect, useState } from 'react';
import { theme as themeIpc } from '@/ipc';

export type SimpleTheme = 'light' | 'dark' | 'system';
const THEMES: readonly SimpleTheme[] = ['light', 'dark', 'system'];

/** Shares the persisted theme with Advanced, while keeping Simple controls compact. */
export function SimpleThemeSettings() {
  const [selected, setSelected] = useState<SimpleTheme>('system');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void themeIpc.get().then(({ theme }: { theme: SimpleTheme }) => {
      if (mounted) setSelected(theme);
    }).catch(() => {
      if (mounted) setError('Could not load appearance.');
    });
    const unsubscribe = themeIpc.onChanged(({ theme }: { theme: SimpleTheme }) => setSelected(theme));
    return () => { mounted = false; unsubscribe(); };
  }, []);

  const change = async (theme: SimpleTheme) => {
    if (busy || theme === selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await themeIpc.set(theme);
      if (!result.success) throw new Error(result.error || 'Could not save appearance.');
      setSelected(theme);
    } catch {
      setError('Could not save appearance. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="simple-appearance-heading" className="mb-7">
      <h2 id="simple-appearance-heading" className="text-ui-sm font-medium text-foreground">Appearance</h2>
      <p className="mt-1 text-ui-sm text-muted-foreground">System follows your computer’s light or dark setting.</p>
      <div className="mt-3 inline-flex max-w-full gap-1 rounded-2xl border border-foreground/[0.1] bg-foreground/[0.025] p-1" role="radiogroup" aria-label="Appearance">
        {THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={selected === theme}
            disabled={busy}
            onClick={() => void change(theme)}
            className={`min-w-[72px] rounded-xl px-3 py-2 text-ui-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50 ${selected === theme ? 'bg-foreground text-background shadow-sm' : 'text-foreground hover:bg-foreground/[0.06]'}`}
          >{theme[0].toUpperCase() + theme.slice(1)}</button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-ui-sm text-destructive">{error}</p>}
    </section>
  );
}
