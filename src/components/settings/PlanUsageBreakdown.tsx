import type { ReactNode } from 'react';

interface UsageBreakdownRowProps {
  label: string;
  percentage: number;
  summary: string;
  detail?: string;
  accentColor?: string;
  icon?: ReactNode;
  showBar?: boolean;
}

export function clampUsagePercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

export function UsageBreakdownRow({
  label,
  percentage,
  summary,
  detail,
  accentColor = 'var(--brand-accent)',
  icon,
  showBar = true,
}: UsageBreakdownRowProps) {
  const clampedPercentage = clampUsagePercentage(percentage);
  const marker = icon ? (
    <div className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      {icon}
    </div>
  ) : (
    <span
      aria-hidden="true"
      className="mt-[7px] size-1.5 shrink-0 rounded-full"
      style={{ background: accentColor }}
    />
  );
  const labelContent = (
    <div className="flex min-w-0 items-start gap-2">
      {marker}
      <div className="min-w-0">
        <div className="truncate text-ui-sm font-medium leading-5 text-foreground">
          {label}
        </div>
        {detail ? (
          <div className="mt-1 text-ui-xs leading-5 text-muted-foreground">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );

  return showBar ? (
    <div className="flex items-center gap-4">
      <div className="min-w-0 max-w-[45%] shrink-0">
        {labelContent}
      </div>
      <div
        className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full"
        style={{
          background:
            'color-mix(in srgb, var(--oa-border, var(--border)) 28%, transparent)',
        }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${clampedPercentage}%`,
            background: accentColor,
          }}
        />
      </div>
      <div className="shrink-0 text-ui-xs leading-5 tabular-nums text-muted-foreground">
        {summary}
      </div>
    </div>
  ) : (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {labelContent}
        </div>

        <div className="shrink-0 pt-px text-ui-xs leading-5 tabular-nums text-muted-foreground">
          {summary}
        </div>
      </div>
    </div>
  );
}

interface PlanUsageBreakdownCardProps {
  title: string;
  toggleLabel: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function PlanUsageBreakdownCard({
  title,
  toggleLabel,
  expanded,
  onToggle,
  children,
}: PlanUsageBreakdownCardProps) {
  return (
    <div
      className="w-full space-y-4 rounded-[14px] px-4 py-4"
      style={{
        background:
          'color-mix(in srgb, var(--oa-bg-app, var(--background)) 84%, var(--oa-bg-subtle, var(--muted)) 16%)',
        border:
          'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 64%, transparent)',
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-ui-sm font-medium leading-6 text-foreground">
          {title}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          className="shrink-0 text-ui-xs leading-5 text-muted-foreground transition-colors hover:text-foreground"
          onClick={onToggle}
        >
          {toggleLabel}
        </button>
      </div>

      {children}
    </div>
  );
}
