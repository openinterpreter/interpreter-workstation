import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_IMAGE_ANNOTATION_HEIGHT,
  DEFAULT_IMAGE_ANNOTATION_WIDTH,
  MAX_INITIAL_IMAGE_ANNOTATION_DIMENSION,
  MIN_IMAGE_ANNOTATION_DIMENSION,
  clampImageAnnotationDimension,
  getInitialImageAnnotationSize,
} from './pdfImageAnnotationSizing';

describe('getInitialImageAnnotationSize', () => {
  test('returns defaults for invalid image dimensions', () => {
    expect(getInitialImageAnnotationSize(0, 100)).toEqual({
      width: DEFAULT_IMAGE_ANNOTATION_WIDTH,
      height: DEFAULT_IMAGE_ANNOTATION_HEIGHT,
    });
  });

  test('caps wide images to max initial dimension', () => {
    const size = getInitialImageAnnotationSize(1200, 600);
    expect(size.width).toBe(MAX_INITIAL_IMAGE_ANNOTATION_DIMENSION);
    expect(size.height).toBe(150);
  });

  test('caps tall images to max initial dimension', () => {
    const size = getInitialImageAnnotationSize(600, 1200);
    expect(size.height).toBe(MAX_INITIAL_IMAGE_ANNOTATION_DIMENSION);
    expect(size.width).toBe(150);
  });
});

describe('clampImageAnnotationDimension', () => {
  test('allows sizes below previous 50px limit', () => {
    expect(clampImageAnnotationDimension(25)).toBe(25);
  });

  test('clamps to minimum dimension', () => {
    expect(clampImageAnnotationDimension(1)).toBe(MIN_IMAGE_ANNOTATION_DIMENSION);
  });
});
