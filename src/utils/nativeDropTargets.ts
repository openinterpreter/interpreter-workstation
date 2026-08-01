type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const NATIVE_DROP_TARGETS_GLOBAL_KEY = '__iworkstation_nativeDropTargets';
const nativeDropTargets: Map<string, Bounds> =
  ((globalThis as any)[NATIVE_DROP_TARGETS_GLOBAL_KEY] as Map<string, Bounds> | undefined) ??
  (((globalThis as any)[NATIVE_DROP_TARGETS_GLOBAL_KEY] = new Map<string, Bounds>()) as Map<string, Bounds>);

export function setNativeDropTargetBounds(id: string, rect: DOMRect | null): void {
  if (!rect) {
    nativeDropTargets.delete(id);
    return;
  }

  nativeDropTargets.set(id, {
    // Drag events often report integer client coordinates while DOMRects can be fractional.
    // Normalize to integer bounds so boundary points aren't accidentally excluded.
    left: Math.floor(rect.left),
    top: Math.floor(rect.top),
    right: Math.ceil(rect.right),
    bottom: Math.ceil(rect.bottom),
  });
}

export function clearNativeDropTargetBounds(id: string): void {
  nativeDropTargets.delete(id);
}

export function isPointInAnyNativeDropTarget(clientX: number, clientY: number): boolean {
  for (const bounds of nativeDropTargets.values()) {
    if (
      clientX >= bounds.left &&
      clientX <= bounds.right &&
      clientY >= bounds.top &&
      clientY <= bounds.bottom
    ) {
      return true;
    }
  }
  return false;
}
