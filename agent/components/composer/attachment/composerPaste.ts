/**
 * Shared paste/drop handlers that create attachmentChip nodes.
 *
 * These handlers are deliberately standalone (not bound to a specific
 * composer) so multiple surfaces can share the same attachment-chip behavior.
 * The overlay uses the image-chip paste/drop paths directly. The desktop
 * agent composer only reuses the text-chip helpers here and intentionally
 * converts pasted or dropped images into file mentions instead.
 */

import type { Editor } from '@tiptap/core';
import type { AttachmentStore } from './attachmentStore';
import { ATTACHMENT_CHIP_NAME } from './AttachmentChipExtension';

export interface PastedContentPolicy {
  /** Text shorter than this and with no newlines is inlined normally. */
  inlineMaxChars: number;
}

export const DEFAULT_PASTE_POLICY: PastedContentPolicy = {
  inlineMaxChars: 280,
};

/**
 * Hard cap on a single pasted/dropped image payload. Data URLs above this
 * size are rejected (too large to send over WS / LLM call reliably).
 */
export const MAX_IMAGE_DATA_URL_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Read a File/Blob as a data URL string.
 */
export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Expected data URL string'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

export function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') lines += 1;
  }
  return lines;
}

export function shouldChipifyPastedText(
  text: string,
  policy: PastedContentPolicy = DEFAULT_PASTE_POLICY,
): boolean {
  if (text.length > policy.inlineMaxChars) return true;
  if (text.includes('\n')) return true;
  return false;
}

export function buildPastedTextLabel(text: string): string {
  const lineCount = countLines(text);
  const charCount = text.length;
  if (lineCount > 1) {
    return `Pasted (${lineCount} lines)`;
  }
  return `Pasted (${charCount} chars)`;
}

function insertAttachmentChip(
  editor: Editor,
  attrs: { id: string; kind: string; label: string; mimeType?: string | null; size?: number | null },
): boolean {
  const schema = editor.state.schema;
  const type = schema.nodes[ATTACHMENT_CHIP_NAME];
  if (!type) return false;
  const node = type.create({
    id: attrs.id,
    kind: attrs.kind,
    label: attrs.label,
    mimeType: attrs.mimeType ?? null,
    size: attrs.size ?? null,
  });
  editor.view.dispatch(editor.state.tr.replaceSelectionWith(node).scrollIntoView());
  return true;
}

/**
 * Handle a paste event, creating attachment chips for images and long text.
 * Returns true if the event was handled (caller should call preventDefault).
 */
export async function handleComposerPaste(
  event: ClipboardEvent,
  editor: Editor,
  store: AttachmentStore,
  options?: {
    policy?: PastedContentPolicy;
    onError?: (message: string) => void;
    onWarn?: (message: string) => void;
  },
): Promise<boolean> {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return false;

  // Image paste path: grab the first image file.
  const items = Array.from(clipboardData.items ?? []);
  const imageItem = items.find(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  );
  const imageFile = imageItem?.getAsFile();
  if (imageFile) {
    event.preventDefault();
    try {
      const dataUrl = await readBlobAsDataUrl(imageFile);
      if (dataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
        options?.onWarn?.('Pasted image is too large (over 10MB) — dropped.');
        return true;
      }
      const label = imageFile.name || suggestImageLabel(imageFile.type);
      const record = store.add('pasted-image', {
        label,
        mimeType: imageFile.type || 'image/png',
        size: imageFile.size,
        dataUrl,
      });
      insertAttachmentChip(editor, {
        id: record.id,
        kind: record.kind,
        label: record.label,
        mimeType: record.mimeType,
        size: record.size,
      });
    } catch (err) {
      options?.onError?.('Failed to read pasted image.');
      console.error('[composerPaste] Failed to read image:', err);
    }
    return true;
  }

  // Text paste path.
  const pastedText = clipboardData.getData('text/plain');
  if (pastedText && shouldChipifyPastedText(pastedText, options?.policy)) {
    event.preventDefault();
    const record = store.add('pasted-text', {
      label: buildPastedTextLabel(pastedText),
      text: pastedText,
      size: pastedText.length,
    });
    insertAttachmentChip(editor, {
      id: record.id,
      kind: record.kind,
      label: record.label,
      size: record.size,
    });
    return true;
  }

  return false;
}

/**
 * Handle a drop event: images become image chips, other files are ignored
 * here (host composer can handle non-image drops differently).
 * Returns true if the event was handled.
 */
export async function handleComposerDrop(
  event: DragEvent,
  editor: Editor,
  store: AttachmentStore,
  options?: {
    onError?: (message: string) => void;
    onWarn?: (message: string) => void;
  },
): Promise<boolean> {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return false;

  const files = Array.from(dataTransfer.files ?? []);
  const imageFiles = files.filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return false;

  event.preventDefault();
  for (const file of imageFiles) {
    try {
      const dataUrl = await readBlobAsDataUrl(file);
      if (dataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
        options?.onWarn?.(`Dropped image "${file.name}" is too large (over 10MB) — dropped.`);
        continue;
      }
      const record = store.add('file-image', {
        label: file.name || suggestImageLabel(file.type),
        mimeType: file.type || 'image/png',
        size: file.size,
        dataUrl,
      });
      insertAttachmentChip(editor, {
        id: record.id,
        kind: record.kind,
        label: record.label,
        mimeType: record.mimeType,
        size: record.size,
      });
    } catch (err) {
      options?.onError?.(`Failed to read dropped image "${file.name}".`);
      console.error('[composerPaste] Failed to read dropped image:', err);
    }
  }
  return true;
}

function suggestImageLabel(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'png';
  return `paste.${ext}`;
}
