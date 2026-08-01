import { describe, expect, test } from 'bun:test';

import {
  collapsePastedContentToLabels,
  parsePastedContentSegments,
  tokenizePastedContent,
} from './pastedContent';

describe('parsePastedContentSegments', () => {
  test('extracts pasted-content blocks and preserves surrounding text', () => {
    const input = [
      'before',
      '<pasted-content label="Pasted (2 lines)">',
      'alpha',
      'beta',
      '</pasted-content>',
      'after',
    ].join('\n');

    expect(parsePastedContentSegments(input)).toEqual([
      { type: 'text', text: 'before\n' },
      { type: 'pasted-content', label: 'Pasted (2 lines)', text: 'alpha\nbeta' },
      { type: 'text', text: '\nafter' },
    ]);
  });

  test('leaves malformed pasted-content markup as text', () => {
    const input = '<pasted-content label=oops>\nbody\n</pasted-content>';
    expect(parsePastedContentSegments(input)).toEqual([
      { type: 'text', text: input },
    ]);
  });
});

describe('collapsePastedContentToLabels', () => {
  test('replaces pasted-content bodies with their labels', () => {
    const input = [
      'he said ',
      '<pasted-content label="Pasted (2 lines)">',
      'alpha',
      'beta',
      '</pasted-content>',
      ' mattered',
    ].join('\n');

    expect(collapsePastedContentToLabels(input)).toBe('he said \nPasted (2 lines)\n mattered');
  });
});

describe('tokenizePastedContent', () => {
  test('replaces pasted-content blocks with stable placeholder tokens and records', () => {
    const input = [
      'intro',
      '<pasted-content label="Pasted (2 lines)">',
      'alpha',
      'beta',
      '</pasted-content>',
      'outro',
    ].join('\n');

    const result = tokenizePastedContent(input, 'message:1');
    const recordIds = Object.keys(result.recordsById);
    const tokens = Object.keys(result.tokenToRecordId);

    expect(recordIds).toHaveLength(1);
    expect(tokens).toHaveLength(1);
    expect(result.content).toContain(tokens[0] as string);
    expect(result.recordsById[recordIds[0] as string]).toMatchObject({
      id: recordIds[0],
      kind: 'pasted-text',
      label: 'Pasted (2 lines)',
      text: 'alpha\nbeta',
      size: 10,
    });
    expect(result.tokenToRecordId[tokens[0] as string]).toBe(recordIds[0]);
  });

  test('uses markdown-inert placeholder tokens', () => {
    const input = [
      '"',
      '<pasted-content label="Pasted (2 lines)">',
      'alpha',
      'beta',
      '</pasted-content>',
      '" mattered',
    ].join('\n');

    const result = tokenizePastedContent(input, 'message:1');
    const token = Object.keys(result.tokenToRecordId)[0];

    expect(token).toBeDefined();
    expect(token).toMatch(/^INTERPRETERPASTEDCONTENTTOKEN[a-zA-Z0-9]+TOKEN\d+$/);
    expect(token).not.toMatch(/[_*[\]<>`]/);
  });
});
