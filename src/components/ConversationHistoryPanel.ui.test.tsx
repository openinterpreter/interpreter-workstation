import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConversationHistoryPanel } from './ConversationHistoryPanel';

const layoutState = vi.hoisted(() => ({
  current: {
    state: {
      tabs: {},
      tree: {
        kind: 'pane',
        id: 'pane-one',
        tabIds: [],
        activeTabId: null,
      },
      sidebarPane: null,
    },
    closeTab: vi.fn(),
    setActiveTab: vi.fn(),
    setSidebarActiveTab: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setActiveTabRegion: vi.fn(),
    updateTabLabel: vi.fn(),
  },
}));

const translationMocks = vi.hoisted(() => ({
  t: (key: string) => ({
    'common.newAgent': 'New Agent',
    'panel.history.archived': 'Archived',
    'panel.history.hideArchived': 'Hide archived',
    'panel.history.showArchived': 'Show archived',
    'panel.history.loading': 'Loading...',
    'panel.history.noConversations': 'No conversations',
    'panel.history.recent': 'Recent',
    'panel.history.untitled': 'Untitled',
    'help.history.search.title': 'Search conversations',
    'help.history.search.description': 'Find earlier chats by title or preview text.',
  }[key] ?? key),
}));

vi.mock('../hooks/useLayout', () => ({
  useLayout: () => layoutState.current,
}));

vi.mock('../hooks/useAgentActivityMap', () => ({
  useAgentActivityMap: () => new Map(),
}));

vi.mock('../hooks/usePendingApprovalsByAgent', () => ({
  usePendingApprovalsByAgent: () => new Map(),
}));

vi.mock('@/ipc', () => ({
  agentThreads: {
    archiveThread: vi.fn(async () => ({ success: true })),
    deleteAll: vi.fn(async () => ({ success: true })),
    deleteThread: vi.fn(async () => ({ success: true })),
    renameThread: vi.fn(async (_threadId: string, name: string) => ({ success: true, name })),
    unarchiveThread: vi.fn(async () => ({ success: true })),
  },
  getApiUrl: vi.fn(async (path: string) => path),
  showContextMenu: vi.fn(async () => null),
}));

const ipcMock = await import('@/ipc');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translationMocks.t,
  }),
}));

function createThread(id: string, name: string) {
  return {
    id,
    name,
    cwd: '/workspace',
    preview: '',
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
}

function createThreadListResponse(name: string): Response {
  return new Response(JSON.stringify({
    data: [createThread('thread-1', name)],
    nextCursor: null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConversationHistoryPanel refresh behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('keeps_existing_conversations_visible_while_history_refreshes', async () => {
    let resolveRefresh: ((response: Response) => void) | null = null;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createThreadListResponse('Alpha'))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }));

    vi.stubGlobal('fetch', fetchMock);

    render(<ConversationHistoryPanel fillHeight={false} />);

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeVisible();
    });

    act(() => {
      window.dispatchEvent(new Event('conversation-history:refresh'));
    });

    expect(screen.getByText('Alpha')).toBeVisible();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resolveRefresh?.(createThreadListResponse('Beta'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('Beta')).toBeVisible();
    });
  });

  test('includes archived conversations from the context menu', async () => {
    const showContextMenuMock = vi.mocked(ipcMock.showContextMenu);
    showContextMenuMock.mockResolvedValueOnce('include-archived');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createThreadListResponse('Recent thread'))
      .mockResolvedValueOnce(createThreadListResponse('Recent thread'))
      .mockResolvedValueOnce(createThreadListResponse('Archived thread'));

    vi.stubGlobal('fetch', fetchMock);

    render(<ConversationHistoryPanel fillHeight={false} />);

    await waitFor(() => {
      expect(screen.getByText('Recent thread')).toBeVisible();
    });
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId('conversation-history-list'));

    await waitFor(() => {
      expect(showContextMenuMock).toHaveBeenCalled();
    });
    expect(showContextMenuMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Show archived', action: 'include-archived' }),
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText('Archived thread')).toBeVisible();
    });
    expect(screen.getByRole('button', { name: 'Hide archived' })).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/agent/threads?archived=1');
  });
});
