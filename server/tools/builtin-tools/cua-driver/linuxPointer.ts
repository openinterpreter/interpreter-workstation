// A Linux pixel target is a visible-window action, not a background AX action.
// The driver uses real XTest pointer events (or the focused Wayland pointer)
// for foreground delivery; its default XSendEvent fallback can be silently
// ignored by Chromium even when the target window is already focused.
export function linuxPixelClickArgs(
  args: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  return platform === 'linux' && typeof args.x === 'number' && typeof args.y === 'number'
    ? { ...args, delivery_mode: 'foreground' }
    : args;
}
