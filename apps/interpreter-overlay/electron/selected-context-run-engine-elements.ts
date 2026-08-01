import type { ScreenElement } from '../runtime/infra/accessibility-parser/index.js';
import type { CurrentSelectionContext } from '../shared/target-identity.js';

export function mergeSelectedContextRefsIntoRunEngineElements(
  elements: ScreenElement[],
  snapshot: CurrentSelectionContext | undefined,
): ScreenElement[] {
  if (!snapshot || snapshot.selectableRefs.length === 0) {
    return elements;
  }

  const seenIds = new Set(elements.map((element) => element.id));
  const selectedElements: ScreenElement[] = [];
  for (const ref of snapshot.selectableRefs) {
    if (seenIds.has(ref.id)) {
      continue;
    }
    seenIds.add(ref.id);
    selectedElements.push({
      id: ref.id,
      role: ref.role,
      label: ref.label,
      bbox: { ...ref.bounds },
      nativeCua: ref.nativeCua && ref.nativeCua.targetIdentity
        ? {
            app: ref.nativeCua.app,
            elementIndex: ref.nativeCua.elementIndex,
            targetIdentity: { ...ref.nativeCua.targetIdentity },
          }
        : undefined,
      browserPage: ref.browser?.targetIdentity
        ? {
            refId: ref.browser.refId,
            targetIdentity: { ...ref.browser.targetIdentity },
          }
        : undefined,
    });
  }

  return selectedElements.length === 0
    ? elements
    : [...elements, ...selectedElements];
}
