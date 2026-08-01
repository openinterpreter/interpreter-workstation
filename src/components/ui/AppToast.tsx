import { useEffect } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { openFeedbackPopover } from '../../utils/feedback';
import type { ToastAction } from '../../contexts/ToastContext';

export type ToastVariant = 'info' | 'error' | 'success';

interface AppToastProps {
  message: string;
  variant: ToastVariant;
  onDismiss: () => void;
  autoDismissMs?: number;
  actions?: ToastAction[];
}

const MAX_ERROR_LENGTH = 120;

export function AppToast({ message, variant, onDismiss, autoDismissMs, actions }: AppToastProps) {
  useEffect(() => {
    if (autoDismissMs && autoDismissMs > 0) {
      const timer = setTimeout(onDismiss, autoDismissMs);
      return () => clearTimeout(timer);
    }
  }, [autoDismissMs, onDismiss]);

  const isSuccess = variant === 'success';
  const isError = variant === 'error';

  const displayMessage = isError && message.length > MAX_ERROR_LENGTH
    ? message.slice(0, MAX_ERROR_LENGTH) + '...'
    : message;

  return (
    <div
      className={`
        pointer-events-auto
        w-full max-w-[20rem] transition-all duration-300 ease-out
        animate-in fade-in slide-in-from-bottom-2
        opacity-100 translate-y-0
      `}
    >
      <div
        className="w-full overflow-hidden rounded-[14px]"
        style={{
          border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
          background: 'color-mix(in srgb, var(--oa-surface-center, var(--popover)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)',
          boxShadow: 'var(--oa-shadow-sm)',
          backdropFilter: 'blur(14px)',
        }}
      >
        <div className="flex items-start gap-3 px-3.5 py-3">
          <div
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full"
            style={{
              background: isError
                ? 'color-mix(in srgb, var(--oa-danger) 12%, transparent)'
                : 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 78%, transparent)',
            }}
          >
            {isSuccess ? (
              <Check className="size-3 text-[var(--oa-text-muted)]" />
            ) : isError ? (
              <CircleAlert className="size-3 text-[var(--oa-danger)]" />
            ) : (
              <div className="size-3 animate-spin rounded-full border-[1.5px] border-[var(--oa-text-faint)]/70 border-t-transparent" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <span className={`cursor-text select-text text-ui-sm leading-5 ${isError ? 'text-status-error' : 'text-[var(--oa-text)]'}`}>
              {displayMessage}
            </span>
            {actions && actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => {
                      action.onClick();
                      onDismiss();
                    }}
                    className="rounded-full border px-2.5 py-1 text-ui-xs text-[var(--oa-text)] transition-colors hover:bg-[var(--oa-bg-subtle,var(--muted))]"
                    style={{ border: 'var(--border-width) solid var(--border)' }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {isError && (
              <button
                onClick={() => openFeedbackPopover()}
                className="mt-1 block text-ui-xs text-[var(--oa-text-muted)] transition-colors hover:text-[var(--oa-text-strong)]"
              >
                Report bug
              </button>
            )}
          </div>

          <button
            onClick={onDismiss}
            className="ml-auto shrink-0 text-[var(--oa-text-faint)] transition-colors hover:text-[var(--oa-text-strong)]"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
