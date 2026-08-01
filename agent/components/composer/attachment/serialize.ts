/**
 * Serialize editor JSON + attachment store into a submission payload.
 *
 * Walks the TipTap document in order. Text nodes are concatenated. Hard-break
 * nodes and paragraph boundaries become newlines. Attachment chips are handled
 * by kind:
 *
 * - `pasted-text`: the full text body is inlined where the chip sits, wrapped
 *   in `<pasted-content>` tags so the model can reason about its extent.
 * - `pasted-image` / `file-image`: a short `[image: <label>]` placeholder is
 *   left inline (preserving position) and the full dataUrl is pushed into the
 *   returned `attachments` array as an image attachment. In practice, this
 *   image-payload branch is currently used by the overlay input; the desktop
 *   agent composer normally converts pasted/dropped images into file mentions
 *   instead of emitting image attachments here.
 *
 * The resulting `text` + `attachments` pair is what gets sent over the wire
 * (IPC / WebSocket / HTTP).
 */

import { ATTACHMENT_CHIP_NAME } from './AttachmentChipExtension';
import type {
  AttachmentStore,
} from './attachmentStore';
import type {
  ComposerAttachmentAttrs,
  ComposerImageAttachment,
  SerializedComposerSubmission,
} from './types';
import { serializeSkillMentionToken } from '../../../../shared/utils/skillMentions';

interface TiptapNodeLike {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: TiptapNodeLike[];
  marks?: unknown[];
}

export function serializeEditorWithAttachments(
  doc: TiptapNodeLike,
  store: AttachmentStore,
): SerializedComposerSubmission {
  const attachments: ComposerImageAttachment[] = [];
  const out: string[] = [];

  walk(doc, out, attachments, store, /* depth */ 0);

  // Trim trailing whitespace/newlines but preserve internal structure.
  const text = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, attachments };
}

function walk(
  node: TiptapNodeLike,
  out: string[],
  attachments: ComposerImageAttachment[],
  store: AttachmentStore,
  depth: number,
): void {
  if (!node) return;

  if (node.type === 'text') {
    out.push(node.text ?? '');
    return;
  }

  if (node.type === 'hardBreak') {
    out.push('\n');
    return;
  }

  if (node.type === 'skillMention') {
    const attrs = node.attrs ?? {};
    const id = typeof attrs.id === 'string' ? attrs.id : '';
    const label = typeof attrs.label === 'string' ? attrs.label : '';
    const name = typeof attrs.name === 'string' ? attrs.name : '';
    const path = typeof attrs.path === 'string' ? attrs.path : '';

    if (id && label && name && path) {
      out.push(serializeSkillMentionToken({ id, label, name, path }));
      return;
    }
  }

  if (node.type === 'fileMention') {
    const attrs = node.attrs ?? {};
    const label = typeof attrs.label === 'string' ? attrs.label : '';
    const itemType = typeof attrs.itemType === 'string' ? attrs.itemType : '';
    const id = typeof attrs.id === 'string' ? attrs.id : '';

    if (itemType === 'browser-tab' && label && id) {
      out.push(`[${label}](browser://${id})`);
      return;
    }

    if (label && id) {
      let href = id.replace(/\(/g, '%28').replace(/\)/g, '%29');
      if (typeof attrs.fragment === 'string' && attrs.fragment) {
        href += `#${attrs.fragment}`;
      }
      if (typeof attrs.lineStart === 'number') {
        href += `:L${attrs.lineStart}${typeof attrs.lineEnd === 'number' ? `-L${attrs.lineEnd}` : ''}`;
      }
      out.push(`[${label}](<${href}>)`);
      return;
    }
  }

  if (node.type === ATTACHMENT_CHIP_NAME) {
    const attrs = (node.attrs ?? {}) as unknown as ComposerAttachmentAttrs;
    const record = attrs.id ? store.get(attrs.id) : undefined;
    if (!record) {
      // Record gone (should not normally happen). Fall back to the label.
      out.push(`[attachment: ${attrs.label ?? 'unknown'}]`);
      return;
    }

    if (record.kind === 'pasted-text') {
      const body = record.text ?? '';
      // Surround with newlines so the block reads cleanly inline.
      const prefix = out.length > 0 && !endsWithNewline(out) ? '\n' : '';
      out.push(
        `${prefix}<pasted-content label=${JSON.stringify(record.label)}>\n${body}\n</pasted-content>\n`,
      );
      return;
    }

    if (record.kind === 'pasted-image' || record.kind === 'file-image') {
      if (!record.dataUrl || !record.mimeType) {
        out.push(`[image: ${record.label}]`);
        return;
      }
      attachments.push({
        id: record.id,
        kind: 'image',
        name: record.label,
        mimeType: record.mimeType,
        dataUrl: record.dataUrl,
      });
      out.push(`[image: ${record.label}]`);
      return;
    }

    out.push(`[attachment: ${record.label}]`);
    return;
  }

  // Block boundaries: paragraphs and list items get trailing newlines.
  const children = node.content ?? [];
  const isBlock =
    node.type === 'paragraph'
    || node.type === 'heading'
    || node.type === 'listItem'
    || node.type === 'blockquote'
    || node.type === 'codeBlock';

  for (const child of children) {
    walk(child, out, attachments, store, depth + 1);
  }

  if (isBlock && depth > 0) {
    out.push('\n');
  }
}

function endsWithNewline(out: string[]): boolean {
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const chunk = out[i];
    if (!chunk) continue;
    return chunk.endsWith('\n');
  }
  return true;
}
