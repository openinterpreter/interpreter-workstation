import { describe, expect, test } from 'bun:test';

import type { ReviewAction } from '../shared/ipc';
import { hitsOverlayDrawingAction, pointInBounds } from './overlay-drawing-hit-test';

function action(overrides: Partial<ReviewAction> = {}): ReviewAction {
  return {
    id: 'drawing-1',
    type: 'click',
    description: 'Submit',
    bounds: { x: 20, y: 30, width: 100, height: 40 },
    hasBounds: true,
    ...overrides,
  };
}

describe('overlay drawing hit test', () => {
  test('includes bounds edges', () => {
    expect(pointInBounds({ x: 20, y: 30 }, { x: 20, y: 30, width: 100, height: 40 })).toBe(true);
    expect(pointInBounds({ x: 120, y: 70 }, { x: 20, y: 30, width: 100, height: 40 })).toBe(true);
  });

  test('hits active drawing bounds in display-local overlay coordinates', () => {
    expect(hitsOverlayDrawingAction({
      action: action(),
      ghosts: [],
      activeDrawingIds: new Set(['drawing-1']),
      displayOrigin: { x: 500, y: 100 },
      absolutePoint: { x: 560, y: 150 },
    })).toBe(true);
  });

  test('ignores non-drawing actions and off-target clicks', () => {
    expect(hitsOverlayDrawingAction({
      action: action({ id: 'normal-action' }),
      ghosts: [action({ id: 'drawing-2', bounds: { x: 200, y: 200, width: 40, height: 40 } })],
      activeDrawingIds: new Set(['drawing-2']),
      displayOrigin: { x: 0, y: 0 },
      absolutePoint: { x: 60, y: 50 },
    })).toBe(false);
  });
});
