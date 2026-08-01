import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { useResolvedWikilink, type ResolvedWikilinkState, resetResolvedWikilinkCacheForTests } from './useResolvedWikilink';
import { resolveWikilink } from '../api';
import { resetFileStoreForTests } from '../stores/fileStore';
import { resetWorkspaceStoreForTests, setWorkspacePathSnapshot } from '../stores/workspaceStore';

vi.mock('../api', () => ({
  resolveWikilink: vi.fn(),
}));

vi.mock('../extensions/wikilinkTargetResolver', () => ({
  resolveWikilinkTarget: (target: string) => ({
    path: '',
    label: target,
    found: false,
  }),
}));

let latestResolvedState: ResolvedWikilinkState | null = null;

function TestResolvedWikilink({ target }: { target: string }) {
  latestResolvedState = useResolvedWikilink(target);
  return null;
}

describe('useResolvedWikilink', () => {
  beforeEach(() => {
    latestResolvedState = null;
    resetResolvedWikilinkCacheForTests();
    resetFileStoreForTests();
    resetWorkspaceStoreForTests();
    setWorkspacePathSnapshot('/workspace');
    vi.mocked(resolveWikilink).mockReset();
  });

  afterEach(() => {
    latestResolvedState = null;
    resetResolvedWikilinkCacheForTests();
    resetFileStoreForTests();
    resetWorkspaceStoreForTests();
  });

  test('does not resolve missing wikilinks during render', () => {
    render(createElement(TestResolvedWikilink, { target: 'Project Notes' }));

    expect(resolveWikilink).not.toHaveBeenCalled();
    expect(latestResolvedState?.isPending).toBe(true);
  });

  test('resolves missing wikilinks on demand and reuses the cached result', async () => {
    vi.mocked(resolveWikilink).mockResolvedValue({ path: '/workspace/wiki/project-notes.md' });

    render(createElement(TestResolvedWikilink, { target: 'Project Notes' }));

    await act(async () => {
      expect(await latestResolvedState?.resolvePath()).toBe('/workspace/wiki/project-notes.md');
    });

    await waitFor(() => {
      expect(latestResolvedState?.found).toBe(true);
    });
    expect(resolveWikilink).toHaveBeenCalledTimes(1);

    await act(async () => {
      expect(await latestResolvedState?.resolvePath()).toBe('/workspace/wiki/project-notes.md');
    });

    expect(resolveWikilink).toHaveBeenCalledTimes(1);
  });
});
