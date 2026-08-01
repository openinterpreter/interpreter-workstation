import type {
  AttachmentPreviewDetail,
} from './attachmentPreviewEvents';

export interface AttachmentPreviewHoverState {
  detail: AttachmentPreviewDetail | null;
  isSourceHovered: boolean;
  isPopoverHovered: boolean;
}

export function createAttachmentPreviewHoverState(): AttachmentPreviewHoverState {
  return {
    detail: null,
    isSourceHovered: false,
    isPopoverHovered: false,
  };
}

export function startAttachmentPreview(
  current: AttachmentPreviewHoverState,
  detail: AttachmentPreviewDetail,
): AttachmentPreviewHoverState {
  const isSameSource = current.detail?.sourceKey === detail.sourceKey;
  return {
    detail,
    isSourceHovered: true,
    isPopoverHovered: isSameSource ? current.isPopoverHovered : false,
  };
}

export function endAttachmentPreviewFromSource(
  current: AttachmentPreviewHoverState,
  sourceKey?: string | null,
): AttachmentPreviewHoverState {
  if (!current.detail) return current;
  if (sourceKey && current.detail.sourceKey !== sourceKey) return current;
  return {
    ...current,
    isSourceHovered: false,
  };
}

export function enterAttachmentPreviewPopover(
  current: AttachmentPreviewHoverState,
): AttachmentPreviewHoverState {
  if (!current.detail || current.isPopoverHovered) return current;
  return {
    ...current,
    isPopoverHovered: true,
  };
}

export function leaveAttachmentPreviewPopover(
  current: AttachmentPreviewHoverState,
): AttachmentPreviewHoverState {
  if (!current.detail || !current.isPopoverHovered) return current;
  return {
    ...current,
    isPopoverHovered: false,
  };
}

export function clearAttachmentPreview(): AttachmentPreviewHoverState {
  return createAttachmentPreviewHoverState();
}

export function shouldDismissAttachmentPreview(
  current: AttachmentPreviewHoverState,
): boolean {
  return !!current.detail && !current.isSourceHovered && !current.isPopoverHovered;
}
