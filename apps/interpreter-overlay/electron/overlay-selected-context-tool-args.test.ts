import { describe, expect, test } from 'bun:test';

import type { OverlayContextItem, OverlayRegionContextItem } from '../shared/ipc';
import { buildOverlayTargetIdentity, buildCurrentSelectionContext } from '../shared/target-identity';
import { buildOverlaySelectedContextToolArgs } from './overlay-selected-context-tool-args';

function targetRegion(): OverlayRegionContextItem {
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  const targetIdentity = buildOverlayTargetIdentity({
    kind: 'screen-region',
    bounds,
    display: {
      id: 'display-1',
      boundsDIP: { x: 0, y: 0, width: 1000, height: 800 },
      scaleFactor: 2,
    },
    targetWindowSessionKey: 'window-1',
    generation: 1,
    now: 1000,
  });
  return {
    id: 'target-1',
    kind: 'region',
    role: 'target',
    label: 'Checkout form',
    scopeKind: 'screen-region',
    bounds,
    displayId: 'display-1',
    targetWindowSessionKey: 'window-1',
    targetIdentity,
    snapshot: buildCurrentSelectionContext({
      targetIdentity,
      selectableRefs: [{
        id: 'ui-ref-1',
        role: 'button',
        label: 'Submit',
        bounds: { x: 12, y: 24, width: 80, height: 30 },
      }],
    }),
    previewText: null,
    previewImageDataUrl: null,
  };
}

describe('overlay selected-context tool args', () => {
  test('builds selected_context and stable target_refs for overlay handoff tools', () => {
    const targetContext = targetRegion();
    const contextItems: OverlayContextItem[] = [
      targetContext,
      {
        id: 'selected-text-1',
        kind: 'file',
        role: 'reference',
        name: 'Selected text.txt',
        mimeType: 'text/plain',
        sizeBytes: 24,
        filePath: null,
        dataUrl: `data:text/plain;base64,${Buffer.from('selected text body').toString('base64')}`,
        sourceKind: 'selected-text',
        sourceLabel: 'Selected text',
        sourceBounds: { x: 100, y: 120, width: 140, height: 30 },
        sourceDisplayId: 'display-1',
      },
    ];

    const args = buildOverlaySelectedContextToolArgs(targetContext, contextItems);

    expect(args.target_refs).toEqual(['target-1', 'overlay-target-1', 'ui-ref-1']);
    expect(args.selected_context).toMatchObject({
      id: 'selected-context-1',
      generation: 1,
      targetIdentityId: 'overlay-target-1',
      selectedTextRefs: [{
        id: 'selected-text-1',
        textPreview: 'selected text body',
      }],
    });
  });

  test('returns no args when no target context is attached', () => {
    expect(buildOverlaySelectedContextToolArgs(null, [])).toEqual({});
  });

  test('passes selected text and files without inventing target refs when no target context is attached', () => {
    const args = buildOverlaySelectedContextToolArgs(null, [{
      id: 'selected-file-1',
      kind: 'file',
      role: 'reference',
      name: 'quote.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      filePath: '/workspace/quote.pdf',
      sourceKind: 'selected-file',
      sourceLabel: 'Selected file',
      sourceBounds: { x: 20, y: 30, width: 120, height: 20 },
      sourceDisplayId: 'display-1',
    }, {
      id: 'selected-text-1',
      kind: 'file',
      role: 'reference',
      name: 'Selected text.txt',
      mimeType: 'text/plain',
      sizeBytes: 18,
      filePath: null,
      dataUrl: `data:text/plain;base64,${Buffer.from('policy number 123').toString('base64')}`,
      sourceKind: 'selected-text',
      sourceLabel: 'Selected text',
      sourceBounds: { x: 100, y: 120, width: 140, height: 30 },
      sourceDisplayId: 'display-1',
    }]);

    expect(args.target_refs).toBeUndefined();
    expect(args.selected_context).toEqual({
      kind: 'targetless-selection',
      targetIdentityId: null,
      contextItemIds: ['selected-file-1', 'selected-text-1'],
      selectedFileRefs: [{
        id: 'selected-file-1',
        name: 'quote.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        filePath: '/workspace/quote.pdf',
        sourceKind: 'selected-file',
        sourceLabel: 'Selected file',
        sourceBounds: { x: 20, y: 30, width: 120, height: 20 },
        sourceDisplayId: 'display-1',
      }],
      selectedTextRefs: [{
        id: 'selected-text-1',
        sourceLabel: 'Selected text',
        sourceBounds: { x: 100, y: 120, width: 140, height: 30 },
        sourceDisplayId: 'display-1',
        textPreview: 'policy number 123',
      }],
    });
  });
});
