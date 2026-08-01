import { describe, expect, test } from 'bun:test';

import type { AttachmentPreviewDetail } from './attachmentPreviewEvents';
import {
  clearAttachmentPreview,
  createAttachmentPreviewHoverState,
  endAttachmentPreviewFromSource,
  enterAttachmentPreviewPopover,
  leaveAttachmentPreviewPopover,
  shouldDismissAttachmentPreview,
  startAttachmentPreview,
} from './attachmentPreviewState';

function makeDetail(sourceKey: string): AttachmentPreviewDetail {
  return {
    sourceKey,
    attachmentId: `attachment-${sourceKey}`,
    kind: 'pasted-text',
    label: 'Pasted (3 lines)',
    mimeType: 'text/plain',
    size: 32,
    chipRect: {
      top: 10,
      left: 20,
      width: 64,
      height: 18,
    },
  };
}

describe('attachmentPreviewState', () => {
  test('starts a preview with the source marked hovered', () => {
    const next = startAttachmentPreview(createAttachmentPreviewHoverState(), makeDetail('source-a'));
    expect(next.detail?.sourceKey).toBe('source-a');
    expect(next.isSourceHovered).toBe(true);
    expect(next.isPopoverHovered).toBe(false);
  });

  test('ignores source-end events for a different chip', () => {
    const current = startAttachmentPreview(createAttachmentPreviewHoverState(), makeDetail('source-a'));
    const next = endAttachmentPreviewFromSource(current, 'source-b');
    expect(next).toEqual(current);
  });

  test('keeps the preview alive while the popover is hovered', () => {
    let state = startAttachmentPreview(createAttachmentPreviewHoverState(), makeDetail('source-a'));
    state = enterAttachmentPreviewPopover(state);
    state = endAttachmentPreviewFromSource(state, 'source-a');
    expect(shouldDismissAttachmentPreview(state)).toBe(false);
    state = leaveAttachmentPreviewPopover(state);
    expect(shouldDismissAttachmentPreview(state)).toBe(true);
  });

  test('resets popover hover when a different source starts', () => {
    let state = startAttachmentPreview(createAttachmentPreviewHoverState(), makeDetail('source-a'));
    state = enterAttachmentPreviewPopover(state);
    state = startAttachmentPreview(state, makeDetail('source-b'));
    expect(state.detail?.sourceKey).toBe('source-b');
    expect(state.isSourceHovered).toBe(true);
    expect(state.isPopoverHovered).toBe(false);
  });

  test('clears all hover state when dismissed', () => {
    const state = clearAttachmentPreview();
    expect(state.detail).toBeNull();
    expect(state.isSourceHovered).toBe(false);
    expect(state.isPopoverHovered).toBe(false);
  });
});
