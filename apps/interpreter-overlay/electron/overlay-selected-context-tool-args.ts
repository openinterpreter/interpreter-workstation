import type { OverlayContextItem, OverlayFileContextItem, OverlayRegionContextItem } from '../shared/ipc.js';
import { buildOverlayCurrentSelectionContext } from '../shared/context-packet.js';

function parseSelectedTextDataUrl(dataUrl: string | undefined): string {
  if (!dataUrl) {
    return '';
  }
  const match = /^data:([^;,]+)?;base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    return '';
  }
  return Buffer.from(match[2], 'base64').toString('utf8').trim().slice(0, 12_000);
}

function buildTargetlessSelectedContext(contextItems: OverlayContextItem[] | undefined): Record<string, unknown> | undefined {
  const selectedItems = (contextItems ?? []).filter((item): item is OverlayFileContextItem => (
    item.kind === 'file'
    && (item.sourceKind === 'selected-file' || item.sourceKind === 'selected-text')
  ));
  if (selectedItems.length === 0) {
    return undefined;
  }

  return {
    kind: 'targetless-selection',
    targetIdentityId: null,
    contextItemIds: selectedItems.map((item) => item.id),
    selectedFileRefs: selectedItems
      .filter((item) => item.sourceKind === 'selected-file')
      .map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        filePath: item.filePath,
        sourceKind: item.sourceKind ?? null,
        sourceLabel: item.sourceLabel ?? null,
        sourceBounds: item.sourceBounds ? { ...item.sourceBounds } : null,
        sourceDisplayId: item.sourceDisplayId ?? null,
      })),
    selectedTextRefs: selectedItems
      .filter((item) => item.sourceKind === 'selected-text')
      .map((item) => ({
        id: item.id,
        sourceLabel: item.sourceLabel ?? null,
        sourceBounds: item.sourceBounds ? { ...item.sourceBounds } : null,
        sourceDisplayId: item.sourceDisplayId ?? null,
        textPreview: parseSelectedTextDataUrl(item.dataUrl),
      })),
  };
}

export function buildOverlaySelectedContextForTool(
  targetContext: OverlayRegionContextItem | null | undefined,
  contextItems: OverlayContextItem[] | undefined,
) {
  if (!targetContext) {
    return buildTargetlessSelectedContext(contextItems);
  }
  return buildOverlayCurrentSelectionContext(targetContext, contextItems ?? [targetContext]);
}

export function buildOverlayTargetRefsForTool(
  targetContext: OverlayRegionContextItem | null | undefined,
  contextItems: OverlayContextItem[] | undefined,
): string[] | undefined {
  if (!targetContext) {
    return undefined;
  }
  const selectedContext = buildOverlayCurrentSelectionContext(targetContext, contextItems ?? [targetContext]);
  const refs = [
    targetContext.id,
    selectedContext.targetIdentityId,
    ...selectedContext.selectableRefs.map((ref) => ref.id),
  ].filter(Boolean);
  return refs.length > 0 ? Array.from(new Set(refs)) : undefined;
}

export function buildOverlaySelectedContextToolArgs(
  targetContext: OverlayRegionContextItem | null | undefined,
  contextItems: OverlayContextItem[] | undefined,
): Record<string, unknown> {
  const selectedContext = buildOverlaySelectedContextForTool(targetContext, contextItems);
  const targetRefs = buildOverlayTargetRefsForTool(targetContext, contextItems);
  return {
    ...(selectedContext ? { selected_context: selectedContext } : {}),
    ...(targetRefs ? { target_refs: targetRefs } : {}),
  };
}
