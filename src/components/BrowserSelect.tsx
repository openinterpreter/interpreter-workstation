/**
 * BrowserSelect
 *
 * Browser-mode select dropdown that listens for 'show-select' events
 * and renders a dropdown at the specified position.
 *
 * This replaces Electron's native select menus when running in browser dev mode.
 * It receives items directly from the showSelect API and renders them.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Check } from 'lucide-react';
import { isBrowserDevMode, resolveSelect, type SelectItem } from '@/ipc';

interface SelectMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  items: SelectItem[];
  currentValue?: string;
}

export function BrowserSelect() {
  const [menuState, setMenuState] = useState<SelectMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    items: [],
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setMenuState((prev) => ({ ...prev, isOpen: false }));
    // Notify IPC layer that menu was dismissed without selection
    resolveSelect(null);
  }, []);

  // Listen for show-select events from ipc.ts
  useEffect(() => {
    const handleShowSelect = (e: Event) => {
      const customEvent = e as CustomEvent<{
        items: SelectItem[];
        currentValue?: string;
        x: number;
        y: number;
      }>;

      setMenuState({
        isOpen: true,
        x: customEvent.detail.x,
        y: customEvent.detail.y,
        items: customEvent.detail.items,
        currentValue: customEvent.detail.currentValue,
      });
    };

    window.addEventListener('show-select', handleShowSelect);
    return () => window.removeEventListener('show-select', handleShowSelect);
  }, []);

  // Handle click outside and escape key
  useEffect(() => {
    if (!menuState.isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [handleClose, menuState.isOpen]);

  const handleSelect = useCallback((value: string) => {
    setMenuState((prev) => ({ ...prev, isOpen: false }));
    resolveSelect(value);
  }, []);

  // Don't render if in Electron mode
  if (!isBrowserDevMode()) {
    return null;
  }

  if (!menuState.isOpen) {
    return null;
  }

  if (menuState.items.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-36 rounded-[14px] p-1.5 backdrop-blur-[10px]"
      style={{
        left: menuState.x,
        top: menuState.y,
        border:
          'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)',
        background:
          'color-mix(in srgb, var(--oa-bg-app, var(--popover)) 96%, var(--oa-bg-subtle, var(--muted)) 4%)',
        boxShadow:
          '0 20px 48px -28px rgba(0, 0, 0, 0.24), 0 10px 20px -16px rgba(0, 0, 0, 0.14)',
      }}
    >
      {menuState.items.map((item) => (
        <button
          key={item.value}
          onClick={() => !item.disabled && handleSelect(item.value)}
          disabled={item.disabled}
          className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-ui-sm text-[var(--oa-text, var(--foreground))] transition-[background-color,color] duration-150 hover:bg-black/[0.03] dark:hover:bg-white/[0.05] disabled:opacity-50"
          style={{
            backgroundColor:
              item.value === menuState.currentValue
                ? 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 58%, transparent)'
                : 'transparent',
          }}
        >
          <span className="flex w-4 flex-shrink-0 items-center justify-center text-muted-foreground">
            {item.value === menuState.currentValue && <Check className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
