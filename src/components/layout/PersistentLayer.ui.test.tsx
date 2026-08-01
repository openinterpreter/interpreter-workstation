import { act, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, test, vi } from 'vitest';

import {
  AGENT_EMPTY_STATE_PAGE_ID,
  TOP_NOTICE_DISMISS_BUTTON_ID,
} from '../../../shared/element-ids';
import type { LayoutState, Tab } from '../../../shared/types/layout';
import type { AgentModelConfig } from '../../../shared/types/model';
import { PersistentLayer } from './PersistentLayer';

const layoutActions = vi.hoisted(() => ({
  closeTab: vi.fn(),
  setActivePaneId: vi.fn(),
  setActiveTabRegion: vi.fn(),
  updateSidebarTabLabel: vi.fn(),
  updateTab: vi.fn(),
}));

const layoutState = vi.hoisted(() => ({
  current: null as {
    state: LayoutState;
    paneRects: Record<string, { top: number; left: number; width: number; height: number }>;
  } | null,
}));

const settledRevealCalls = vi.hoisted(() => ({
  current: [] as Array<{ blockersReady?: boolean }>,
}));

const conversationHistoryControls = vi.hoisted(() => ({
  onLoadingChange: null as ((loading: boolean) => void) | null,
}));

const agentTabsIpcMock = vi.hoisted(() => ({
  sendRequestedCallback: null as ((event: {
    agentId: string;
    message: string;
    workspacePath?: string | null;
    messageSource?: unknown;
  }) => void) | null,
  stopRequestedCallback: null as ((event: {
    agentId: string;
  }) => void) | null,
  registerThread: vi.fn(async () => undefined),
  onSendRequested: vi.fn((callback: (event: {
    agentId: string;
    message: string;
    workspacePath?: string | null;
    messageSource?: unknown;
  }) => void) => {
    agentTabsIpcMock.sendRequestedCallback = callback;
    return () => {
      if (agentTabsIpcMock.sendRequestedCallback === callback) {
        agentTabsIpcMock.sendRequestedCallback = null;
      }
    };
  }),
  onStopRequested: vi.fn((callback: (event: {
    agentId: string;
  }) => void) => {
    agentTabsIpcMock.stopRequestedCallback = callback;
    return () => {
      if (agentTabsIpcMock.stopRequestedCallback === callback) {
        agentTabsIpcMock.stopRequestedCallback = null;
      }
    };
  }),
}));

function getLatestSettledRevealCall(): { blockersReady?: boolean } | undefined {
  return settledRevealCalls.current[settledRevealCalls.current.length - 1];
}

vi.mock('../../hooks/useLayout', () => ({
  useLayout: () => layoutState.current,
  useLayoutActions: () => layoutActions,
}));

vi.mock('../../../agent/hooks/useTtsPlayback', () => ({
  useTtsPlayback: () => undefined,
}));

vi.mock('../../demo/marketingDemo', () => ({
  isMarketingDemoMode: () => false,
}));

vi.mock('./useSettledReveal', () => ({
  useSettledReveal: (options: { blockersReady?: boolean }) => {
    settledRevealCalls.current.push(options);
    return options.blockersReady ?? true;
  },
}));

vi.mock('../../../agent/contexts/AgentMetadataContext', () => ({
  AgentMetadataProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../agent/contexts/AgentErrorContext', () => ({
  AgentErrorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../agent/components/AgentThread', () => ({
  AgentThread: () => <div data-testid="mock-agent-thread" />,
}));

vi.mock('../../../agent/components/AgentLogo', () => ({
  AgentLogo: () => null,
}));

vi.mock('../../../agent/components/ComposerArea', async () => {
  const React = await import('react');

  return {
    ComposerArea: React.forwardRef(function MockComposerArea(
      props: {
        showSuggestionChips?: boolean;
        topAccessory?: React.ReactNode;
      },
      ref: React.ForwardedRef<{ focus: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({ focus: () => undefined }), []);
      return (
        <div data-testid="mock-composer-stack">
          {props.topAccessory}
          <div
            data-file-drop-surface="composer"
            data-show-suggestion-chips={String(props.showSuggestionChips)}
            data-testid="mock-composer"
          />
        </div>
      );
    }),
  };
});

