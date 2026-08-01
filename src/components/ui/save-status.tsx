import { Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SaveStatusState = 'saved' | 'unsaved' | 'saving';

interface SaveStatusProps {
  status: SaveStatusState;
}

const STATUS_LABELS: Record<SaveStatusState, string> = {
  unsaved: 'Unsaved',
  saving: 'Saving',
  saved: 'Saved',
};

/**
 * Subtle save status indicator with smooth transitions.
 * - Gray dot when unsaved
 * - Spinner while saving
 * - Checkmark when saved
 * - Shows text label on hover
 */
export function SaveStatus({ status }: SaveStatusProps) {
  return (
    <div className="group flex items-center gap-1.5">
      {/* Text labels - stacked, crossfade on status change, visible on hover */}
      <div className="relative h-4 flex items-center">
        {/* Invisible spacer using longest label to reserve width */}
        <span className="text-ui-sm invisible" aria-hidden="true">Unsaved</span>
        {/* Actual labels positioned absolutely - only current status shows on hover */}
        {(['unsaved', 'saving', 'saved'] as const).map((s) => (
          <span
            key={s}
            className={cn(
              'absolute right-0 text-ui-sm text-muted-foreground transition-opacity duration-300 ease-in-out',
              status === s ? 'opacity-0 group-hover:opacity-100' : 'opacity-0'
            )}
          >
            {STATUS_LABELS[s]}
          </span>
        ))}
      </div>
      {/* Icon container - sized to match icon-row buttons for visual alignment */}
      <div className="relative h-[var(--unit-height-small)] w-[var(--unit-height-small)] flex items-center justify-center">
        {/* Unsaved dot */}
        <div
          className={cn(
            'absolute w-2 h-2 rounded-full bg-muted-foreground/50 transition-opacity duration-300 ease-in-out',
            status === 'unsaved' ? 'opacity-100' : 'opacity-0'
          )}
        />
        {/* Saving spinner */}
        <Loader2
          className={cn(
            'absolute size-4 text-muted-foreground transition-opacity duration-300 ease-in-out',
            status === 'saving' ? 'opacity-100 animate-spin' : 'opacity-0'
          )}
        />
        {/* Saved checkmark */}
        <Check
          className={cn(
            'absolute size-4 text-muted-foreground transition-opacity duration-300 ease-in-out',
            status === 'saved' ? 'opacity-100' : 'opacity-0'
          )}
        />
      </div>
    </div>
  );
}
