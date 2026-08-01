import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LayoutState, Pane, Tab } from '../../../shared/types/layout';
import { shouldHideSingleAgentTabBar } from './editorAgentState';

const layoutMocks = vi.hoisted(() => ({
  state: null as LayoutState | null,
  closeTab: vi.fn(),
  setActiveTab: vi.fn(),
  setActivePaneId: vi.fn(),
  openNewTab: vi.fn(),
  splitPaneAction: vi.fn(),
  updateSplitRatioAction: vi.fn(),
  updatePaneRect: vi.fn(),
  handleTabDrop: vi.fn(),
  detachTabToNewWindow: vi.fn(),
}));

vi.mock('../../hooks/useLayout', () => ({
  useLayout: () => ({
    state: layoutMocks.state,
    closeTab: layoutMocks.closeTab,
    setActiveTab: layoutMocks.setActiveTab,
    setActivePaneId: layoutMocks.setActivePaneId,
    openNewTab: layoutMocks.openNewTab,
    splitPaneAction: layoutMocks.splitPaneAction,
    updateSplitRatioAction: layoutMocks.updateSplitRatioAction,
    updatePaneRect: layoutMocks.updatePaneRect,
    handleTabDrop: layoutMocks.handleTabDrop,
    detachTabToNewWindow: layoutMocks.detachTabToNewWindow,
  }),
}));

vi.mock('../../hooks/usePendingApprovalsByAgent', () => ({
  usePendingApprovalsByAgent: () => new Map(),
}));

vi.mock('../../hooks/useAgentActivityMap', () => ({
  useAgentActivityMap: () => new Map(),
}));

vi.mock('../../contexts/CommandOverlayContext', () => ({
  useCommandOverlay: () => ({
    isCommandHeld: false,
    activatedKey: null,
  }),
}));

vi.mock('./PaneView', () => ({
  PaneView: () => <div data-testid="mock-pane-view" />,
}));

vi.mock('./SplitView', () => ({
  SplitView: ({ children }: { children: React.ReactNode }) => <div data-testid="mock-split-view">{children}</div>,
}));

vi.mock('@/ipc', () => ({
  getRuntimeSystemInfo: () => ({ platform: 'darwin' }),
  showContextMenu: vi.fn(),
  showItemInFolder: vi.fn(),
}));

function pane(tabIds: string[]): Pane {
  return {
    kind: 'pane',
    id: 'pane-one',
    tabIds,
    activeTabId: tabIds[0] ?? null,
  };
}

function agentTab(id: string): Tab {
  return {
    id,
    type: 'agent',
    label: 'Agent',
    agent: {
      runtime: {
        modelConfig: {
          provider: 'hosted',
          modelId: 'interpreter-smart',
          profileId: 'interpreter',
        },
      },
      session: {
        callerToken: 'agtok_test',
      },
    },
  };
}

function fileTab(id: string): Tab {
  return {
    id,
    type: 'file',
    label: 'notes.md',
    path: '/workspace/notes.md',
  };
}

function layoutStateFor(tabIds: string[], tabs: Record<string, Tab>): LayoutState {
  return {
    version: 6,
    tree: pane(tabIds),
    tabs,
    activePaneId: 'pane-one',
    activeTabRegion: 'main',
    sidebarPane: null,
    sidebarWidth: 360,
    sidebarOpen: false,
    leftSidebar: {
      isOpen: false,
      width: 260,
      activeTab: 'explorer',
    },
    rightSidebar: {
      isOpen: false,
      width: 420,
    },
  };
}

describe('shouldHideSingleAgentTabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutMocks.state = null;
  });

  test('hides the tab bar for a single-pane window with one agent tab', () => {
    expect(shouldHideSingleAgentTabBar({
      pane: pane(['agent-one']),
      tabs: { 'agent-one': agentTab('agent-one') },
      isSinglePane: true,
    })).toBe(true);
  });

  test('keeps the tab bar when there are multiple tabs', () => {
    expect(shouldHideSingleAgentTabBar({
      pane: pane(['agent-one', 'file-one']),
      tabs: {
        'agent-one': agentTab('agent-one'),
        'file-one': fileTab('file-one'),
      },
      isSinglePane: true,
    })).toBe(false);
  });

  test('keeps the tab bar for a single non-agent tab or split pane', () => {
    expect(shouldHideSingleAgentTabBar({
      pane: pane(['file-one']),
      tabs: { 'file-one': fileTab('file-one') },
      isSinglePane: true,
    })).toBe(false);

    expect(shouldHideSingleAgentTabBar({
      pane: pane(['agent-one']),
      tabs: { 'agent-one': agentTab('agent-one') },
      isSinglePane: false,
    })).toBe(false);
  });

  test('omits the pane tab bar in the single-agent editor shell', async () => {
    const agent = agentTab('agent-one');
    layoutMocks.state = layoutStateFor([agent.id], { [agent.id]: agent });
    const { EditorLayout } = await import('./EditorLayout');

    render(<EditorLayout />);

    expect(screen.getByTestId('mock-pane-view')).toBeVisible();
    expect(screen.queryByTestId('pane-tab-bar-pane-one')).not.toBeInTheDocument();
  });
});
