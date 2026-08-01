/**
 * NativeSelect
 *
 * A select component that uses native Electron menus in Electron mode
 * and falls back to a browser-based dropdown in browser mode.
 *
 * This follows the unified abstraction pattern from AGENTS.md:
 * - Components define WHAT options to show
 * - The system handles HOW to render (native vs shadcn)
 */

import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { showSelect, type SelectItem } from '@/ipc';
import { usePressState } from './usePressState';

export interface NativeSelectProps {
  /** Currently selected value */
  value?: string;
  /** Callback when value changes */
  onValueChange?: (value: string) => void;
  /** The available options */
  items: SelectItem[];
  /** Placeholder text when no value is selected */
  placeholder?: string;
  /** Additional class names for the trigger */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'default';
  /** Whether the select is disabled */
  disabled?: boolean;
  /** Test ID for the element */
  'data-testid'?: string;
}

export function NativeSelect({
  value,
  onValueChange,
  items,
  placeholder = 'Select...',
  className,
  size = 'default',
  disabled = false,
  'data-testid': testId,
}: NativeSelectProps) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const { pressed, pressProps } = usePressState<HTMLButtonElement>(disabled);

  // Find the label for the current value
  const selectedItem = items.find((item) => item.value === value);
  const displayText = selectedItem?.label ?? placeholder;

  const handleClick = async () => {
    if (disabled || !triggerRef.current) return;

    // Get the position of the trigger button
    const rect = triggerRef.current.getBoundingClientRect();
    const x = rect.left;
    const y = rect.bottom + 4; // Small gap below the trigger

    const selectedValue = await showSelect(items, value, x, y);

    if (selectedValue !== null && onValueChange) {
      onValueChange(selectedValue);
    }
  };

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={handleClick}
      disabled={disabled}
      data-slot="native-select-trigger"
      data-size={size}
      data-pressed={pressed ? 'true' : undefined}
      data-testid={testId}
      onPointerDown={pressProps.onPointerDown}
      onPointerUp={pressProps.onPointerUp}
      onPointerLeave={pressProps.onPointerLeave}
      onPointerCancel={pressProps.onPointerCancel}
      onKeyDown={pressProps.onKeyDown}
      onKeyUp={pressProps.onKeyUp}
      onBlur={pressProps.onBlur}
      className={cn(
        'border-input data-[placeholder]:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/50 gap-1.5 rounded-control border bg-transparent py-2 pr-2 pl-2.5 text-ui-sm select-none focus-visible:ring-1 data-[size=default]:h-8 data-[size=sm]:h-7 flex w-fit items-center justify-between whitespace-nowrap outline-none transition-transform duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] transform-gpu data-[pressed=true]:scale-[0.965] motion-reduce:transform-none motion-reduce:duration-0 disabled:cursor-not-allowed disabled:opacity-50',
        !selectedItem && 'text-muted-foreground',
        className
      )}
    >
      <span className="line-clamp-1">{displayText}</span>
      <ChevronDownIcon className="text-muted-foreground size-4 pointer-events-none" />
    </button>
  );
}
