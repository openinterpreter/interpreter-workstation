import { describe, expect, test } from 'bun:test';
import { getNewContextSourceHighlights } from './context-source-highlight';
import type { OverlayContextItem, OverlayRegionContextItem } from '../shared/ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';

function targetRegion(): OverlayRegionContextItem {
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'screen-region',
    bounds,
    display: {
      id: '1',
      boundsDIP: { x: 0, y: 0, width: 1200, height: 800 },
      scaleFactor: 2,
    },
    generation: 1,
    now: 1000,
  });
  return {
    id: 'target',
    kind: 'region',
    role: 'target',
    scopeKind: 'screen-region',
    label: 'Target',
    bounds,
    displayId: 1,
    targetWindowSessionKey: null,
    targetIdentity,
    snapshot: buildCurrentSelectionContext({ targetIdentity }),
    previewText: null,
    previewImageDataUrl: null,
  };
}

describe('context source highlight selection', () => {
  test('creates highlights only for newly imported file context items with source bounds', () => {
    const items: OverlayContextItem[] = [
      targetRegion(),
      {
        id: 'selected-file',
        kind: 'file',
        role: 'reference',
        name: 'selected-file-proof.txt',
        mimeType: 'text/plain',
        sizeBytes: 18,
        filePath: '/tmp/selected-file-proof.txt',
        sourceKind: 'selected-file',
        sourceLabel: 'Selected file',
        sourceBounds: { x: 678, y: 315, width: 64, height: 64 },
        sourceDisplayId: 1,
      },
      {
        id: 'existing-selected-text',
        kind: 'file',
        role: 'reference',
        name: 'Selected text.txt',
        mimeType: 'text/plain',
        sizeBytes: 44,
        filePath: null,
        sourceKind: 'selected-text',
        sourceLabel: 'Selected text',
        sourceBounds: { x: 895, y: 298, width: 317, height: 304 },
        sourceDisplayId: 1,
      },
      {
        id: 'dropped-file',
        kind: 'file',
        role: 'reference',
        name: 'receipt.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        filePath: '/tmp/receipt.png',
        sourceKind: 'dropped-file',
        sourceLabel: 'Dropped file',
      },
    ];

    expect(getNewContextSourceHighlights(items, new Set(['existing-selected-text']))).toEqual([
      {
        id: 'selected-file',
        label: 'Selected file',
        bounds: { x: 678, y: 315, width: 64, height: 64 },
      },
    ]);
  });

  test('does not mark a file as highlighted until source bounds are available', () => {
    const initialItems: OverlayContextItem[] = [
      {
        id: 'selected-file',
        kind: 'file',
        role: 'reference',
        name: 'selected-file-proof.txt',
        mimeType: 'text/plain',
        sizeBytes: 18,
        filePath: '/tmp/selected-file-proof.txt',
        sourceKind: 'selected-file',
        sourceLabel: 'Selected file',
      },
    ];
    const nextItems: OverlayContextItem[] = [
      {
        ...initialItems[0],
        sourceBounds: { x: 678, y: 315, width: 64, height: 64 },
        sourceDisplayId: 1,
      },
    ];

    expect(getNewContextSourceHighlights(initialItems, new Set())).toEqual([]);
    expect(getNewContextSourceHighlights(nextItems, new Set())).toEqual([
      {
        id: 'selected-file',
        label: 'Selected file',
        bounds: { x: 678, y: 315, width: 64, height: 64 },
      },
    ]);
  });
});
