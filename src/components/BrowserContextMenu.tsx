/**
 * BrowserContextMenu
 *
 * Browser-mode context menu that listens for 'show-context-menu' events
 * and renders a context menu at the cursor position.
 *
 * This replaces Electron's native context menus when running in browser dev mode.
 * It receives menu items directly from the showContextMenu API and renders them.
 */

import { useState, useEffect, useCallback } from 'react';
import { ContextMenu } from './ContextMenu';
import {
  isBrowserDevMode,
  resolveContextMenu,
  type ContextMenuItem as IpcContextMenuItem,
} from '@/ipc';

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  items: IpcContextMenuItem[];
}

interface RenderedMenuItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
}

function formatAccelerator(accelerator: string): string {
  const isMac = navigator.platform.toUpperCase().includes('MAC');

  if (!isMac) {
    return accelerator.replace(/CmdOrCtrl/g, 'Ctrl');
  }

  return accelerator
    .replace(/CmdOrCtrl/g, '⌘')
    .replace(/Ctrl/g, '⌃')
    .replace(/Shift/g, '⇧')
    .replace(/Alt|Option/g, '⌥')
    .replace(/\+/g, '');
}

export function BrowserContextMenu() {
  const [menuState, setMenuState] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    items: [],
  });

  // Track cursor position for menu placement
  const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });

  // Track cursor position on mouse move
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setCursorPosition({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener('mousemove', handleMouseMove);
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // Listen for show-context-menu events from ipc.ts
  useEffect(() => {
    const handleShowContextMenu = (e: Event) => {
      const customEvent = e as CustomEvent<{
        items: IpcContextMenuItem[];
      }>;

      setMenuState({
        isOpen: true,
        x: cursorPosition.x,
        y: cursorPosition.y,
        items: customEvent.detail.items,
      });
    };

    window.addEventListener('show-context-menu', handleShowContextMenu);
    return () => window.removeEventListener('show-context-menu', handleShowContextMenu);
  }, [cursorPosition]);

  const handleClose = useCallback(() => {
    setMenuState((prev) => ({ ...prev, isOpen: false }));
    // Notify IPC layer that menu was dismissed without selection
    resolveContextMenu(null);
  }, []);

  // Convert IPC menu items to rendered menu items
  const buildMenuItems = useCallback((): RenderedMenuItem[] => {
    const flattenItems = (
      items: IpcContextMenuItem[],
      parentLabels: string[] = []
    ): RenderedMenuItem[] => {
      return items.flatMap((item) => {
        if (item.separator) {
          return [{
            label: '',
            onClick: () => {},
            separator: true,
          }];
        }

        if (item.submenu && item.submenu.length > 0) {
          return flattenItems(item.submenu, [...parentLabels, item.label]);
        }

        const fullLabel = parentLabels.length > 0
          ? `${parentLabels.join(' > ')} > ${item.label}`
          : item.label;

        return [{
          label: fullLabel,
          shortcut: item.accelerator ? formatAccelerator(item.accelerator) : undefined,
          disabled: item.disabled,
          onClick: () => {
            setMenuState((prev) => ({ ...prev, isOpen: false }));
            resolveContextMenu(item.action);
          },
        }];
      });
    };

    return flattenItems(menuState.items);
  }, [menuState.items]);

  // Don't render if in Electron mode (unless test flag is set)
  const shouldRender = isBrowserDevMode() || (window as any).__TEST_USE_HTML_CONTEXT_MENU;
  if (!shouldRender) {
    return null;
  }

  if (!menuState.isOpen) {
    return null;
  }

  const items = buildMenuItems();
  const hasActionableItem = items.some((item) => !item.separator);
  if (!hasActionableItem) {
    return null;
  }

  return (
    <ContextMenu
      x={menuState.x}
      y={menuState.y}
      items={items}
      onClose={handleClose}
    />
  );
}