vi.mock('./AgentEmptyState', () => ({
  AgentEmptyState: () => (
    <div data-testid={AGENT_EMPTY_STATE_PAGE_ID}>
      <button type="button" data-testid={TOP_NOTICE_DISMISS_BUTTON_ID('whats-new')}>
        Dismiss
      </button>
    </div>
  ),
}));

vi.mock('./new-tab/ApprovalsContainer', () => ({
  ApprovalsContainer: () => null,
}));

vi.mock('../../../agent/components/PlanChecklistCard', () => ({
  PlanChecklistCard: () => <div data-testid="mock-plan-checklist" />,
}));

vi.mock('../../../agent/components/composer/SettingsPopover', () => ({
  SettingsPopover: () => null,
}));

vi.mock('../ConversationHistoryPanel', () => ({
  ConversationHistoryPanel: ({ onLoadingChange }: { onLoadingChange?: (loading: boolean) => void }) => {
    conversationHistoryControls.onLoadingChange = onLoadingChange ?? null;
    return <div data-testid="mock-conversation-history" />;
  },
}));

vi.mock('../ui/ProgressiveBlurOverlay', () => ({
  ProgressiveBlurOverlay: () => null,
}));

vi.mock('./TabContent', () => ({
  TabContent: () => null,
}));

vi.mock('../BrowserView', () => ({
  BrowserView: () => null,
}));

vi.mock('../../../agent/components/TerminalView', () => ({
  TerminalView: () => null,
}));

vi.mock('@/ipc', () => ({
  agentTabs: agentTabsIpcMock,
}));

const modelConfig: AgentModelConfig = {
  provider: 'hosted',
  modelId: 'interpreter-smart',
  profileId: 'interpreter',
};

function createAgentTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'agent-one',
    type: 'agent',
    label: 'New Agent',
    agent: {
      runtime: {
        modelConfig,
        workspacePath: '/workspace',
      },
      session: {
        callerToken: 'caller-token',
      },
    },
    ...overrides,
  };
}

function renderPersistentLayer(tab: Tab = createAgentTab()) {
  settledRevealCalls.current = [];
  conversationHistoryControls.onLoadingChange = null;
  agentTabsIpcMock.sendRequestedCallback = null;
  agentTabsIpcMock.stopRequestedCallback = null;
  agentTabsIpcMock.registerThread.mockClear();
  agentTabsIpcMock.onSendRequested.mockClear();
  agentTabsIpcMock.onStopRequested.mockClear();
  layoutState.current = {
    state: {
      version: 1,
      tree: {
        kind: 'pane',
        id: 'pane-one',
        tabIds: [tab.id],
        activeTabId: tab.id,
      },
      tabs: {
        [tab.id]: tab,
      },
      activePaneId: 'pane-one',
      activeTabRegion: 'main',
      sidebarPane: null,
      sidebarWidth: 360,
      sidebarOpen: false,
      leftSidebar: {
        isOpen: true,
        width: 240,
        activeTab: 'explorer',
      },
      rightSidebar: {
        isOpen: false,
        width: 360,
      },
    },
    paneRects: {
      'pane-one': {
        top: 0,
        left: 0,
        width: 900,
        height: 360,
      },
    },
  };

  return render(<PersistentLayer />);
}

function getEmptyStateScrollContainer(): HTMLElement {
  const emptyStateWrapper = screen
    .getByTestId(AGENT_EMPTY_STATE_PAGE_ID)
    .closest('[data-empty-agent-surface]');

  if (!(emptyStateWrapper instanceof HTMLElement) || !(emptyStateWrapper.parentElement instanceof HTMLElement)) {
    throw new Error('Expected mounted editor empty state wrapper');
  }

  return emptyStateWrapper.parentElement;
}

