import { describe, expect, test } from 'bun:test';

import { buildSuggestionCards } from './suggestionCards';

describe('buildSuggestionCards', () => {
  test('wiki cards defer query and ingest details to the wiki skill contracts', () => {
    const cards = buildSuggestionCards({
      workspace: {
        path: '/wiki',
        kind: 'wiki',
        hasObsidianFolder: false,
        hasWikiStructure: true,
        hasIndexMd: true,
        hasLogMd: true,
        markdownFileCount: 90,
        pdfFileCount: 0,
        nonMarkdownFileCount: 8,
        sampled: false,
      },
      activity: null,
      hourOfDay: 10,
      availableSkills: [],
    });

    const ingest = cards.find((card) => card.id === 'wiki:ingest-url');
    expect(ingest?.prompt).toContain('Read $wiki-ingest.');
    expect(ingest?.prompt).toContain('use $wiki-bootstrap first');

    const ask = cards.find((card) => card.id === 'wiki:ask');
    expect(ask?.prompt).toContain('Read $wiki-query.');
    expect(ask?.prompt).toContain('Read `index.md` only if it exists');
    expect(ask?.prompt).not.toContain('Read index.md, follow the relevant');
  });

  test('obsidian vault cards offer bootstrap alongside ingest when wiki structure is not established', () => {
    const cards = buildSuggestionCards({
      workspace: {
        path: '/vault',
        kind: 'obsidian-vault',
        hasObsidianFolder: true,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 40,
        pdfFileCount: 0,
        nonMarkdownFileCount: 8,
        sampled: false,
      },
      activity: null,
      hourOfDay: 10,
      availableSkills: [],
    });

    const bootstrap = cards.find((card) => card.id === 'wiki:bootstrap-structure');
    expect(bootstrap?.title).toBe('Set up wiki structure');
    expect(bootstrap?.prompt).toContain('Read $wiki-bootstrap.');
  });

  test('markdown-heavy cards no longer instruct a blind move into raw', () => {
    const cards = buildSuggestionCards({
      workspace: {
        path: '/notes',
        kind: 'markdown-heavy',
        hasObsidianFolder: false,
        hasWikiStructure: false,
        hasIndexMd: false,
        hasLogMd: false,
        markdownFileCount: 42,
        pdfFileCount: 0,
        nonMarkdownFileCount: 4,
        sampled: false,
      },
      activity: null,
      hourOfDay: 10,
      availableSkills: [],
    });

    const bootstrap = cards.find((card) => card.id === 'md:turn-into-wiki');
    expect(bootstrap?.prompt).toContain('bootstrap a durable wiki workflow');
    expect(bootstrap?.prompt).not.toContain('Move the existing notes into raw/');
  });
});
