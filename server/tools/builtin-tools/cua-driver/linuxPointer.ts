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

// The addressed Linux window must be active while a key is sent. The driver's
// foreground transaction temporarily activates that window and sends a real
// XTest/Wayland key, then restores the prior X11 active window. Background
// XSendEvent can be explicitly refused or silently dropped by browser widgets.
export function linuxFocusedKeyboardArgs(
  args: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  return platform === 'linux'
    && typeof args.pid === 'number'
    && (typeof args.window_id === 'number' || typeof args.window_id === 'string')
    ? { ...args, delivery_mode: 'foreground' }
    : args;
}
