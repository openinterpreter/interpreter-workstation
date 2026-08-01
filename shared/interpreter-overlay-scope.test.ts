import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SCOPE_DRAG_THRESHOLD_PX,
  boundsToRelativeBBoxInViewport,
  clampBoundsToBounds,
  hasMeaningfulScope,
  intersectBounds,
  normalizeDragBounds,
  relativeBBoxToBoundsInViewport,
} from '../apps/interpreter-overlay/shared/scope';

describe('interpreter overlay scope helpers', () => {
  test('normalizeDragBounds handles dragging in any direction', () => {
    expect(
      normalizeDragBounds(
        { x: 420, y: 260 },
        { x: 180, y: 120 },
      ),
    ).toEqual({
      x: 180,
      y: 120,
      width: 240,
      height: 140,
    });
  });

  test('clampBoundsToBounds clips selection to the display viewport', () => {
    expect(
      clampBoundsToBounds(
        { x: -40, y: 16, width: 180, height: 140 },
        { x: 0, y: 0, width: 100, height: 100 },
      ),
    ).toEqual({
      x: 0,
      y: 16,
      width: 100,
      height: 84,
    });
  });

  test('intersectBounds returns the clipped overlap', () => {
    expect(
      intersectBounds(
        { x: 40, y: 50, width: 120, height: 90 },
        { x: 100, y: 0, width: 80, height: 100 },
      ),
    ).toEqual({
      x: 100,
      y: 50,
      width: 60,
      height: 50,
    });
  });

  test('relative bbox conversion uses the scoped viewport origin', () => {
    const viewport = { x: 240, y: 180, width: 400, height: 300 };
    const absoluteBounds = relativeBBoxToBoundsInViewport(
      {
        x_min: 0.1,
        y_min: 0.2,
        x_max: 0.6,
        y_max: 0.7,
      },
      viewport,
    );

    expect(absoluteBounds.x).toBeCloseTo(280);
    expect(absoluteBounds.y).toBeCloseTo(240);
    expect(absoluteBounds.width).toBeCloseTo(200);
    expect(absoluteBounds.height).toBeCloseTo(150);

    const normalizedBounds = boundsToRelativeBBoxInViewport(absoluteBounds, viewport);
    expect(normalizedBounds.x_min).toBeCloseTo(0.1);
    expect(normalizedBounds.y_min).toBeCloseTo(0.2);
    expect(normalizedBounds.x_max).toBeCloseTo(0.6);
    expect(normalizedBounds.y_max).toBeCloseTo(0.7);
  });

  test('the drag threshold requires a real box, not a click jitter', () => {
    const clickJitter = {
      x: 10,
      y: 10,
      width: DEFAULT_SCOPE_DRAG_THRESHOLD_PX - 1,
      height: DEFAULT_SCOPE_DRAG_THRESHOLD_PX - 1,
    };

    expect(hasMeaningfulScope(clickJitter)).toBe(false);
    expect(hasMeaningfulScope({
      ...clickJitter,
      width: DEFAULT_SCOPE_DRAG_THRESHOLD_PX,
      height: DEFAULT_SCOPE_DRAG_THRESHOLD_PX,
    })).toBe(true);
  });
});
