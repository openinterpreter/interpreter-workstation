type CollisionPadding =
  | number
  | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>
  | undefined;

const DEFAULT_VIEWPORT_PADDING = 16;
const FALLBACK_TITLEBAR_HEIGHT = 42;
const TITLEBAR_SAFE_MARGIN = 8;

function readRootPxVariable(name: string): number | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getTitlebarSafeInset(): number {
  const titlebarHeight = readRootPxVariable('--unit-height') ?? FALLBACK_TITLEBAR_HEIGHT;
  return titlebarHeight + TITLEBAR_SAFE_MARGIN;
}

export function resolveFloatingCollisionPadding(
  collisionPadding: CollisionPadding = DEFAULT_VIEWPORT_PADDING,
): Record<'top' | 'right' | 'bottom' | 'left', number> {
  const safeTop = getTitlebarSafeInset();

  if (typeof collisionPadding === 'number') {
    const edgePadding = Math.max(0, collisionPadding);
    return {
      top: Math.max(edgePadding, safeTop),
      right: edgePadding,
      bottom: edgePadding,
      left: edgePadding,
    };
  }

  return {
    top: Math.max(collisionPadding?.top ?? DEFAULT_VIEWPORT_PADDING, safeTop),
    right: collisionPadding?.right ?? DEFAULT_VIEWPORT_PADDING,
    bottom: collisionPadding?.bottom ?? DEFAULT_VIEWPORT_PADDING,
    left: collisionPadding?.left ?? DEFAULT_VIEWPORT_PADDING,
  };
}
