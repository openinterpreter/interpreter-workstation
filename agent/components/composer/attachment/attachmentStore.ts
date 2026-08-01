/**
 * Per-composer in-memory attachment store.
 *
 * Keyed by attachment id (minted here). Holds heavy payload (text body or
 * image data URL) so the TipTap node attrs can stay light.
 *
 * Lifetime: one store per composer instance. The host component owns it and
 * calls `clear()` on submit/reset.
 */

import type {
  ComposerAttachmentKind,
  ComposerAttachmentRecord,
} from './types';

export interface AttachmentStore {
  add(
    kind: ComposerAttachmentKind,
    payload: {
      label: string;
      mimeType?: string;
      size?: number;
      text?: string;
      dataUrl?: string;
    },
  ): ComposerAttachmentRecord;
  get(id: string): ComposerAttachmentRecord | undefined;
  remove(id: string): void;
  clear(): void;
  snapshot(): ComposerAttachmentRecord[];
}

let attachmentIdCounter = 0;

function mintAttachmentId(kind: ComposerAttachmentKind): string {
  attachmentIdCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `att-${kind}-${Date.now().toString(36)}-${attachmentIdCounter}-${random}`;
}

export function createAttachmentStore(): AttachmentStore {
  const records = new Map<string, ComposerAttachmentRecord>();

  return {
    add(kind, payload) {
      const id = mintAttachmentId(kind);
      const record: ComposerAttachmentRecord = {
        id,
        kind,
        label: payload.label,
        mimeType: payload.mimeType,
        size: payload.size,
        text: payload.text,
        dataUrl: payload.dataUrl,
      };
      records.set(id, record);
      return record;
    },
    get(id) {
      return records.get(id);
    },
    remove(id) {
      records.delete(id);
    },
    clear() {
      records.clear();
    },
    snapshot() {
      return Array.from(records.values());
    },
  };
}
