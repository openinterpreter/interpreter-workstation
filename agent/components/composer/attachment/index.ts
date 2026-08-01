export { AttachmentChip, ATTACHMENT_CHIP_NAME } from './AttachmentChipExtension';
export { AttachmentChipNodeView } from './AttachmentChipNodeView';
export { AttachmentPreviewPopover } from './AttachmentPreviewPopover';
export { createAttachmentStore, type AttachmentStore } from './attachmentStore';
export { serializeEditorWithAttachments } from './serialize';
export {
  handleComposerPaste,
  handleComposerDrop,
  shouldChipifyPastedText,
  buildPastedTextLabel,
  readBlobAsDataUrl,
  MAX_IMAGE_DATA_URL_BYTES,
  DEFAULT_PASTE_POLICY,
  type PastedContentPolicy,
} from './composerPaste';
export {
  ATTACHMENT_PREVIEW_START_EVENT,
  ATTACHMENT_PREVIEW_END_EVENT,
  ATTACHMENT_PREVIEW_DELAY_MS,
  type AttachmentPreviewDetail,
  type AttachmentPreviewEndDetail,
  type AttachmentPreviewRect,
} from './attachmentPreviewEvents';
export type {
  ComposerAttachmentKind,
  ComposerAttachmentAttrs,
  ComposerAttachmentRecord,
  ComposerImageAttachment,
  SerializedComposerSubmission,
} from './types';
