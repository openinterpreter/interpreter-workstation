import { Command } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPrimaryModifierLabel, isMacPlatform } from '@/utils/platformShortcuts';

type ShortcutHintMode = 'always' | 'hold';

interface KeyboardShortcutHintProps {
  shortcut: string;
  isCommandHeld: boolean;
  activatedKey: string | null;
  mode?: ShortcutHintMode;
  includeCommandIcon?: boolean;
  className?: string;
  activeClassName?: string;
  inactiveClassName?: string;
  heldClassName?: string;
}

export function KeyboardShortcutHint({
  shortcut,
  isCommandHeld,
  activatedKey,
  mode = 'hold',
  includeCommandIcon = false,
  className,
  activeClassName,
  inactiveClassName,
  heldClassName,
}: KeyboardShortcutHintProps) {
  const isActive = activatedKey === shortcut.toUpperCase();
  const isVisible = mode === 'always' ? true : isCommandHeld;
  const isMac = isMacPlatform();
  const primaryModifierLabel = getPrimaryModifierLabel();

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap font-mono leading-none tracking-[-0.01em] transition-[opacity,color,transform] duration-150 ease-out',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-[1px] opacity-0',
        isActive
          ? activeClassName
          : isCommandHeld
            ? heldClassName
            : inactiveClassName,
        className,
      )}
    >
      {includeCommandIcon ? (
        <>
          {isMac ? <Command className="size-3 shrink-0" /> : <span className="shrink-0">{primaryModifierLabel}</span>}
          <span className="shrink-0">{shortcut}</span>
        </>
      ) : (
        <>
          <span className="shrink-0">{primaryModifierLabel}</span>
          <span className="ml-[0.08em] shrink-0">{shortcut}</span>
        </>
      )}
    </span>
  );
}
