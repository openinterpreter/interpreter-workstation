/**
 * ChoiceButton
 *
 * Shared onboarding choice row with keyboard shortcut support.
 */

import { useEffect, useCallback } from 'react';

import { cn } from '@/lib/utils';
import { usePressState } from '../../ui/usePressState';

interface ChoiceButtonProps {
  /** Letter key (A, B, C, etc.) */
  letterKey: string;
  /** Main label text */
  label: string;
  /** Secondary description text */
  description?: string;
  /** Whether this choice is currently selected */
  isSelected?: boolean;
  /** Click handler */
  onClick: () => void;
  /** Whether keyboard shortcut is enabled (default: true) */
  keyboardEnabled?: boolean;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Visual treatment */
  tone?: 'default' | 'outline';
}

export function ChoiceButton({
  letterKey,
  label,
  description,
  isSelected = false,
  onClick,
  keyboardEnabled = true,
  disabled = false,
  tone = 'default',
}: ChoiceButtonProps) {
  const { pressed, pressProps } = usePressState<HTMLButtonElement>(disabled);
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!keyboardEnabled || disabled) return;

    // Match the letter key (case-insensitive)
    if (e.key.toLowerCase() === letterKey.toLowerCase()) {
      e.preventDefault();
      onClick();
    }
  }, [keyboardEnabled, disabled, letterKey, onClick]);

  useEffect(() => {
    if (!keyboardEnabled || disabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [keyboardEnabled, disabled, handleKeyDown]);

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-pressed={pressed ? 'true' : undefined}
      onPointerDown={pressProps.onPointerDown}
      onPointerUp={pressProps.onPointerUp}
      onPointerLeave={pressProps.onPointerLeave}
      onPointerCancel={pressProps.onPointerCancel}
      onKeyDown={pressProps.onKeyDown}
      onKeyUp={pressProps.onKeyUp}
      onBlur={pressProps.onBlur}
      className={cn(
        'flex w-full items-start gap-3 rounded-[12px] border-solid px-4 py-3.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] transform-gpu data-[pressed=true]:scale-[0.985] [border-width:var(--border-width)] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none motion-reduce:duration-0',
        tone === 'outline'
          ? (isSelected
            ? 'border-[color-mix(in_oklch,var(--oa-text-strong)_22%,var(--oa-border)_78%)] bg-[color-mix(in_oklch,var(--oa-bg-input)_74%,var(--oa-bg-subtle)_26%)] shadow-[0_12px_28px_-24px_var(--shadow-color)]'
            : 'border-[color-mix(in_oklch,var(--oa-border)_86%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-input)_90%,var(--oa-bg-app)_10%)] shadow-[0_8px_24px_-26px_var(--shadow-color)] hover:border-[var(--oa-border-strong)] hover:bg-[var(--oa-bg-hover)]')
          : (isSelected
            ? 'border-[color-mix(in_oklch,var(--oa-text-strong)_18%,var(--oa-border)_82%)] bg-[color-mix(in_oklch,var(--oa-bg-subtle)_54%,transparent)] shadow-[0_10px_24px_-22px_var(--shadow-color)]'
            : 'border-[color-mix(in_oklch,var(--oa-border)_58%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-app)_95%,var(--oa-bg-subtle)_5%)]'),
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex min-w-[16px] shrink-0 items-center justify-center text-[11px] font-medium uppercase tracking-[0.08em] transition-colors duration-150',
          tone === 'outline' && 'rounded-full border-solid px-1.5 py-0.5 [border-width:var(--border-width)]',
          tone === 'outline'
            ? (isSelected
              ? 'border-[color-mix(in_oklch,var(--oa-text-strong)_18%,var(--oa-border)_82%)] bg-[color-mix(in_oklch,var(--oa-bg-subtle)_52%,transparent)] text-[var(--oa-text-strong)]'
              : 'border-[color-mix(in_oklch,var(--oa-border)_72%,transparent)] bg-[color-mix(in_oklch,var(--oa-bg-app)_72%,var(--oa-bg-subtle)_28%)] text-[var(--oa-text-muted)]')
            : (isSelected
              ? 'text-[var(--oa-text-strong)]'
              : 'text-[var(--oa-text-muted)]'),
        )}
      >
        {letterKey}
      </div>

      <div className="min-w-0 space-y-1.5">
        <div className="text-[14px] font-medium leading-6 text-[var(--oa-text-strong)]">{label}</div>
        {description && (
          <div className="text-[13px] leading-5 text-[var(--oa-text-muted)]">{description}</div>
        )}
      </div>
    </button>
  );
}
