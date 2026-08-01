export const DEFAULT_IMAGE_ANNOTATION_WIDTH = 150;
export const DEFAULT_IMAGE_ANNOTATION_HEIGHT = 100;
export const MAX_INITIAL_IMAGE_ANNOTATION_DIMENSION = 300;
export const MIN_IMAGE_ANNOTATION_DIMENSION = 10;

export function getInitialImageAnnotationSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return {
      width: DEFAULT_IMAGE_ANNOTATION_WIDTH,
      height: DEFAULT_IMAGE_ANNOTATION_HEIGHT,
    };
  }

  const aspectRatio = naturalWidth / naturalHeight;
  if (naturalWidth >= naturalHeight) {
    const width = Math.min(naturalWidth, MAX_INITIAL_IMAGE_ANNOTATION_DIMENSION);
    return { width, height: width / aspectRatio };
  }

  const height = Math.min(naturalHeight, MAX_INITIAL_IMAGE_ANNOTATION_DIMENSION);
  return { width: height * aspectRatio, height };
}

export function clampImageAnnotationDimension(value: number): number {
  return Math.max(MIN_IMAGE_ANNOTATION_DIMENSION, value);
}
