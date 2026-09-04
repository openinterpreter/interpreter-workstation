export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_ORDER: ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const GENERIC_REASONING_EFFORTS: ReasoningEffort[] = [
  'low',
  'medium',
  'high',
];

export const GENERIC_REASONING_DEFAULT_EFFORT: ReasoningEffort = 'medium';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_ORDER.includes(value as ReasoningEffort);
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case 'none':
      return 'None';
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra high';
    case 'max':
      return 'Max';
  }
}
