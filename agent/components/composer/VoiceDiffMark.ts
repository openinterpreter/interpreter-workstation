import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * Temporary mark used to flash newly changed voice tokens in blue.
 */
export const VoiceDiffMark = Mark.create({
  name: 'voiceDiff',
  inclusive: false,

  parseHTML() {
    return [{ tag: 'span[data-voice-diff]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(
        {
          'data-voice-diff': 'true',
          style: 'color: #2563eb;',
        },
        HTMLAttributes,
      ),
      0,
    ];
  },
});

export default VoiceDiffMark;
