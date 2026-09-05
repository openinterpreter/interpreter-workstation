import { CirclePause, CirclePlay, Flag, Pencil } from 'lucide-react';
import { cn } from '../../src/lib/utils';

type ThreadGoalSummaryProps = {
  objective: string;
  status: string;
  readOnly?: boolean;
  saving?: boolean;
  onToggleStatus?: () => void;
  onEdit?: () => void;
};

export function ThreadGoalSummary({
  objective,
  status,
  readOnly = false,
  saving = false,
  onToggleStatus,
  onEdit,
}: ThreadGoalSummaryProps) {
  const active = status === 'active';

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-[var(--oa-border)] bg-[var(--oa-bg-subtle)] px-3 py-2">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          active ? 'animate-pulse bg-emerald-500 motion-reduce:animate-none' : 'bg-[var(--oa-text-faint)]',
        )}
        aria-label={`Goal ${status}`}
      />
      <Flag className="size-3.5 shrink-0 text-[var(--oa-text-muted)]" />
      <span className="shrink-0 text-ui-xs font-medium text-[var(--oa-text-strong)]">Goal</span>
      <p className="min-w-0 flex-1 truncate text-ui-xs text-[var(--oa-text)]" title={objective}>
        {objective}
      </p>
      <span className="shrink-0 text-ui-xs capitalize text-[var(--oa-text-faint)]">
        {status.replace(/([A-Z])/g, ' $1')}
      </span>
      {!readOnly && onToggleStatus && onEdit ? (
        <>
          <button
            type="button"
            onClick={onToggleStatus}
            disabled={saving}
            className="rounded-full p-1 text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-hover)] disabled:opacity-50"
            aria-label={active ? 'Pause goal' : 'Resume goal'}
          >
            {active ? <CirclePause className="size-3.5" /> : <CirclePlay className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-full p-1 text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-hover)]"
            aria-label="Edit goal"
          >
            <Pencil className="size-3.5" />
          </button>
        </>
      ) : null}
    </div>
  );
}
