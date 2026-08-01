import * as React from 'react';
import { cn } from '@/lib/utils';

interface EditorToolbarProps {
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared toolbar component for editors.
 * Provides consistent styling with a bottom border.
 * Use leftContent and rightContent for positioning elements.
 */
export function EditorToolbar({ children, className }: EditorToolbarProps) {
  return (
    <div
      className={cn(
        'px-2.5 flex items-center justify-between border-b border-border',
        className
      )}
      style={{ height: 'var(--unit-height)' }}
    >
      {children}
    </div>
  );
}

interface EditorToolbarGroupProps {
  children?: React.ReactNode;
  className?: string;
}

/**
 * Group for toolbar items. Use for left or right aligned groups.
 */
export function EditorToolbarGroup({ children, className }: EditorToolbarGroupProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {children}
    </div>
  );
}

interface EditorToolbarSeparatorProps {
  className?: string;
}

/**
 * Vertical separator for toolbar groups.
 */
export function EditorToolbarSeparator({ className }: EditorToolbarSeparatorProps) {
  return (
    <div className={cn('w-px h-4 bg-border', className)} />
  );
}
