/**
 * Composer Attachment Types
 *
 * Shared attachment records for rich-text composer surfaces. Text chips are
 * used by both the desktop composer and the Interpreter Overlay input. Image
 * payload attachments are currently emitted by the overlay input only; the
 * desktop agent composer converts pasted or dropped images into file mentions
 * instead of producing these image payloads.
 *
 * Each attachment is represented as an `attachmentChip` TipTap node whose
 * `attrs` carry only light metadata; the heavy payload (text body or image
 * dataUrl) lives in an in-memory store keyed by id and is cleared when the
 * composer is cleared.
 */

export type ComposerAttachmentKind = 'pasted-text' | 'pasted-image' | 'file-image';

/**
 * Node attrs stored on the attachmentChip TipTap node. Keeps editor JSON light:
 * heavy content lives in the attachment store, keyed by `id`.
 */
export interface ComposerAttachmentAttrs {
  id: string;
  kind: ComposerAttachmentKind;
  label: string;
  mimeType?: string | null;
  size?: number | null;
}

/**
 * Full attachment record held in the store for the duration of a draft.
 * For `pasted-text`, `text` is populated. For image kinds, `dataUrl` is
 * populated when the composing surface supports image payload attachments
 * (currently the overlay input).
 */
export interface ComposerAttachmentRecord {
  id: string;
  kind: ComposerAttachmentKind;
  label: string;
  mimeType?: string;
  size?: number;
  text?: string;
  dataUrl?: string;
}

/**
 * Image attachment shape emitted on submit for overlay-originated image
 * payloads. Structurally compatible with the main-app `StreamImageAttachment`
 * used by the HTTP chat path, and with the `OverlayUserAttachment` used by
 * the overlay WebSocket path.
 */
export interface ComposerImageAttachment {
  id: string;
  kind: 'image';
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface SerializedComposerSubmission {
  text: string;
  attachments: ComposerImageAttachment[];
}
