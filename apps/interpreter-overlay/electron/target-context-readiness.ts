import type { DisplayInfo } from '../shared/types';
import type { OverlayRegionContextItem } from '../shared/ipc';

type StructuredTargetContext = {
  displayId: string | number;
  scopeBounds: OverlayRegionContextItem['bounds'];
  elements: unknown[];
} | null;

function boundsApproximatelyEqual(
  a: OverlayRegionContextItem['bounds'] | null | undefined,
  b: OverlayRegionContextItem['bounds'] | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }

  const tolerance = 1;
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance
    && Math.abs(a.height - b.height) <= tolerance;
}

export function isStructuredContextReadyForTarget(
  context: StructuredTargetContext,
  display: Pick<DisplayInfo, 'id'>,
  targetContext: OverlayRegionContextItem,
): boolean {
  return Boolean(
    context
      && context.displayId === display.id
      && boundsApproximatelyEqual(context.scopeBounds, targetContext.bounds)
      && context.elements.length > 0,
  );
}

export function hasExecutableTargetRefs(
  targetContext: OverlayRegionContextItem,
): boolean {
  return targetContext.snapshot.selectableRefs.some((ref) => (
    Boolean(ref.browser)
      || Boolean(ref.nativeCua?.targetIdentity)
  ));
}
