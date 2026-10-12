import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { topNotices } from '@/ipc';

const NOTICE_ID = 'simple-whats-new';

export function SimpleWhatsNew({ firstRunSession, onVisibilityChange }: {
  firstRunSession: boolean;
  onVisibilityChange: (visible: boolean) => void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    if (firstRunSession) {
      // Fresh users have just seen onboarding. Record the version so this
      // announcement does not reappear on their next launch.
      void topNotices.dismiss(NOTICE_ID).catch(() => {});
      return () => { mounted = false; };
    }
    void topNotices.list().then((result: { notices: Array<{ id: string; version: string }> }) => {
      if (mounted) setVersion(result.notices.find((notice) => notice.id === NOTICE_ID)?.version ?? null);
    }).catch(() => { if (mounted) setError('Could not load the update note.'); });
    return () => { mounted = false; };
  }, [firstRunSession]);

  useEffect(() => onVisibilityChange(!!version), [onVisibilityChange, version]);
  if (!version) return error ? <p role="status" className="px-4 text-ui-xs text-muted-foreground">{error}</p> : null;

  const dismiss = async () => {
    try {
      await topNotices.dismiss(NOTICE_ID);
      setError(null);
      setVersion(null);
    } catch {
      setError('Could not save this change. Try again.');
    }
  };

  return (
    <section aria-label="What's New" className="shrink-0 border-t border-foreground/[0.08] px-5 py-4 text-ui-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-foreground">What’s New</h2>
        <button type="button" onClick={() => void dismiss()} aria-label="Dismiss What's New"
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-1 leading-5 text-muted-foreground">
        Simple mode opens by default. Ask for an interface and edit the ordinary project files in its own folder.
      </p>
      <p className="mt-2 leading-5 text-muted-foreground">
        Expand the attached drawer for conversation, activity, and approvals. Settings keeps appearance, models, the control workspace, and optional WhatsApp pairing close at hand. Feedback stays beside the pill and in the Help menu. Switch to Advanced from Settings whenever you need its other tools.
      </p>
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    </section>
  );
}
