import { Mark } from '@tiptap/core';

/**
 * A custom TipTap mark for transient animation coloring.
 * Used during the in-editor diff animation to color text red (deletion)
 * or orange (addition) before it is removed or settled.
 *
 * Sets the text COLOR (not background) — e.g. red text, orange text.
 */
export const AnimationHighlight = Mark.create({
  name: 'animationHighlight',

  addAttributes() {
    return {
      color: {
        default: 'orange',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-color') || 'orange',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-color': attributes.color,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-animation-highlight]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const textColor = HTMLAttributes['data-color'] === 'red'
      ? '#ef4444'   // red-500
      : '#f97316';  // orange-500
    return [
      'span',
      {
        'data-animation-highlight': '',
        'data-color': HTMLAttributes['data-color'],
        style: `color: ${textColor};`,
      },
      0,
    ];
  },
});
