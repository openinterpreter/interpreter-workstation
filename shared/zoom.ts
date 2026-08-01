export const ZOOM_FACTOR_MIN = 0.5;
export const ZOOM_FACTOR_MAX = 3;
export const DEFAULT_ZOOM_FACTOR = 1;

export function clampZoomFactor(zoomFactor: number): number {
  if (!Number.isFinite(zoomFactor)) return DEFAULT_ZOOM_FACTOR;
  return Math.max(ZOOM_FACTOR_MIN, Math.min(ZOOM_FACTOR_MAX, zoomFactor));
}
