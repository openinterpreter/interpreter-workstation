import { type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

type OnboardingShellSize = 'narrow' | 'form' | 'medium' | 'wide';
type OnboardingShellAlign = 'center' | 'top';
type OnboardingSectionTone = 'plain' | 'default' | 'muted' | 'dashed';
type OnboardingSectionPadding = 'sm' | 'md' | 'lg';

const SHELL_WIDTHS: Record<OnboardingShellSize, string> = {
  narrow: 'max-w-[400px]',
  form: 'max-w-[520px]',
  medium: 'max-w-[760px]',
  wide: 'max-w-[920px]',
};

const SECTION_STYLES: Record<OnboardingSectionTone, CSSProperties> = {
  plain: {
    border: 'none',
    backgroundColor: 'transparent',
    boxShadow: 'none',
  },
  default: {
    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 58%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 95%, var(--oa-bg-subtle, var(--muted)) 5%)',
    boxShadow: '0 12px 36px -28px var(--shadow-color)',
  },
  muted: {
    border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 52%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 92%, var(--oa-bg-subtle, var(--muted)) 8%)',
    boxShadow: 'none',
  },
  dashed: {
    border: 'var(--border-width) dashed var(--oa-border)',
    backgroundColor: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 92%, var(--oa-bg-subtle, var(--muted)) 8%)',
    boxShadow: 'none',
  },
};

const SECTION_PADDING: Record<OnboardingSectionPadding, string> = {
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

interface OnboardingScreenShellProps {
  children: ReactNode;
  size?: OnboardingShellSize;
  align?: OnboardingShellAlign;
  className?: string;
  contentClassName?: string;
}

interface OnboardingHeadingProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  align?: 'center' | 'left';
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}

interface OnboardingSectionProps extends HTMLAttributes<HTMLDivElement> {
  tone?: OnboardingSectionTone;
  padding?: OnboardingSectionPadding;
}

export function OnboardingScreenShell({
  children,
  size = 'form',
  align = 'center',
  className,
  contentClassName,
}: OnboardingScreenShellProps) {
  return (
    <div
      className={cn(
        'flex min-h-full w-full justify-center px-5 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10',
        align === 'center' ? 'items-center' : 'items-start',
        className,
      )}
    >
      <div className={cn('w-full', SHELL_WIDTHS[size], contentClassName)}>
        {children}
      </div>
    </div>
  );
}

export function OnboardingHeading({
  title,
  description,
  eyebrow,
  align = 'center',
  className,
  titleClassName,
  descriptionClassName,
}: OnboardingHeadingProps) {
  return (
    <div className={cn('space-y-3', align === 'center' ? 'text-center' : 'text-left', className)}>
      {eyebrow && (
        <p
          className={cn(
            'text-[11px] font-semibold uppercase tracking-[0.18em]',
            align === 'center' ? 'justify-center' : 'justify-start',
          )}
          style={{ color: 'var(--oa-text-faint)' }}
        >
          {eyebrow}
        </p>
      )}
      <h1
        className={cn(
          'text-balance text-[20px] font-medium leading-[1.15] tracking-[-0.02em] text-[var(--oa-text-strong)] sm:text-[22px]',
          titleClassName,
        )}
      >
        {title}
      </h1>
      {description && (
        <p
          className={cn(
            'text-pretty text-ui-sm leading-6 text-[var(--oa-text-muted)]',
            align === 'center' ? 'mx-auto max-w-[32rem]' : 'max-w-[34rem]',
            descriptionClassName,
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}

export function OnboardingSection({
  tone = 'default',
  padding = 'md',
  className,
  style,
  children,
  ...props
}: OnboardingSectionProps) {
  return (
    <div
      className={cn('rounded-[18px]', SECTION_PADDING[padding], className)}
      style={{ ...SECTION_STYLES[tone], ...style }}
      {...props}
    >
      {children}
    </div>
  );
}
