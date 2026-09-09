import { Decoration, Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { detectRegex } from '../lib/pii/regex-detector';
import { buildPiiLabelAttributes, findRedactedTokens } from '../lib/pii/labels';

export type PiiLabelMode = 'view' | 'compose';

export interface PiiLabelOptions {
  mode: PiiLabelMode;
}

export interface PiiSpan {
  category: string;
  token: string;
  from: number;
  to: number;
}

/**
 * Find PII spans within a single text node's text, with offsets relative to
 * the start of that text. View mode scans stored `[TYPE_N]` tokens; compose
 * mode runs the structured regex detector for instant feedback.
 */
export function piiSpansForText(text: string, mode: PiiLabelMode): PiiSpan[] {
  if (mode === 'view') {
    return findRedactedTokens(text).map((token) => ({
      category: token.category,
      token: token.token,
      from: token.start,
      to: token.end,
    }));
  }
  return detectRegex(text).map((detection) => ({
    category: detection.category,
    token: detection.text,
    from: detection.start,
    to: detection.end,
  }));
}

function scanRange(
  state: { doc: { nodesBetween: ProseMirrorNode['nodesBetween'] } },
  from: number,
  to: number,
  mode: PiiLabelMode,
): InstanceType<typeof Decoration>[] {
  const decorations: InstanceType<typeof Decoration>[] = [];
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !node.text) return true;
    if (parent?.type.name === 'codeBlock') return true;
    if (node.marks.some((mark) => mark.type.name === 'link' || mark.type.name === 'code')) {
      return true;
    }
    for (const span of piiSpansForText(node.text, mode)) {
      const range = { from: pos + span.from, to: pos + span.to };
      decorations.push(
        Decoration.Inline(
          range.from,
          range.to,
          buildPiiLabelAttributes({ category: span.category, token: span.token }, range),
        ),
      );
    }
    return true;
  });
  return decorations;
}

export const PiiLabel = Extension.create<PiiLabelOptions>({
  name: 'piiLabel',

  addOptions() {
    return { mode: 'compose' };
  },

  addStorage() {
    return {
      refresh: () => {},
    };
  },

  addDecorations() {
    return {
      update: 'changedRanges',
      create: ({ state }) => {
        const decorations: InstanceType<typeof Decoration>[] = [];
        const mode = (this.options as PiiLabelOptions).mode;
        state.doc.nodesBetween(0, state.doc.content.size, (node, pos, parent) => {
          if (!node.isText || !node.text) return true;
          if (parent?.type.name === 'codeBlock') return true;
          if (node.marks.some((mark) => mark.type.name === 'link' || mark.type.name === 'code')) {
            return true;
          }
          for (const span of piiSpansForText(node.text, mode)) {
            const range = { from: pos + span.from, to: pos + span.to };
            decorations.push(
              Decoration.Inline(
                range.from,
                range.to,
                buildPiiLabelAttributes({ category: span.category, token: span.token }, range),
              ),
            );
          }
          return true;
        });
        return decorations;
      },
      createInRange: ({ state, from, to }) => {
        const mode = (this.options as PiiLabelOptions).mode;
        return scanRange(state, from, to, mode);
      },
    };
  },
});
