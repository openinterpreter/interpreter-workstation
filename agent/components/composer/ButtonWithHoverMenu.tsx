/**
 * ButtonWithHoverMenu
 *
 * Generic circular button with a hover-triggered popover menu above it.
 * Used for send/queue menu, voice mode picker, and any future button+menu combos.
 *
 * Hover behavior: mouse enters container → delay → show menu.
 * Mouse can freely move between button and menu (same container).
 * Mouse leaves container → menu hides immediately.
 */

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export interface HoverMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  description?: ReactNode;
  helpTitle?: string;
  helpDescription?: string;
  /** Optional trailing element (e.g. checkmark) */
  trailing?: ReactNode;
  onClick: () => void;
}

export interface ButtonWithHoverMenuProps {
  /** Items to show in the hover menu */
  menuItems: HoverMenuItem[];
  /** Optional non-interactive header shown at the top of the menu */
  menuHeader?: ReactNode;
  /** Whether the hover menu is enabled (e.g. only when streaming+input) */
  menuEnabled: boolean;
  /** Delay before menu appears on hover (ms, default 300) */
  hoverDelayMs?: number;
  /** Main button icon */
  buttonIcon: ReactNode;
  /** Main button click handler */
  onButtonClick: () => void;
  /** Button disabled state */
  disabled?: boolean;
  /** data-testid for the button */
  testId?: string;
  /** Tooltip text (hidden when menu is open) */
  tooltip?: ReactNode;
  /** Help panel title for the main button */
  helpTitle?: string;
  /** Help panel description for the main button */
  helpDescription?: string;
  /** Button style overrides */
  buttonStyle?: React.CSSProperties;
  /** Extra className for the button */
  buttonClassName?: string;
  /** Optional badge element (e.g. queue indicator dot) */
  badge?: ReactNode;
}

export function ButtonWithHoverMenu({
  menuItems,
  menuHeader,
  menuEnabled,
  hoverDelayMs = 300,
  buttonIcon,
  onButtonClick,
  disabled,
  testId,
  tooltip,
  helpTitle,
  helpDescription,
  buttonStyle,
  buttonClassName,
  badge,
}: ButtonWithHoverMenuProps) {
  const [showMenu, setShowMenu] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = useReducedMotion();

  const clearTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (!menuEnabled || disabled) return;
    clearTimer();
    hoverTimerRef.current = setTimeout(() => {
      setShowMenu(true);
    }, hoverDelayMs);
  }, [menuEnabled, disabled, hoverDelayMs, clearTimer]);

  const handleMouseLeave = useCallback(() => {
    clearTimer();
    setShowMenu(false);
  }, [clearTimer]);

  const handleButtonClick = useCallback(() => {
    clearTimer();
    setShowMenu(false);
    onButtonClick();
  }, [clearTimer, onButtonClick]);

  const handleMenuItemClick = useCallback((item: HoverMenuItem) => {
    clearTimer();
    setShowMenu(false);
    item.onClick();
  }, [clearTimer]);

  // Close on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  // Close when menu becomes disabled
  useEffect(() => {
    if (!menuEnabled) {
      clearTimer();
      setShowMenu(false);
    }
  }, [menuEnabled, clearTimer]);

  return (
    <div
      className="relative"
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Hover menu — above button, pb-2 bridges the gap */}
      <AnimatePresence>
        {showMenu && menuEnabled && menuItems.length > 0 && (
          <motion.div
            className="absolute bottom-full right-0 z-50 pb-2"
            initial={reducedMotion ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
            transition={reducedMotion ? { duration: 0.1 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
          <div
            className="min-w-[188px] overflow-hidden rounded-[18px] p-1.5"
            style={{
              background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 92%, var(--oa-bg-subtle, var(--muted)) 8%)',
              border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 78%, transparent)',
              boxShadow: '0 28px 60px -34px rgba(15, 23, 42, 0.24), 0 16px 28px -18px rgba(15, 23, 42, 0.16)',
              backdropFilter: 'blur(18px) saturate(1.05)',
            }}
          >
            {menuHeader && (
              <div
                className="px-3.5 pb-2.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--oa-text-faint,var(--muted-foreground))]"
                style={{
                  borderBottom: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 56%, transparent)',
                  marginBottom: '0.35rem',
                }}
              >
                {menuHeader}
              </div>
            )}
            {menuItems.map((item) => {
              const button = (
                <button
                  key={item.key}
                  type="button"
                  data-help-title={item.helpTitle ?? item.label}
                  data-help-description={item.helpDescription}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-[12px] px-3 text-left text-[13px] text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  onClick={() => handleMenuItemClick(item)}
                >
                  {item.icon}
                  <span className="flex-1">{item.label}</span>
                  {item.trailing}
                </button>
              );

              if (!item.description) {
                return button;
              }

              return (
                <Tooltip key={item.key} delayDuration={120}>
                  <TooltipTrigger asChild>
                    {button}
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={10} className="max-w-60">
                    {item.description}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid={testId}
            disabled={disabled}
            data-help-title={helpTitle}
            data-help-description={helpDescription}
            className={buttonClassName ?? [
              'composer-send-button flex size-9 items-center justify-center rounded-full transition-colors duration-150',
              disabled && 'opacity-50',
            ].filter(Boolean).join(' ')}
            style={buttonStyle}
            onClick={handleButtonClick}
          >
            {buttonIcon}
          </button>
        </TooltipTrigger>
        {!showMenu && tooltip && <TooltipContent side="top">{tooltip}</TooltipContent>}
      </Tooltip>

      {badge}
    </div>
  );
}
