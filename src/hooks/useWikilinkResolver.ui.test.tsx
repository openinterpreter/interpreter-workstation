import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useWikilinkResolver } from './useWikilinkResolver';
import { resolveWikilink } from '../api';

vi.mock('../api', () => ({
  resolveWikilink: vi.fn(),
}));

function TestResolver({ workspacePath }: { workspacePath: string | null }) {
  useWikilinkResolver(workspacePath);
  return null;
}

describe('useWikilinkResolver', () => {
  const openFile = vi.fn();

  beforeEach(() => {
    openFile.mockReset();
    vi.mocked(resolveWikilink).mockReset();
    (window as any).windowingAPI = { openFile };
  });

  afterEach(() => {
    delete (window as any).windowingAPI;
  });

  test('opens a provided resolved path without calling the resolve API', async () => {
    render(<TestResolver workspacePath="/tmp/workspace" />);

    window.dispatchEvent(new CustomEvent('wikilink:open', {
      detail: {
        target: 'Persistent Wiki',
        resolvedPath: '/tmp/workspace/wiki/persistent-wiki.md',
      },
    }));

    await waitFor(() => {
      expect(openFile).toHaveBeenCalledWith('/tmp/workspace/wiki/persistent-wiki.md');
    });
    expect(resolveWikilink).not.toHaveBeenCalled();
  });
});
