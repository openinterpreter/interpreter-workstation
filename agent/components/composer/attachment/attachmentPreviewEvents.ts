/**
 * Custom-event channel for attachment chip hover-preview.
 *
 * Mirrors the mention-preview event shape so the preview popover can follow
 * the same positioning conventions already used across the app.
 */

import type { ComposerAttachmentKind } from './types';

export const ATTACHMENT_PREVIEW_START_EVENT = 'attachment:preview-start';
export const ATTACHMENT_PREVIEW_END_EVENT = 'attachment:preview-end';
export const ATTACHMENT_PREVIEW_DELAY_MS = 350;

export interface AttachmentPreviewRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface AttachmentPreviewDetail {
  sourceKey: string;
  attachmentId: string;
  kind: ComposerAttachmentKind;
  label: string;
  mimeType?: string | null;
  size?: number | null;
  chipRect: AttachmentPreviewRect;
}

export interface AttachmentPreviewEndDetail {
  sourceKey?: string | null;
}
