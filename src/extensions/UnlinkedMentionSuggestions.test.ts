import { describe, expect, test } from 'bun:test';

import { buildUnlinkedMentionDecorationAttributes } from './UnlinkedMentionSuggestions';

describe('UnlinkedMentionSuggestions', () => {
  test('stores document positions in decoration attributes', () => {
    const attributes = buildUnlinkedMentionDecorationAttributes(
      {
        from: 4,
        to: 10,
        text: 'OpenAI',
        targetPath: '/workspace/wiki/OpenAI.md',
        targetLabel: 'OpenAI',
        targetRelativePath: 'wiki/OpenAI.md',
        targetWikilink: 'wiki/OpenAI',
        ignoreKey: '/workspace/wiki/OpenAI.md::openai',
      },
      { from: 32, to: 38 },
    );

    expect(attributes['data-from']).toBe('32');
    expect(attributes['data-to']).toBe('38');
  });
});
