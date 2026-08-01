// Geometry Types
export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RelativeBBox {
  x_min: number;  // [0..1] normalized left edge
  y_min: number;  // [0..1] normalized top edge
  x_max: number;  // [0..1] normalized right edge
  y_max: number;  // [0..1] normalized bottom edge
}

export interface DisplayInfo {
  id: string;                         // Platform-specific display identifier
  scaleFactor: number;                // Device pixel ratio (e.g., 2.0 for Retina)
  boundsDIP: {                        // Display bounds in DIP (density-independent pixels)
    x: number;                        // Top-left X coordinate
    y: number;                        // Top-left Y coordinate
    width: number;                    // Display width in DIP
    height: number;                   // Display height in DIP
  };
}

// Tool Parameter Types
export type ClickParams = {
  element_id?: string;
  element_description?: string;
  x?: number; // Vision mode: screenshot pixel X; AX mode: [0..1] normalized X inside the active viewport
  y?: number; // Vision mode: screenshot pixel Y; AX mode: [0..1] normalized Y inside the active viewport
};

export type TypeParams = {
  element_id?: string;
  element_description?: string;
  text: string;
  clear_first?: boolean;
};

export type HotkeyParams = {
  hotkey: string;
};

export type ScrollParams = {
  element_id?: string;
  element_description?: string;
  x?: number; // Vision mode: screenshot pixel X; AX mode: [0..1] normalized X inside the active viewport
  y?: number; // Vision mode: screenshot pixel Y; AX mode: [0..1] normalized Y inside the active viewport
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number; // OS-dependent wheel steps; defaults to 5
};

export type ScreenshotParams = {
  query?: string;
  text_only?: boolean; // If true (default), refresh accessibility-tree text. If false, use the vision model.
  region_id?: string;
};

export type ToolName = 'click' | 'type' | 'hotkey' | 'scroll' | 'screenshot';

// Action and Run Types
export interface Action {
  id: string;
  seq: number;
  tool: ToolName;
  params: ClickParams | TypeParams | HotkeyParams | ScrollParams | ScreenshotParams;
  previewBatchId?: string;
  dispatched?: boolean;
  bbox?: RelativeBBox;
  resolvedLabel?: string;
  centerColor?: string;  // Hex color sampled from center of bbox (for ghost styling)
  currentValue?: string;
  visionAnchorPx?: Point;
  decision?: 'approved' | 'rejected' | 'system_cancelled';
  executedAt?: number;
  error?: string;
}

export interface Run {
  id: string;
  startedAt: number;
  monitorId: string;
  actions: Action[];
  conversationId: string;
  currentScreenshotId: string;
  toolCallCount: number;
}

// UIState and PillMode Types
export type PillMode =
  | { kind: 'hidden' }
  | { kind: 'recording' }
  | { kind: 'loading'; label?: string }
  | { kind: 'review'; hotkeyLabel?: string }
  // Display-only completion text: the controller model's final plain-text
  // decision when nothing visible happened on screen (e.g. dead target).
  | { kind: 'message'; message: string }
  | { kind: 'error'; message: string };

export interface UIState {
  pill: PillMode;
  active: Action | null;
  ghosts: Action[];
  ctrlPressed: boolean; // Track if ctrl key is currently being held down
  shiftPressed: boolean; // Track if shift key is currently being held down
  executing: boolean; // True during automation execution - overlay must be click-through
}
