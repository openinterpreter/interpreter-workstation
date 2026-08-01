import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AttachmentPreviewPopover } from './AttachmentPreviewPopover';
import {
  ATTACHMENT_PREVIEW_START_EVENT,
  type AttachmentPreviewDetail,
} from './attachmentPreviewEvents';
import type { ComposerAttachmentRecord } from './types';

const sourceKey = 'composer-pasted-text-chip';
const attachmentId = 'pasted-text-1';

const record: ComposerAttachmentRecord = {
  id: attachmentId,
  kind: 'pasted-text',
  label: 'Pasted (50 lines)',
  mimeType: 'text/plain',
  size: 2100,
  text: Array.from({ length: 50 }, (_, index) => `Line ${index + 1}`).join('\n'),
};

const previewDetail: AttachmentPreviewDetail = {
  sourceKey,
  attachmentId,
  kind: 'pasted-text',
  label: record.label,
  mimeType: record.mimeType,
  size: record.size,
  chipRect: {
    left: 96,
    top: 760,
    width: 240,
    height: 32,
  },
};

function dispatchPreviewStart() {
  window.dispatchEvent(new CustomEvent(ATTACHMENT_PREVIEW_START_EVENT, {
    detail: previewDetail,
  }));
}

function getPreviewBody(preview: HTMLElement): Element {
  const body = preview.querySelector('.composer-attachment-preview__body');
  if (!body) {
    throw new Error('Expected attachment preview body to render');
  }
  return body;
}

describe('AttachmentPreviewPopover', () => {
  beforeEach(() => {
    const source = document.createElement('button');
    source.dataset.attachmentPreviewKey = sourceKey;
    source.textContent = record.label;
    document.body.appendChild(source);
  });

  afterEach(() => {
    document.querySelectorAll('[data-attachment-preview-key]').forEach((node) => node.remove());
    vi.useRealTimers();
  });

  test('keeps pasted-content preview open when scrolling inside the preview body', async () => {
    render(
      <AttachmentPreviewPopover
        resolveRecord={(nextAttachmentId) => (
          nextAttachmentId === attachmentId ? record : undefined
        )}
      />,
    );

    dispatchPreviewStart();

    const preview = await screen.findByRole('tooltip', {
      name: `Attachment preview: ${record.label}`,
    });
    const body = getPreviewBody(preview);

    fireEvent.scroll(body);

    expect(screen.getByRole('tooltip', {
      name: `Attachment preview: ${record.label}`,
    })).toBeInTheDocument();
  });

  test('shows full pasted-content text by default', async () => {
    render(
      <AttachmentPreviewPopover
        resolveRecord={(nextAttachmentId) => (
          nextAttachmentId === attachmentId ? record : undefined
        )}
      />,
    );

    dispatchPreviewStart();

    const preview = await screen.findByRole('tooltip', {
      name: `Attachment preview: ${record.label}`,
    });

    expect(preview).toHaveTextContent('Line 50');
    expect(preview).not.toHaveTextContent('more lines');
  });

  test('can opt into truncated pasted-content preview text', async () => {
    render(
      <AttachmentPreviewPopover
        resolveRecord={(nextAttachmentId) => (
          nextAttachmentId === attachmentId ? record : undefined
        )}
        truncateText
      />,
    );

    dispatchPreviewStart();

    const preview = await screen.findByRole('tooltip', {
      name: `Attachment preview: ${record.label}`,
    });

    expect(preview).not.toHaveTextContent('Line 50');
    expect(preview).toHaveTextContent('26 more lines');
  });

  test('dismisses pasted-content preview when scrolling outside the preview', async () => {
    render(
      <AttachmentPreviewPopover
        resolveRecord={(nextAttachmentId) => (
          nextAttachmentId === attachmentId ? record : undefined
        )}
      />,
    );

    dispatchPreviewStart();

    await screen.findByRole('tooltip', {
      name: `Attachment preview: ${record.label}`,
    });

    fireEvent.scroll(window);

    await waitFor(() => {
      expect(screen.queryByRole('tooltip', {
        name: `Attachment preview: ${record.label}`,
      })).not.toBeInTheDocument();
    });
  });
});
