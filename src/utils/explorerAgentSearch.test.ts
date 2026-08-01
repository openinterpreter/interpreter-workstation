import { describe, expect, test } from 'bun:test';

import {
  buildExplorerAskAgentPrompt,
  buildExplorerAgentSearchPrompt,
  shouldOfferExplorerAgentSearch,
} from './explorerAgentSearch';

describe('buildExplorerAgentSearchPrompt', () => {
  test('trims surrounding whitespace before building the prompt', () => {
    expect(buildExplorerAgentSearchPrompt('  quarterly roadmap  ')).toBe('Find "quarterly roadmap".');
  });

  test('escapes quotes safely inside the query', () => {
    expect(buildExplorerAgentSearchPrompt('the "golden" doc')).toBe('Find "the \\"golden\\" doc".');
  });
});

describe('buildExplorerAskAgentPrompt', () => {
  test('serializes selected files and folders as composer-ready local mentions', () => {
    expect(buildExplorerAskAgentPrompt([
      {
        path: '/workspace/notes.md',
        name: 'notes.md',
        type: 'file',
      },
      {
        path: '/workspace/archive',
        name: 'archive',
        type: 'directory',
      },
    ])).toBe('[notes.md](/workspace/notes.md) [archive](/workspace/archive/) ');
  });

  test('deduplicates repeated paths while preserving order', () => {
    expect(buildExplorerAskAgentPrompt([
      {
        path: '/workspace/notes.md',
        name: 'notes.md',
        type: 'file',
      },
      {
        path: '/workspace/notes.md',
        name: 'notes copy.md',
        type: 'file',
      },
      {
        path: '/workspace/plan.md',
        name: 'plan.md',
        type: 'file',
      },
    ])).toBe('[notes.md](/workspace/notes.md) [plan.md](/workspace/plan.md) ');
  });
});

describe('shouldOfferExplorerAgentSearch', () => {
  test('returns true for a non-empty query with zero results', () => {
    expect(shouldOfferExplorerAgentSearch('roadmap', 0)).toBe(true);
  });

  test('returns false for blank queries', () => {
    expect(shouldOfferExplorerAgentSearch('   ', 0)).toBe(false);
  });

  test('returns false when search results exist', () => {
    expect(shouldOfferExplorerAgentSearch('roadmap', 2)).toBe(false);
  });
});
