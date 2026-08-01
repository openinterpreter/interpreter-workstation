interface ExpensiveModelBadgeProps {
  className?: string;
}

interface UsageRemainingBadgeProps {
  label: string;
  className?: string;
}

const EXPENSIVE_BADGE_STYLE = {
  border: 'var(--border-width) solid color-mix(in oklch, var(--oa-text-muted) 18%, var(--oa-border) 82%)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 20%, transparent)',
};

const USAGE_BADGE_STYLE = {
  border: 'var(--border-width) solid color-mix(in oklch, var(--oa-text-muted) 18%, var(--oa-border) 82%)',
  backgroundColor: 'color-mix(in oklch, var(--oa-bg-subtle) 20%, transparent)',
};

export function ExpensiveModelBadge({ className }: ExpensiveModelBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-4 text-[var(--oa-text-muted)] ${className ?? ''}`}
      style={EXPENSIVE_BADGE_STYLE}
    >
      Expensive
    </span>
  );
}

export function UsageRemainingBadge({ label, className }: UsageRemainingBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-4 text-[var(--oa-text-muted)] ${className ?? ''}`}
      style={USAGE_BADGE_STYLE}
    >
      {label}
    </span>
  );
}
