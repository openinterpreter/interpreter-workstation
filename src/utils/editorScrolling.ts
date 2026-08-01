/**
 * Editor Scrolling Utilities
 *
 * Helpers for scrolling TipTap editors to specific headings or line ranges,
 * used by the inter-document mention linking system.
 */

import type { Editor } from '@tiptap/core';

/**
 * Convert text to a heading slug (matching standard markdown anchor generation).
 * Lowercase, replace spaces with hyphens, strip non-alphanumeric except hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Scroll a TipTap editor to a heading matching the given slug.
 * Applies a temporary highlight that fades after 3 seconds.
 */
export function scrollToHeading(editor: Editor, slug: string): boolean {
  const { doc } = editor.state;
  let targetPos: number | null = null;
  let targetNodeSize = 0;

  doc.descendants((node, pos) => {
    if (targetPos !== null) return false; // Already found
    if (node.type.name === 'heading') {
      const headingText = node.textContent;
      const headingSlug = slugify(headingText);
      if (headingSlug === slug) {
        targetPos = pos;
        targetNodeSize = node.nodeSize;
        return false;
      }
    }
    return true;
  });

  if (targetPos === null) return false;

  // Set selection to the heading
  editor.commands.setTextSelection({ from: targetPos + 1, to: targetPos + targetNodeSize - 1 });

  // Scroll into view
  const domNode = editor.view.domAtPos(targetPos + 1);
  if (domNode?.node) {
    const element = domNode.node instanceof HTMLElement
      ? domNode.node
      : domNode.node.parentElement;
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Apply temporary highlight
  applyTemporaryHighlight(editor, targetPos + 1, targetPos + targetNodeSize - 1);

  return true;
}

/**
 * Scroll a TipTap editor to approximate line positions.
 * Counts block-level nodes (paragraphs, headings, etc.) as lines.
 */
export function scrollToLine(editor: Editor, startLine: number, endLine?: number): boolean {
  const { doc } = editor.state;
  let currentLine = 0;
  let startPos: number | null = null;
  let endPos: number | null = null;
  const targetEnd = endLine ?? startLine;

  doc.descendants((node, pos) => {
    if (endPos !== null) return false;

    // Count block-level nodes as lines
    if (node.isBlock && node.type.name !== 'doc') {
      currentLine++;
      if (currentLine === startLine && startPos === null) {
        startPos = pos + 1;
      }
      if (currentLine === targetEnd) {
        endPos = pos + node.nodeSize - 1;
      }
    }
    return true;
  });

  if (startPos === null) return false;
  if (endPos === null) endPos = startPos;

  // Set selection
  editor.commands.setTextSelection({ from: startPos, to: endPos });

  // Scroll into view
  const domNode = editor.view.domAtPos(startPos);
  if (domNode?.node) {
    const element = domNode.node instanceof HTMLElement
      ? domNode.node
      : domNode.node.parentElement;
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Apply temporary highlight
  applyTemporaryHighlight(editor, startPos, endPos);

  return true;
}

/**
 * Apply a temporary background highlight that clears after 3 seconds.
 * Uses the editor's selection to create a visual indicator.
 */
function applyTemporaryHighlight(editor: Editor, from: number, to: number) {
  // Use text selection as the highlight indicator — it'll be visible
  editor.commands.setTextSelection({ from, to });

  // Clear after 3 seconds
  setTimeout(() => {
    // Only clear if the selection is still at our range (user hasn't clicked elsewhere)
    const { from: currentFrom, to: currentTo } = editor.state.selection;
    if (currentFrom === from && currentTo === to) {
      editor.commands.setTextSelection(to);
    }
  }, 3000);
}

/**
 * Highlight specific lines in a TipTap editor via CSS classes (non-destructive).
 * Does not scroll or change selection. Returns a cleanup function to remove highlights.
 */
export function highlightLineRange(editor: Editor, startLine: number, endLine?: number): (() => void) | null {
  const { doc } = editor.state;
  let currentLine = 0;
  const targetEnd = endLine ?? startLine;
  const elements: HTMLElement[] = [];

  doc.descendants((node, pos) => {
    if (node.isBlock && node.type.name !== 'doc') {
      currentLine++;
      if (currentLine >= startLine && currentLine <= targetEnd) {
        const domNode = editor.view.nodeDOM(pos);
        if (domNode instanceof HTMLElement) {
          elements.push(domNode);
        }
      }
      if (currentLine > targetEnd) return false;
    }
    return true;
  });

  if (elements.length === 0) return null;

  elements.forEach(el => el.classList.add('mention-hover-highlight'));

  return () => {
    elements.forEach(el => el.classList.remove('mention-hover-highlight'));
  };
}

/**
 * Get the combined bounding rect of DOM elements for a line range.
 * Walks the TipTap doc counting block-level nodes as lines, then computes
 * the union bounding rect of the matching DOM elements.
 */
export function getLineElementsRect(editor: Editor, startLine: number, endLine?: number): DOMRect | null {
  const { doc } = editor.state;
  let currentLine = 0;
  const targetEnd = endLine ?? startLine;
  const rects: DOMRect[] = [];

  doc.descendants((node, pos) => {
    if (node.isBlock && node.type.name !== 'doc') {
      currentLine++;
      if (currentLine >= startLine && currentLine <= targetEnd) {
        const domNode = editor.view.nodeDOM(pos);
        if (domNode instanceof HTMLElement) {
          rects.push(domNode.getBoundingClientRect());
        }
      }
      if (currentLine > targetEnd) return false;
    }
    return true;
  });

  return unionRects(rects);
}

/**
 * Get the bounding rect of a heading matching the given slug.
 */
export function getHeadingElementRect(editor: Editor, slug: string): DOMRect | null {
  const { doc } = editor.state;
  let rect: DOMRect | null = null;

  doc.descendants((node, pos) => {
    if (rect) return false;
    if (node.type.name === 'heading') {
      const headingSlug = slugify(node.textContent);
      if (headingSlug === slug) {
        const domNode = editor.view.nodeDOM(pos);
        if (domNode instanceof HTMLElement) {
          rect = domNode.getBoundingClientRect();
        }
        return false;
      }
    }
    return true;
  });

  return rect;
}

/**
 * Compute the union of an array of DOMRects.
 */
function unionRects(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;

  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;

  for (const r of rects) {
    if (r.top < top) top = r.top;
    if (r.left < left) left = r.left;
    if (r.bottom > bottom) bottom = r.bottom;
    if (r.right > right) right = r.right;
  }

  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Highlight a heading matching the given slug via CSS classes (non-destructive).
 * Does not scroll or change selection. Returns a cleanup function to remove highlight.
 */
export function highlightHeadingRange(editor: Editor, slug: string): (() => void) | null {
  const { doc } = editor.state;
  const elements: HTMLElement[] = [];

  doc.descendants((node, pos) => {
    if (elements.length > 0) return false;
    if (node.type.name === 'heading') {
      const headingSlug = slugify(node.textContent);
      if (headingSlug === slug) {
        const domNode = editor.view.nodeDOM(pos);
        if (domNode instanceof HTMLElement) {
          elements.push(domNode);
        }
        return false;
      }
    }
    return true;
  });

  if (elements.length === 0) return null;

  elements.forEach(el => el.classList.add('mention-hover-highlight'));

  return () => {
    elements.forEach(el => el.classList.remove('mention-hover-highlight'));
  };
}
