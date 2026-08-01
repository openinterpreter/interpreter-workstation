import { describe, expect, test } from 'bun:test';
import type { AgentTabCreateRequestedEvent } from '../../electron/ipc/registry';
import type { LayoutState, Tab } from '../../shared/types/layout';
import { getDefaultModelConfig } from '../../shared/types/profile';
import { findExistingAgentTabIdForCreateRequest } from './useLayoutIpcListeners';

function makeLayoutState(tabs: Record<string, Tab>): LayoutState {
  return {
    version: 1,
    tree: {
      kind: 'pane',
      id: 'pane-1',
      tabIds: Object.keys(tabs),
      activeTabId: Object.keys(tabs)[0] ?? null,
    },
    tabs,
    activePaneId: 'pane-1',
    sidebarPane: null,
    sidebarWidth: 320,
    sidebarOpen: false,
    leftSidebar: {
      isOpen: true,
      width: 240,
      activeTab: 'explorer',
    },
    rightSidebar: {
      isOpen: true,
      width: 360,
    },
  };
}

function makeRequest(agentId: string): AgentTabCreateRequestedEvent {
  return {
    requestId: 'request-1',
    agentId,
    callerToken: 'caller-1',
    timeout: 30_000,
  };
}

describe('findExistingAgentTabIdForCreateRequest', () => {
  test('reuses an existing agent tab instead of replaying the create request', () => {
    const state = makeLayoutState({
      'agent-1': {
        id: 'agent-1',
        type: 'agent',
        label: 'Agent',
        agent: {
          runtime: {
            modelConfig: getDefaultModelConfig(),
          },
          session: {
            callerToken: 'caller-1',
          },
        },
      },
    });

    expect(findExistingAgentTabIdForCreateRequest(state, makeRequest('agent-1'))).toBe('agent-1');
  });

  test('does not reuse non-agent tabs with the same id', () => {
    const state = makeLayoutState({
      'agent-1': {
        id: 'agent-1',
        type: 'file',
        label: 'notes.md',
        path: '/workspace/notes.md',
      },
    });

    expect(findExistingAgentTabIdForCreateRequest(state, makeRequest('agent-1'))).toBeNull();
  });

  test('returns null when the renderer has not created the tab yet', () => {
    const state = makeLayoutState({});
    expect(findExistingAgentTabIdForCreateRequest(state, makeRequest('agent-1'))).toBeNull();
  });
});
