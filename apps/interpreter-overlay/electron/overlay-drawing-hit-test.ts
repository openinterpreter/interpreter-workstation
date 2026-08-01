import type { Bounds, ReviewAction } from '../shared/ipc';

export function pointInBounds(point: { x: number; y: number }, bounds: Bounds): boolean {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

export function hitsOverlayDrawingAction(input: {
  action: ReviewAction | null;
  ghosts: ReviewAction[];
  activeDrawingIds: Set<string>;
  displayOrigin: Pick<Bounds, 'x' | 'y'>;
  absolutePoint: { x: number; y: number };
}): boolean {
  if (input.activeDrawingIds.size === 0) {
    return false;
  }

  const localPoint = {
    x: input.absolutePoint.x - input.displayOrigin.x,
    y: input.absolutePoint.y - input.displayOrigin.y,
  };
  const actions = [
    ...(input.action ? [input.action] : []),
    ...input.ghosts,
  ];
  return actions.some((action) => (
    input.activeDrawingIds.has(action.id)
    && action.hasBounds === true
    && action.bounds.width > 0
    && action.bounds.height > 0
    && pointInBounds(localPoint, action.bounds)
  ));
}
