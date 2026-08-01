import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { getTitlebarSafeInset } from '@/utils/floatingChromeInsets';

export interface ContextMenuItem {
  label: string;
  onClick?: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
  sectionLabel?: boolean;
  title?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const viewportPadding = 8;
  const safeTop = getTitlebarSafeInset();
  const [position, setPosition] = useState(() => ({
    left: x,
    top: Math.max(y, safeTop),
    transformOrigin: 'top left',
  }));

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    const maxLeft = Math.max(viewportPadding, window.innerWidth - menu.offsetWidth - viewportPadding);
    const maxTop = Math.max(safeTop, window.innerHeight - menu.offsetHeight - viewportPadding);
    const left = Math.max(viewportPadding, Math.min(x, maxLeft));
    const top = Math.max(safeTop, Math.min(y, maxTop));
    const horizontalOrigin = left < x ? 'right' : 'left';
    const verticalOrigin = top < y ? 'bottom' : 'top';

    setPosition({
      left,
      top,
      transformOrigin: `${verticalOrigin} ${horizontalOrigin}`,
    });
  }, [items, safeTop, x, y]);

  return (
    <motion.div
      ref={menuRef}
      data-testid="context-menu"
      initial={reducedMotion ? undefined : { opacity: 0, y: -12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reducedMotion
        ? { duration: 0 }
        : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="fixed z-50 min-w-48 max-w-[20rem] overflow-y-auto pointer-events-auto rounded-[14px] p-1.5 backdrop-blur-[10px]"
      style={{
        left: position.left,
        top: position.top,
        maxHeight: `calc(100dvh - ${safeTop + viewportPadding}px)`,
        transformOrigin: position.transformOrigin,
        background:
          'color-mix(in srgb, var(--oa-bg-app, var(--popover)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)',
        color: 'var(--popover-foreground)',
        border:
          'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
        boxShadow:
          '0 20px 48px -28px rgba(0, 0, 0, 0.24), 0 10px 20px -16px rgba(0, 0, 0, 0.14)',
      }}
    >
      {items.map((item, index) => (
        item.separator ? (
          <div
            key={index}
            className="my-1.5"
            style={{
              height: 'var(--border-width)',
              backgroundColor:
                'color-mix(in srgb, var(--oa-border, var(--border)) 68%, transparent)',
            }}
          />
        ) : item.title ? (
          <div
            key={index}
            className="px-3 pt-2 pb-1.5 text-ui-sm font-medium text-popover-foreground"
          >
            {item.label}
          </div>
        ) : item.sectionLabel ? (
          <div
            key={index}
            className="px-3 pt-1.5 pb-1 text-ui-xs font-medium text-muted-foreground"
          >
            {item.label}
          </div>
        ) : (
          <button
            key={index}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick?.();
              onClose();
            }}
            className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-ui-sm text-popover-foreground whitespace-nowrap transition-[background-color,color] duration-150 hover:bg-black/[0.03] dark:hover:bg-white/[0.05] disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {item.icon && <span className="size-4 flex-shrink-0">{item.icon}</span>}
            <span className="min-w-0 flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span className="shrink-0 text-ui-xs font-mono text-muted-foreground/80">{item.shortcut}</span>
            )}
          </button>
        )
      ))}
    </motion.div>
  );
}
