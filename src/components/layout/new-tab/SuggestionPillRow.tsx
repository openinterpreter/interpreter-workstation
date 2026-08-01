/**
 * SuggestionPillRow
 *
 * Single horizontal row of pills, above the composer. Supports drill-down
 * into nested categories (Create / Analyze / Organize / Skills, etc.).
 * On hover, leaf pills dispatch a `composer:preview` event so the composer
 * can overlay the full prompt text as a preview.
 *
 * The row scrolls horizontally when it overflows, with fade masks on both
 * edges. Clicking a pill either drills in (if it has children) or invokes
 * the action (prompt / skill insert / file open / create note).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getIcon } from '../../../utils/iconMap';
import { recordCardClickActivity } from '../../../api';
import type { PillOption } from './suggestionTree';
import { SUGGESTION_PILL_ID } from '../../../../shared/element-ids';

export interface SuggestionPillRowProps {
  options: PillOption[];
  canGoBack: boolean;
  onInvoke: (option: PillOption) => void;
  onDrillIn: (option: PillOption) => void;
  onDrillOut: () => void;
  onPreview?: (option: PillOption | null) => void;
  className?: string;
}

export function SuggestionPillRow({ options, canGoBack, onInvoke, onDrillIn, onDrillOut, onPreview, className }: SuggestionPillRowProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edgeMask, setEdgeMask] = useState<'both' | 'left' | 'right' | 'none'>('none');

  useEffect(() => {
    // Reset scroll position when the visible options change so users always see the start of the row.
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
    }
  }, [options]);

  const updateEdgeMask = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const canScrollLeft = scrollLeft > 4;
    const canScrollRight = scrollLeft + clientWidth < scrollWidth - 4;
    if (canScrollLeft && canScrollRight) setEdgeMask('both');
    else if (canScrollLeft) setEdgeMask('left');
    else if (canScrollRight) setEdgeMask('right');
    else setEdgeMask('none');
  }, []);

  useEffect(() => {
    updateEdgeMask();
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => updateEdgeMask();
    el.addEventListener('scroll', handler);
    const ro = new ResizeObserver(handler);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handler);
      ro.disconnect();
    };
  }, [updateEdgeMask, options]);

  const handleClickPill = useCallback((option: PillOption) => {
    void recordCardClickActivity(option.id);
    if (option.children && option.children.length > 0) {
      onDrillIn(option);
      return;
    }
    onInvoke(option);
  }, [onInvoke, onDrillIn]);

  const handleMouseEnter = useCallback((option: PillOption) => {
    if (!option.children) {
      onPreview?.(option);
    }
  }, [onPreview]);

  const handleMouseLeave = useCallback(() => {
    onPreview?.(null);
  }, [onPreview]);

  // Tailwind's mask-image variants are flaky — do it inline so it is predictable.
  const fadeWidth = 32;
  const pillHeight = '30px';
  const pillBorderColor = 'color-mix(in srgb, var(--oa-border, var(--border)) 55%, transparent)';
  const pillBorderHoverColor = 'color-mix(in srgb, var(--oa-border, var(--border)) 85%, transparent)';
  const pillHoverBackground = 'color-mix(in srgb, var(--oa-bg-subtle, var(--hover-bg)) 60%, transparent)';

  const setPillHoverState = (button: HTMLButtonElement, hovered: boolean) => {
    button.style.backgroundColor = hovered ? pillHoverBackground : 'transparent';
    button.style.borderColor = hovered ? pillBorderHoverColor : pillBorderColor;
  };

  const pillButtonStyle: React.CSSProperties = {
    boxSizing: 'border-box',
    height: pillHeight,
    border: `var(--border-width) solid ${pillBorderColor}`,
    backgroundColor: 'transparent',
  };

  const fadeStyles: React.CSSProperties = (() => {
    if (edgeMask === 'none') return {};
    const leftFade = edgeMask === 'left' || edgeMask === 'both';
    const rightFade = edgeMask === 'right' || edgeMask === 'both';
    const mask = `linear-gradient(to right, ${leftFade ? 'transparent' : 'black'} 0, black ${fadeWidth}px, black calc(100% - ${fadeWidth}px), ${rightFade ? 'transparent' : 'black'} 100%)`;
    return { WebkitMaskImage: mask, maskImage: mask };
  })();

  return (
    <div className={`relative w-full ${className ?? ''}`}>
      <div
        ref={scrollRef}
        className="w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={fadeStyles}
      >
        {/* Inner wrapper: width fits content and uses auto horizontal margins
             so pills center when they fit, and left-align (scrollable) when they overflow. */}
        <div
          className="flex items-center gap-2 px-1 py-0.5"
          style={{ width: 'fit-content', minWidth: '100%', marginInline: 'auto', justifyContent: 'center' }}
        >
          {canGoBack && (
            <button
              type="button"
              onClick={onDrillOut}
              onMouseEnter={(e) => {
                setPillHoverState(e.currentTarget, true);
              }}
              onMouseLeave={(e) => {
                setPillHoverState(e.currentTarget, false);
              }}
              className="flex flex-shrink-0 items-center justify-center rounded-full text-[var(--oa-text-muted)] transition-[background-color,border-color,color] duration-200 ease-out hover:text-[var(--oa-text-strong)] active:scale-[0.98]"
              style={{ ...pillButtonStyle, width: pillHeight }}
              aria-label={t('common.back')}
            >
              <ChevronLeft className="size-[15px]" style={{ transform: 'translateX(-1px)' }} />
            </button>
          )}
          {options.map((option) => {
          const isMoreButton = option.id === 'cat:more';
          const Icon = getIcon(option.icon);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handleClickPill(option)}
              data-testid={SUGGESTION_PILL_ID(option.id)}
              onMouseEnter={(e) => {
                handleMouseEnter(option);
                setPillHoverState(e.currentTarget, true);
              }}
              onMouseLeave={(e) => {
                handleMouseLeave();
                setPillHoverState(e.currentTarget, false);
              }}
              className={isMoreButton
                ? 'flex flex-shrink-0 items-center justify-center rounded-full text-[var(--oa-text-muted)] transition-[background-color,border-color,color] duration-200 ease-out hover:text-[var(--oa-text-strong)] active:scale-[0.98]'
                : 'flex flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] text-[var(--oa-text)] transition-[background-color,border-color,color] duration-200 ease-out hover:text-[var(--oa-text-strong)] active:scale-[0.98]'}
              style={isMoreButton ? { ...pillButtonStyle, width: pillHeight } : pillButtonStyle}
              aria-label={isMoreButton ? option.title : undefined}
            >
              {isMoreButton ? (
                <ChevronRight className="size-[15px]" style={{ transform: 'translateX(1px)' }} />
              ) : (
                <>
                  {Icon && <Icon className="size-[15px] shrink-0 text-[var(--oa-text-muted)]" />}
                  <span className="whitespace-nowrap">{option.title}</span>
                </>
              )}
            </button>
          );
        })}
        </div>
      </div>
    </div>
  );
}
