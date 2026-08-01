export type { BBox } from './types.js';
import type { BrowserPageElementTarget, NativeCuaElementTarget } from '../../../shared/ports.js';

export interface ScreenElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  focused?: boolean;
  bbox: BBox;
  groupLabel?: string;
  option?: string;
  windowBounds?: BBox;
  nativeCua?: NativeCuaElementTarget;
  browserPage?: BrowserPageElementTarget;
}

export interface SegmentedOCRResult {
  formattedText: string;
  elements: ScreenElement[];
}

import type { BBox } from './types.js';
