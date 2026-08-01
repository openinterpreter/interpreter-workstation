import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared shell for editor/viewer components.
 *
 * Owns the unified content-surface background color (`--oa-surface-center`),
 * the same color used by the top tab strip and the new-tab page. The shell
 * has no internal borders — the toolbar and content read as one surface.
 *
 * Compose as:
 *   <EditorShell>
 *     <EditorToolbar>...</EditorToolbar>
 *     <EditorContentSurface>...</EditorContentSurface>
 *   </EditorShell>
 */
export function EditorShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col h-full bg-[var(--oa-surface-center)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Standard toolbar row inside an EditorShell. Inherits the shell background —
 * no own background, no border.
 */
export function EditorToolbar({
  children,
  className,
  style,
  justify = 'end',
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  justify?: 'start' | 'end' | 'between' | 'center';
}) {
  const justifyClass =
    justify === 'start'
      ? 'justify-start'
      : justify === 'between'
        ? 'justify-between'
        : justify === 'center'
          ? 'justify-center'
          : 'justify-end';
  return (
    <div
      className="voice-focus-content-toolbar overflow-x-auto overflow-y-hidden"
      style={{ height: 'var(--unit-height)', ...style }}
    >
      <div
        className={cn(
          'flex h-full w-full min-w-max items-center px-2 [&>*]:shrink-0',
          justifyClass,
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Content surface inside an EditorShell. Inherits the shell background,
 * takes remaining space, scrolls by default.
 */
export function EditorContentSurface({
  children,
  className,
  scroll = true,
}: {
  children: React.ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <div
      className={cn(
        'voice-focus-content-surface flex-1',
        scroll && 'overflow-auto',
        className,
      )}
    >
      {children}
    </div>
  );
}
