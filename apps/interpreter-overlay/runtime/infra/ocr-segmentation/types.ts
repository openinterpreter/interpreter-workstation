/**
 * Shared type definitions for OCR segmentation system
 */

/**
 * Bounding box in pixel coordinates
 */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Box coordinates (x1, y1, x2, y2 format)
 */
export interface BoxCoords {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * OCR word with bounding box and confidence
 */
export interface OCRWord {
  text: string;
  confidence: number;
  bbox: BBox;
  source?: string; // Which OCR pass detected this word
}

/**
 * OCR phrase (multi-word text)
 */
export interface OCRPhrase {
  text: string;
  confidence: number;
  bbox: BBox;
  words: OCRWord[];
}

/**
 * Detected UI element types
 */
export type UIElementType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'password'
  | 'number'
  | 'url'
  | 'date'
  | 'dropdown'
  | 'radio'
  | 'checkbox'
  | 'button';

/**
 * Detected UI element (base type)
 */
export interface UIElement {
  id: string;
  type: UIElementType;
  label: string;
  labelBbox: BBox;
  fieldBbox: BBox;
  combinedBbox: BBox;
  confidence: number;
}

/**
 * Text input field
 */
export interface TextField extends UIElement {
  type: 'text' | 'textarea' | 'email' | 'tel' | 'password' | 'number' | 'url' | 'date';
  placeholder?: string;
}

/**
 * Dropdown/select field
 */
export interface DropdownField extends UIElement {
  type: 'dropdown';
  placeholder?: string;
}

/**
 * Radio button (individual option within a group)
 */
export interface RadioButton extends UIElement {
  type: 'radio';
  groupLabel: string; // Label of the parent group (e.g., "Gender")
  option: string; // This specific option (e.g., "Male")
}

/**
 * Checkbox (individual option within a group)
 */
export interface Checkbox extends UIElement {
  type: 'checkbox';
  groupLabel: string; // Label of the parent group (e.g., "Interests")
  option: string; // This specific option (e.g., "Sports")
}

/**
 * Button element
 */
export interface ButtonElement extends UIElement {
  type: 'button';
}

/**
 * Text segment in a specific region
 */
export interface TextSegment {
  text: string;
  bbox: BBox;
}

/**
 * Spatial quality metrics for element groups
 */
export interface SpatialQuality {
  spacingCV: number;
  sizeCV: number;
  alignmentStdDev: number;
  isHighQuality: boolean;
}

/**
 * Detection parameters
 */
export interface DetectionParams {
  minBoxWidth: number;
  minBoxHeight: number;
  maxBoxWidth: number;
  maxBoxHeight: number;
  maxLabelDistance: number;
  labelRowClusterThreshold: number;
  maxLabelLength: number;
  highConfidenceThreshold: number;
  lowConfidenceThreshold: number;
  geometricConfidenceThreshold: number;
}
