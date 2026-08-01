import type { Bounds } from '../shared/ipc.js';

export type WorldReviewControlHit = 'accept' | 'reject';

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlobalHookPoint {
  x: number;
  y: number;
  coordinateSpace?: 'dip' | 'physical';
}

export function getWorldReviewControlHit(
  point: { x: number; y: number },
  bounds: Bounds | null | undefined,
): WorldReviewControlHit | null {
  if (!bounds) {
    return null;
  }

  const inside = point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
  if (!inside) {
    return null;
  }

  return point.x >= bounds.x + (bounds.width / 2) ? 'accept' : 'reject';
}

export function getWorldReviewControlHitFromGlobalPoint(
  point: GlobalHookPoint,
  displayBoundsDIP: DisplayBounds,
  scaleFactor: number,
  bounds: Bounds | null | undefined,
): WorldReviewControlHit | null {
  if (!bounds) {
    return null;
  }

  const safeScale = scaleFactor || 1;
  const normalizedPoint = point.coordinateSpace === 'dip'
    ? { x: point.x, y: point.y }
    : {
        x: displayBoundsDIP.x + ((point.x - (displayBoundsDIP.x * safeScale)) / safeScale),
        y: displayBoundsDIP.y + ((point.y - (displayBoundsDIP.y * safeScale)) / safeScale),
      };

  const candidates = [
    {
      x: normalizedPoint.x - displayBoundsDIP.x,
      y: normalizedPoint.y - displayBoundsDIP.y,
    },
    {
      x: point.x - displayBoundsDIP.x,
      y: point.y - displayBoundsDIP.y,
    },
  ];

  for (const candidate of candidates) {
    const hit = getWorldReviewControlHit(candidate, bounds);
    if (hit) {
      return hit;
    }
  }

  return null;
}
