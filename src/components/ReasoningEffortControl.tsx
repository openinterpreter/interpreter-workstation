"use client";

import { useMemo } from 'react';
import { Slider } from './ui/slider';
import { cn } from '@/lib/utils';
import {
  reasoningEffortLabel,
  type ReasoningEffort,
} from '../../shared/types/reasoning';

interface ReasoningEffortControlProps {
  supportedEfforts: ReasoningEffort[];
  value?: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  label?: string;
  description?: string;
  className?: string;
  note?: React.ReactNode;
}

export function ReasoningEffortControl({
  supportedEfforts,
  value,
  onChange,
  label = 'Reasoning',
  className,
}: ReasoningEffortControlProps) {
  const selectedIndex = useMemo(() => {
    if (supportedEfforts.length === 0) {
      return 0;
    }
    const index = value ? supportedEfforts.indexOf(value) : -1;
    return index >= 0 ? index : 0;
  }, [supportedEfforts, value]);

  if (supportedEfforts.length <= 1) {
    return null;
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-ui-sm font-medium text-foreground">{label}</div>
        <div className="shrink-0 text-ui-xs font-medium text-muted-foreground">
          {reasoningEffortLabel(supportedEfforts[selectedIndex] ?? supportedEfforts[0]!)}
        </div>
      </div>

      <Slider
        min={0}
        max={supportedEfforts.length - 1}
        step={1}
        value={[selectedIndex]}
        onValueChange={([nextIndex]) => {
          const nextEffort = supportedEfforts[nextIndex ?? 0];
          if (nextEffort) {
            onChange(nextEffort);
          }
        }}
        aria-label={label}
      />
    </div>
  );
}
