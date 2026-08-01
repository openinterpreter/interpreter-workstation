import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { FileSearchResults } from './FileSearchResults';

vi.mock('../hooks/useFileSearch', () => ({
  useFileSearch: () => ({
    items: [
      { type: 'file', path: '/workspace/alpha.md', name: 'Alpha.md', isOpen: false },
      { type: 'file', path: '/workspace/other.md', name: 'Other.md', isOpen: false },
    ],
  }),
}));

vi.mock('./FileSystemProxy', () => ({
  FileSystemProxy: ({ filename }: { filename: string }) => <div>{`file-proxy-${filename}`}</div>,
}));

describe('FileSearchResults', () => {
  test('renders note-first matches and deduplicates matching file entries', () => {
    render(
      <FileSearchResults
        query="alpha"
        onSelect={() => {}}
        noteMatches={[
          {
            path: '/workspace/alpha.md',
            title: 'Alpha Note',
            relativePath: 'alpha.md',
            aliases: ['Alpha'],
            tags: ['research'],
            score: 99,
          },
        ]}
        onSelectNoteMatch={() => {}}
      />,
    );

    expect(screen.getByText('Notes')).toBeVisible();
    expect(screen.getByText('Alpha Note')).toBeVisible();
    expect(screen.queryByText('file-proxy-Alpha.md')).not.toBeInTheDocument();
    expect(screen.getByText('file-proxy-Other.md')).toBeVisible();
  });

  test('marks the active result row with the rounded search selection treatment', () => {
    render(
      <FileSearchResults
        query="alpha"
        onSelect={() => {}}
        noteMatches={[
          {
            path: '/workspace/alpha.md',
            title: 'Alpha Note',
            relativePath: 'alpha.md',
            aliases: ['Alpha'],
            tags: ['research'],
            score: 99,
          },
        ]}
        onSelectNoteMatch={() => {}}
      />,
    );

    expect(screen.getByText('Alpha Note').closest('[data-selected="true"]')).toHaveClass('file-search-result-row');
  });
});
