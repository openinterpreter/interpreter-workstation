import { describe, expect, test } from 'bun:test';
import {
  clampZoomFactor,
  DEFAULT_ZOOM_FACTOR,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_MIN,
} from './zoom';

describe('clampZoomFactor', () => {
  test('returns default when zoom factor is not finite', () => {
    expect(clampZoomFactor(Number.NaN)).toBe(DEFAULT_ZOOM_FACTOR);
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM_FACTOR);
    expect(clampZoomFactor(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_ZOOM_FACTOR);
  });

  test('clamps values below and above supported range', () => {
    expect(clampZoomFactor(0.3)).toBe(ZOOM_FACTOR_MIN);
    expect(clampZoomFactor(4.7)).toBe(ZOOM_FACTOR_MAX);
  });

  test('passes through in-range values', () => {
    expect(clampZoomFactor(ZOOM_FACTOR_MIN)).toBe(ZOOM_FACTOR_MIN);
    expect(clampZoomFactor(1.75)).toBe(1.75);
    expect(clampZoomFactor(ZOOM_FACTOR_MAX)).toBe(ZOOM_FACTOR_MAX);
  });
});
