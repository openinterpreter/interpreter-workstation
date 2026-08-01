import { cn } from '@/lib/utils';

interface ProgressBarProps {
  activeIndex: number;
  total: number;
  className?: string;
}

const INACTIVE_DOT_CLASS = 'h-2 w-2 opacity-80';
const ACTIVE_DOT_CLASS = 'h-2 w-9 opacity-100';

export function ProgressBar({ activeIndex, total, className }: ProgressBarProps) {
  const safeTotal = Math.max(0, total);
  const clampedActiveIndex = safeTotal === 0
    ? 0
    : Math.min(Math.max(activeIndex, 0), safeTotal - 1);

  return (
    <div className={cn('flex items-center justify-center gap-2', className)} aria-hidden="true">
      {Array.from({ length: safeTotal }, (_, index) => {
        const isActive = index === clampedActiveIndex;
        return (
          <div
            key={index}
            className={cn(
              'rounded-full transition-[width,background-color,opacity] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              isActive ? ACTIVE_DOT_CLASS : INACTIVE_DOT_CLASS,
            )}
            style={{
              backgroundColor: isActive
                ? 'color-mix(in oklch, var(--oa-text-strong) 22%, transparent)'
                : 'color-mix(in oklch, var(--oa-border) 55%, transparent)',
            }}
          />
        );
      })}
    </div>
  );
}
