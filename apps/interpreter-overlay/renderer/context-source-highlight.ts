import type { OverlayContextItem } from '../shared/ipc.js';
import type { Bounds } from '../shared/types.js';

export interface ContextSourceHighlight {
  id: string;
  bounds: Bounds;
  label: string;
}

export function getNewContextSourceHighlights(
  contextItems: OverlayContextItem[],
  previousIds: ReadonlySet<string>,
): ContextSourceHighlight[] {
  return contextItems.flatMap((item): ContextSourceHighlight[] => {
    if (item.kind !== 'file' || !item.sourceBounds || previousIds.has(item.id)) {
      return [];
    }
    return [{
      id: item.id,
      bounds: item.sourceBounds,
      label: item.sourceLabel ?? item.name,
    }];
  });
}
