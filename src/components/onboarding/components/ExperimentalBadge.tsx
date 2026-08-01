/**
 * ExperimentalBadge
 *
 * Small "Experimental" tag component used to mark features
 * that are in experimental/beta state during onboarding.
 */

import { useTranslation } from 'react-i18next';

interface ExperimentalBadgeProps {
  /** Optional custom label (defaults to "Experimental") */
  label?: string;
}

export function ExperimentalBadge({ label }: ExperimentalBadgeProps) {
  const { t } = useTranslation();
  const displayLabel = label ?? t('onboarding.common.experimental');
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
      style={{
        border: 'var(--border-width) solid var(--border)',
        backgroundColor: 'color-mix(in oklch, var(--muted) 32%, transparent)',
      }}
    >
      {displayLabel}
    </span>
  );
}
