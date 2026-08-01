import { describe, expect, test } from 'bun:test';

import type { VaultNoteRecord } from '../../shared/types/vault';
import {
  buildUnlinkedMentionCandidates,
  findUnlinkedMentionsInText,
} from './unlinkedMentions';

function createNote(overrides: Partial<VaultNoteRecord> & Pick<VaultNoteRecord, 'path' | 'title' | 'relativePath'>): VaultNoteRecord {
  return {
    path: overrides.path,
    title: overrides.title,
    relativePath: overrides.relativePath,
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    headings: overrides.headings ?? [],
    outgoingLinks: overrides.outgoingLinks ?? [],
    backlinks: overrides.backlinks ?? [],
    brokenLinks: overrides.brokenLinks ?? [],
    modifiedTime: overrides.modifiedTime ?? 0,
  };
}

describe('unlinkedMentions', () => {
  test('builds unique candidates from titles and aliases', () => {
    const candidates = buildUnlinkedMentionCandidates([
      createNote({
        path: '/workspace/wiki/OpenAI.md',
        title: 'OpenAI',
        relativePath: 'wiki/OpenAI.md',
        aliases: ['OpenAI API'],
      }),
      createNote({
        path: '/workspace/wiki/Anthropic.md',
        title: 'Anthropic',
        relativePath: 'wiki/Anthropic.md',
      }),
    ], '/workspace/wiki/Current.md');

    expect(candidates.map((candidate) => candidate.phrase)).toEqual([
      'OpenAI API',
      'Anthropic',
      'OpenAI',
    ]);
    expect(candidates[0]?.targetWikilink).toBe('wiki/OpenAI');
  });

  test('drops ambiguous phrases and matches only high-confidence boundaries', () => {
    const candidates = buildUnlinkedMentionCandidates([
      createNote({
        path: '/workspace/wiki/Project Atlas.md',
        title: 'Project Atlas',
        relativePath: 'wiki/Project Atlas.md',
      }),
      createNote({
        path: '/workspace/wiki/Atlas.md',
        title: 'Atlas',
        relativePath: 'wiki/Atlas.md',
      }),
      createNote({
        path: '/workspace/wiki/React.md',
        title: 'react',
        relativePath: 'wiki/React.md',
      }),
      createNote({
        path: '/workspace/wiki/OpenAI.md',
        title: 'OpenAI',
        relativePath: 'wiki/OpenAI.md',
      }),
      createNote({
        path: '/workspace/wiki/OpenAI Company.md',
        title: 'Company',
        relativePath: 'wiki/OpenAI Company.md',
        aliases: ['OpenAI'],
      }),
    ], '/workspace/wiki/Current.md');

    expect(candidates.some((candidate) => candidate.phrase === 'OpenAI')).toBe(false);

    const matches = findUnlinkedMentionsInText(
      'Project Atlas helps react users. React should stay plain. AtlasBeta should stay plain too.',
      candidates,
    );

    expect(matches).toEqual([
      expect.objectContaining({
        text: 'Project Atlas',
        targetPath: '/workspace/wiki/Project Atlas.md',
      }),
      expect.objectContaining({
        text: 'react',
        targetPath: '/workspace/wiki/React.md',
      }),
    ]);
  });

  test('respects ignored mention keys', () => {
    const candidates = buildUnlinkedMentionCandidates([
      createNote({
        path: '/workspace/wiki/OpenAI.md',
        title: 'OpenAI',
        relativePath: 'wiki/OpenAI.md',
      }),
    ], '/workspace/wiki/Current.md');

    const [openAiCandidate] = candidates;
    const matches = findUnlinkedMentionsInText(
      'OpenAI builds models.',
      candidates,
      new Set([`${openAiCandidate?.targetPath}::openai`]),
    );

    expect(matches).toEqual([]);
  });
});
