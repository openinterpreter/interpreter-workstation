import { useState } from 'react';

interface SimpleFeedbackSettingsProps {
  visible: boolean;
  onVisibilityChange: (visible: boolean) => Promise<void>;
  onLeaveFeedback: () => void;
}

/** An accessible path to feedback even when the floating control is hidden. */
export function SimpleFeedbackSettings({
  visible,
  onVisibilityChange,
  onLeaveFeedback,
}: SimpleFeedbackSettingsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onVisibilityChange(!visible);
    } catch {
      setError('Could not save the Feedback button setting. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="simple-feedback-heading" className="mt-7 border-t border-foreground/[0.08] pt-5">
      <h2 id="simple-feedback-heading" className="text-ui-sm font-medium text-foreground">Feedback</h2>
      <p className="mt-1 text-ui-sm leading-5 text-muted-foreground">
        Keep Feedback beside the composer, or open it here whenever you need it.
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span id="simple-feedback-toggle-label" className="text-ui-sm text-foreground">Show Feedback button</span>
        <button
          type="button"
          role="switch"
          aria-labelledby="simple-feedback-toggle-label"
          aria-checked={visible}
          disabled={busy}
          onClick={() => void toggle()}
          className="relative h-7 w-12 shrink-0 rounded-full border border-foreground/[0.14] bg-foreground/[0.08] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-50"
          style={visible ? { backgroundColor: 'color-mix(in srgb, var(--foreground) 24%, transparent)' } : undefined}
        >
          <span aria-hidden="true" className={`absolute top-1 size-[18px] rounded-full bg-foreground shadow-sm transition-[left] ${visible ? 'left-[25px]' : 'left-1'}`} />
        </button>
      </div>
      <button
        type="button"
        onClick={onLeaveFeedback}
        className="mt-3 rounded-full px-3 py-1.5 text-ui-sm font-medium text-foreground transition-[background-color,scale] hover:bg-foreground/[0.06] active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        style={{ border: 'var(--border-width) solid var(--border)' }}
      >
        Leave Feedback
      </button>
      {error && <p role="alert" className="mt-2 text-ui-sm text-destructive">{error}</p>}
    </section>
  );
}
