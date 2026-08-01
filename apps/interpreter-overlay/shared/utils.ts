import type { RelativeBBox, DisplayInfo } from './types.js';

/**
 * Convert a normalized bbox to device pixel coordinates.
 * @param bbox - RelativeBBox [0..1]
 * @param display - DisplayInfo for the target display
 * @returns Absolute bbox in device pixels
 */
export function bboxToDevicePixels(
  bbox: RelativeBBox,
  display: DisplayInfo
): { x_min: number; y_min: number; x_max: number; y_max: number } {
  const { boundsDIP, scaleFactor } = display;
  const result = {
    x_min: (bbox.x_min * boundsDIP.width) * scaleFactor + boundsDIP.x * scaleFactor,
    y_min: (bbox.y_min * boundsDIP.height) * scaleFactor + boundsDIP.y * scaleFactor,
    x_max: (bbox.x_max * boundsDIP.width) * scaleFactor + boundsDIP.x * scaleFactor,
    y_max: (bbox.y_max * boundsDIP.height) * scaleFactor + boundsDIP.y * scaleFactor,
  };

  console.log('[bboxToDevicePixels] Input bbox:', JSON.stringify(bbox));
  console.log('[bboxToDevicePixels] Display:', JSON.stringify(display));
  console.log('[bboxToDevicePixels] Result:', JSON.stringify(result));

  return result;
}

/**
 * Convert a normalized bbox to DIP coordinates (for overlay rendering).
 * @param bbox - RelativeBBox [0..1] normalized to the screenshot
 * @param display - DisplayInfo for the target display
 * @returns Window-relative bbox in DIP with x_min, y_min, x_max, y_max
 *
 * IMPORTANT: Returns WINDOW-RELATIVE coordinates for CSS positioning.
 * The overlay window may be positioned at screen coordinates (x, y), but
 * CSS uses coordinates relative to the window's top-left (0, 0).
 *
 * On macOS, if the window is below the menu bar at screen y=25, we DON'T add
 * that offset because CSS positioning is relative to the window's own origin.
 */
export function bboxToDIP(
  bbox: RelativeBBox,
  display: DisplayInfo
): { x_min: number; y_min: number; x_max: number; y_max: number } {
  const { boundsDIP } = display;
  // Multiply by width/height to get size, but don't add x/y offset
  // because CSS positioning is window-relative, not screen-absolute
  const result = {
    x_min: bbox.x_min * boundsDIP.width,
    y_min: bbox.y_min * boundsDIP.height,
    x_max: bbox.x_max * boundsDIP.width,
    y_max: bbox.y_max * boundsDIP.height,
  };

  console.log('[bboxToDIP] Input bbox:', JSON.stringify(bbox));
  console.log('[bboxToDIP] Display boundsDIP:', JSON.stringify(boundsDIP));
  console.log('[bboxToDIP] Result:', JSON.stringify(result));

  return result;
}

/**
 * Compute the center of a bbox for automation.
 * @param bbox - RelativeBBox [0..1]
 * @param display - DisplayInfo for the target display
 * @returns Center point in screen coordinates
 *
 * NOTE: On macOS, nut.js expects DIP coordinates, not device pixels.
 * Returns DIP coordinates (absolute screen position).
 */
export function bboxCenter(bbox: RelativeBBox, display: DisplayInfo): { x: number; y: number } {
  const { boundsDIP } = display;
  // Convert normalized bbox to absolute DIP coordinates (add display offset)
  const x_min = bbox.x_min * boundsDIP.width + boundsDIP.x;
  const y_min = bbox.y_min * boundsDIP.height + boundsDIP.y;
  const x_max = bbox.x_max * boundsDIP.width + boundsDIP.x;
  const y_max = bbox.y_max * boundsDIP.height + boundsDIP.y;

  const center = {
    x: (x_min + x_max) / 2,
    y: (y_min + y_max) / 2,
  };

  console.log('[bboxCenter] Input bbox:', JSON.stringify(bbox));
  console.log('[bboxCenter] Display:', JSON.stringify(display));
  console.log('[bboxCenter] DIP bbox:', { x_min, y_min, x_max, y_max });
  console.log('[bboxCenter] Center:', center);

  return center;
}

/**
 * Compute the center of a bbox in DIP (for overlay positioning).
 * @param bbox - RelativeBBox [0..1]
 * @param display - DisplayInfo for the target display
 * @returns Center point in DIP
 */
export function bboxCenterDIP(bbox: RelativeBBox, display: DisplayInfo): { x: number; y: number } {
  const dipBbox = bboxToDIP(bbox, display);
  return {
    x: (dipBbox.x_min + dipBbox.x_max) / 2,
    y: (dipBbox.y_min + dipBbox.y_max) / 2,
  };
}
