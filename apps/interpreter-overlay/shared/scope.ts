import type { Bounds, DisplayInfo, Point, RelativeBBox } from './types.js';

export const DEFAULT_SCOPE_DRAG_THRESHOLD_PX = 6;

export function normalizeDragBounds(start: Point, end: Point): Bounds {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function hasMeaningfulScope(bounds: Bounds, minSize = DEFAULT_SCOPE_DRAG_THRESHOLD_PX): boolean {
  return bounds.width >= minSize && bounds.height >= minSize;
}

export function clampBoundsToBounds(bounds: Bounds, container: Bounds): Bounds {
  const left = clamp(bounds.x, container.x, container.x + container.width);
  const top = clamp(bounds.y, container.y, container.y + container.height);
  const right = clamp(bounds.x + bounds.width, container.x, container.x + container.width);
  const bottom = clamp(bounds.y + bounds.height, container.y, container.y + container.height);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function boundsIntersect(left: Bounds, right: Bounds): boolean {
  return (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  );
}

export function intersectBounds(left: Bounds, right: Bounds): Bounds | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  const width = rightEdge - x;
  const height = bottomEdge - y;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

export function boundsContainsPoint(bounds: Bounds, point: Point): boolean {
  return (
    point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height
  );
}

export function toLocalBounds(bounds: Bounds, origin: Pick<Bounds, 'x' | 'y'>): Bounds {
  return {
    x: bounds.x - origin.x,
    y: bounds.y - origin.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function toAbsoluteBounds(bounds: Bounds, origin: Pick<Bounds, 'x' | 'y'>): Bounds {
  return {
    x: bounds.x + origin.x,
    y: bounds.y + origin.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function getDisplayViewport(display: DisplayInfo, scopeBounds: Bounds | null): Bounds {
  if (scopeBounds) {
    return { ...scopeBounds };
  }

  return { ...display.boundsDIP };
}

export function relativeBBoxToBoundsInViewport(
  bbox: RelativeBBox,
  viewport: Bounds,
): Bounds {
  return {
    x: viewport.x + bbox.x_min * viewport.width,
    y: viewport.y + bbox.y_min * viewport.height,
    width: (bbox.x_max - bbox.x_min) * viewport.width,
    height: (bbox.y_max - bbox.y_min) * viewport.height,
  };
}

export function boundsToRelativeBBoxInViewport(
  bounds: Bounds,
  viewport: Bounds,
): RelativeBBox {
  const local = toLocalBounds(bounds, viewport);
  return {
    x_min: local.x / viewport.width,
    y_min: local.y / viewport.height,
    x_max: (local.x + local.width) / viewport.width,
    y_max: (local.y + local.height) / viewport.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
