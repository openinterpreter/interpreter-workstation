/**
 * ProviderCard
 *
 * Reusable onboarding provider card aligned with the calmer OpenAI-style
 * onboarding system.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { usePressState } from '../../ui/usePressState';

interface ProviderCardProps {
  /** Icon/logo element rendered at the top of the card */
  icon: React.ReactNode;
  /** Provider display name */
  title: string;
  /** Short description of the provider */
  description: string;
  /** Whether this provider is currently authenticated/connected */
  isConnected?: boolean;
  /** Status text shown when connected (e.g. "Signed in as user@email.com") */
  connectedText?: string;
  /** Whether authentication is in progress */
  isLoading?: boolean;
  /** Loading status text */
  loadingText?: string;
  /** Action area content (buttons, forms, etc.) rendered at the bottom */
  children?: React.ReactNode;
  /** Optional badge text (e.g. "Detected") */
  badge?: string;
  /** Whether to use a compact layout (for conditional providers) */
  compact?: boolean;
  /** Optional click handler for the entire card */
  onClick?: () => void;
}

export function ProviderCard({
  icon,
  title,
  description,
  isConnected,
  connectedText,
  isLoading,
  loadingText,
  children,
  badge,
  compact,
  onClick,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const { pressed, pressProps } = usePressState<HTMLDivElement>(!onClick);
  const cardContent = (
    <>
      {/* Icon area */}
      <div className={compact ? 'flex items-center gap-3' : 'flex flex-col items-center text-center'}>
        <div className={compact ? 'shrink-0' : 'mb-5 flex min-h-[72px] items-center justify-center'}>
          {icon}
        </div>
        <div className={compact ? 'flex-1 min-w-0' : 'text-center'}>
          <div className={`flex items-center gap-2 ${compact ? 'justify-start' : 'justify-center'}`}>
            <div className={`font-medium text-foreground ${compact ? 'text-[15px]' : 'text-lg'} ${compact ? 'text-left' : 'text-center'}`}>
              {title}
            </div>
            {badge && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground" style={{ borderColor: 'var(--border)' }}>
                {badge}
              </span>
            )}
            {isConnected && (
              <Check className="size-4 shrink-0 text-emerald-500" />
            )}
          </div>
          <p className={`text-[13px] leading-5 text-muted-foreground ${compact ? 'mt-1 text-left' : 'mt-2 mb-4 text-center'}`}>
            {description}
          </p>
        </div>
      </div>

      {/* Action area */}
      <div className={compact ? 'mt-3' : 'mt-auto w-full'}>
        {isConnected && connectedText ? (
          <p className="max-w-full truncate text-center text-[13px] text-muted-foreground">
            {connectedText}
          </p>
        ) : isLoading ? (
          <p className="text-center text-[13px] text-muted-foreground">
            {loadingText || t('onboarding.common.authenticating')}
          </p>
        ) : (
          children
        )}
      </div>
    </>
  );

  const baseClasses = `flex flex-col ${compact ? 'p-4' : 'p-6'} rounded-[20px] bg-background transition-[background-color,transform] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transform-none motion-reduce:duration-0`;
  const interactiveClasses = onClick ? 'transform-gpu data-[pressed=true]:scale-[0.985]' : '';

  return (
    <div
      data-pressed={pressed ? 'true' : undefined}
      className={`${baseClasses} ${interactiveClasses}`}
      style={{
        border: 'var(--border-width) solid var(--oa-border)',
        backgroundColor: 'color-mix(in oklch, var(--oa-bg-input) 95%, var(--oa-bg-subtle) 5%)',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
      }}
      onClick={onClick}
      onPointerDown={onClick ? pressProps.onPointerDown : undefined}
      onPointerUp={onClick ? pressProps.onPointerUp : undefined}
      onPointerLeave={onClick ? pressProps.onPointerLeave : undefined}
      onPointerCancel={onClick ? pressProps.onPointerCancel : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        pressProps.onKeyDown(e);
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      } : undefined}
      onKeyUp={onClick ? pressProps.onKeyUp : undefined}
      onBlur={onClick ? pressProps.onBlur : undefined}
    >
      {cardContent}
    </div>
  );
}