describe('PersistentLayer editor empty state layout', () => {
  test('should_keep_the_top_notice_dismiss_control_reachable_when_the_empty_state_overflows', () => {
    renderPersistentLayer();

    const scrollContainer = getEmptyStateScrollContainer();

    expect(screen.getByTestId(TOP_NOTICE_DISMISS_BUTTON_ID('whats-new'))).toBeVisible();
    expect(scrollContainer.style.justifyContent).toBe('safe center');
    expect(scrollContainer).toHaveClass('overflow-auto');
  });

  test('forwards agent tab send requests to the mounted agent runtime', async () => {
    const sentEvents: unknown[] = [];
    const listener = (event: Event) => {
      sentEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener('agent-runtime:send', listener);

    try {
      renderPersistentLayer();

      expect(agentTabsIpcMock.onSendRequested).toHaveBeenCalledTimes(1);
      expect(agentTabsIpcMock.sendRequestedCallback).not.toBeNull();

      act(() => {
        agentTabsIpcMock.sendRequestedCallback?.({
          agentId: 'agent-one',
          message: 'Continue from the overlay',
          workspacePath: '/workspace',
          messageSource: null,
        });
      });

      expect(sentEvents).toEqual([
        {
          tabId: 'agent-one',
          text: 'Continue from the overlay',
          workspacePath: '/workspace',
          attachments: undefined,
          messageSource: null,
        },
      ]);
    } finally {
      window.removeEventListener('agent-runtime:send', listener);
    }
  });

  test('forwards agent tab stop requests to the mounted agent runtime', async () => {
    const cancelEvents: unknown[] = [];
    const listener = (event: Event) => {
      cancelEvents.push((event as CustomEvent).detail);
    };
    window.addEventListener('agent-runtime:cancel', listener);

    try {
      renderPersistentLayer();

      expect(agentTabsIpcMock.onStopRequested).toHaveBeenCalledTimes(1);
      expect(agentTabsIpcMock.stopRequestedCallback).not.toBeNull();

      act(() => {
        agentTabsIpcMock.stopRequestedCallback?.({
          agentId: 'agent-one',
        });
      });

      expect(cancelEvents).toEqual([
        {
          tabId: 'agent-one',
        },
      ]);
    } finally {
      window.removeEventListener('agent-runtime:cancel', listener);
    }
  });

  test('should_not_keep_safe_centering_after_the_editor_agent_has_messages', async () => {
    renderPersistentLayer();

    const scrollContainer = getEmptyStateScrollContainer();

    window.dispatchEvent(new CustomEvent('persistent-layer:message-count-change', {
      detail: {
        agentId: 'agent-one',
        count: 1,
      },
    }));

    await waitFor(() => {
      expect(scrollContainer.style.justifyContent).toBe('');
    });
    expect(screen.getByTestId('mock-agent-thread')).toBeVisible();
  });

  test('passes_the_visible_plan_into_the_composer_stack_and_hides_suggestion_chips', async () => {
    renderPersistentLayer();

    window.dispatchEvent(new CustomEvent('persistent-layer:message-count-change', {
      detail: {
        agentId: 'agent-one',
        count: 1,
      },
    }));
    window.dispatchEvent(new CustomEvent('persistent-layer:plan-update', {
      detail: {
        agentId: 'agent-one',
        planChecklist: {
          turnId: 'turn-one',
          explanation: 'Plan explanation',
          steps: [
            { step: 'Read the issue', status: 'completed' },
            { step: 'Patch the UI', status: 'inProgress' },
          ],
        },
      },
    }));

    await waitFor(() => {
      expect(screen.getByTestId('mock-plan-checklist')).toBeVisible();
    });
    expect(screen.getByTestId('mock-composer')).toHaveAttribute('data-show-suggestion-chips', 'false');
  });

  test('waits_for_conversation_history_before_revealing_the_empty_agent_surface', async () => {
    renderPersistentLayer();

    expect(screen.getByTestId('mock-conversation-history')).toBeInTheDocument();
    expect(getLatestSettledRevealCall()?.blockersReady).toBe(false);

    act(() => {
      conversationHistoryControls.onLoadingChange?.(false);
    });

    await waitFor(() => {
      expect(getLatestSettledRevealCall()?.blockersReady).toBe(true);
    });
  });

  test('keeps_the_empty_agent_surface_revealed_during_background_history_refreshes', async () => {
    renderPersistentLayer();

    act(() => {
      conversationHistoryControls.onLoadingChange?.(false);
    });

    await waitFor(() => {
      expect(getLatestSettledRevealCall()?.blockersReady).toBe(true);
    });

    act(() => {
      conversationHistoryControls.onLoadingChange?.(true);
    });

    await waitFor(() => {
      expect(getLatestSettledRevealCall()?.blockersReady).toBe(true);
    });
  });
});
