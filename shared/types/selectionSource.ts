export const SELECTION_SOURCE_KINDS = [
  'app-ui-selection',
  'os-selected-text',
  'os-selected-children',
  'os-focused-element',
  'os-selection-unknown',
  'os-selected-file',
  'overlay-region',
  'browser-selection',
  'office-selection',
] as const;

export type SelectionSourceKind = typeof SELECTION_SOURCE_KINDS[number];

export type OsTextSelectionSourceKind = Extract<
  SelectionSourceKind,
  'os-selected-text' | 'os-selected-children' | 'os-focused-element' | 'os-selection-unknown'
>;

export type OsFileSelectionSourceKind = Extract<SelectionSourceKind, 'os-selected-file'>;
