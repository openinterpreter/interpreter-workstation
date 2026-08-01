import { describe, expect, test } from 'bun:test';

import {
  extractMarkdownFrontmatter,
  getMarkdownBodyLineOffset,
  mapMarkdownSourceLineRangeToBody,
  serializeMarkdownWithFrontmatter,
} from './markdownFrontmatter';

describe('markdownFrontmatter', () => {
  test('extracts YAML frontmatter and preserves the original raw block', () => {
    const markdown = `---
title: Persistent Wiki
type: concept
sources: [raw/llm-wiki.md]
tags:
  - concept
  - knowledge-base
---

# Persistent Wiki
`;

    const parsed = extractMarkdownFrontmatter(markdown);

    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.frontmatter?.data).toEqual({
      title: 'Persistent Wiki',
      type: 'concept',
      sources: ['raw/llm-wiki.md'],
      tags: ['concept', 'knowledge-base'],
    });
    expect(parsed.frontmatter?.rawBlock).toBe(`---
title: Persistent Wiki
type: concept
sources: [raw/llm-wiki.md]
tags:
  - concept
  - knowledge-base
---`);
    expect(parsed.frontmatter?.bodyPrefix).toBe('\n\n');
    expect(parsed.body).toBe('# Persistent Wiki\n');
  });

  test('preserves CRLF body separators when serializing updated rich text', () => {
    const markdown = `---\r
title: Daily Note\r
updated: 2026-04-09\r
---\r
\r
# 2026-04-09\r
`;

    const parsed = extractMarkdownFrontmatter(markdown);
    const serialized = serializeMarkdownWithFrontmatter(
      '# Updated Daily Note\n',
      parsed.frontmatter,
    );

    expect(serialized).toBe(`---\r
title: Daily Note\r
updated: 2026-04-09\r
---\r
\r
# Updated Daily Note\n`);
  });

  test('extracts multiline YAML block scalars from frontmatter', () => {
    const markdown = `---
summary: |
  First line
  Second line
description: >-
  Wrapped
  paragraph

  next paragraph
---

# Body
`;

    const parsed = extractMarkdownFrontmatter(markdown);

    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.frontmatter?.data).toEqual({
      summary: 'First line\nSecond line\n',
      description: 'Wrapped paragraph\n\nnext paragraph',
    });
    expect(parsed.body).toBe('# Body\n');
  });

  test('leaves markdown unchanged when the YAML block is invalid or incomplete', () => {
    const invalidYamlMarkdown = `---
tags: [concept
---

# Body
`;
    const incompleteMarkdown = `---
title: Missing close

# Body
`;

    expect(extractMarkdownFrontmatter(invalidYamlMarkdown)).toEqual({
      body: invalidYamlMarkdown,
      frontmatter: null,
    });
    expect(extractMarkdownFrontmatter(incompleteMarkdown)).toEqual({
      body: incompleteMarkdown,
      frontmatter: null,
    });
    expect(serializeMarkdownWithFrontmatter('# Body\n', null)).toBe('# Body\n');
  });

  test('computes the body line offset for frontmatter-backed notes', () => {
    const markdown = `---
title: Persistent Wiki
type: concept
---

# Persistent Wiki
Body
`;

    const parsed = extractMarkdownFrontmatter(markdown);

    expect(getMarkdownBodyLineOffset(parsed.frontmatter)).toBe(6);
    expect(mapMarkdownSourceLineRangeToBody(parsed.frontmatter, 6)).toEqual({
      region: 'frontmatter',
    });
    expect(mapMarkdownSourceLineRangeToBody(parsed.frontmatter, 7)).toEqual({
      region: 'body',
      lineStart: 1,
      lineEnd: 1,
    });
    expect(mapMarkdownSourceLineRangeToBody(parsed.frontmatter, 2)).toEqual({
      region: 'frontmatter',
    });
  });

  test('maps mixed line ranges onto the rendered body when a range crosses frontmatter', () => {
    const markdown = `---
title: Persistent Wiki
---

# Heading
Paragraph
`;

    const parsed = extractMarkdownFrontmatter(markdown);

    expect(mapMarkdownSourceLineRangeToBody(parsed.frontmatter, 3, 6)).toEqual({
      region: 'body',
      lineStart: 1,
      lineEnd: 1,
    });
  });
});
