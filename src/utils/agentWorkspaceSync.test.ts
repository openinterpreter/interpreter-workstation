import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { getDefaultModelConfig } from '../../shared/types/profile';
import { createConfiguredAgentTab } from './layoutHelpers';
import { syncIdleAgentTabsToWindowWorkspace } from './agentWorkspaceSync';

describe('syncIdleAgentTabsToWindowWorkspace', () => {
  test('adopts the loaded window workspace for untouched idle tabs', () => {
    const tab = createConfiguredAgentTab({
      id: 'agent-1',
      modelConfig: getDefaultModelConfig(),
    });

    const nextTabs = syncIdleAgentTabsToWindowWorkspace({
      tabs: { [tab.id]: tab },
      previousWorkspacePath: null,
      nextWorkspacePath: '/window/workspace',
      getMessageCount: () => 0,
    });

    assert.equal(nextTabs?.[tab.id]?.agent?.runtime.workspacePath, '/window/workspace');
  });

  test('preserves a manual agent workspace selection', () => {
    const tab = createConfiguredAgentTab({
      id: 'agent-1',
      modelConfig: getDefaultModelConfig(),
      workspacePath: '/manual/workspace',
    });

    const nextTabs = syncIdleAgentTabsToWindowWorkspace({
      tabs: { [tab.id]: tab },
      previousWorkspacePath: '/window/workspace',
      nextWorkspacePath: '/next/window',
      getMessageCount: () => 0,
    });

    assert.equal(nextTabs, null);
  });

  test('does not rewrite agents that already have conversation history', () => {
    const tab = createConfiguredAgentTab({
      id: 'agent-1',
      modelConfig: getDefaultModelConfig(),
      conversationId: 'conv-1',
      codexThreadId: 'thread-1',
      workspacePath: '/window/workspace',
    });

    const nextTabs = syncIdleAgentTabsToWindowWorkspace({
      tabs: { [tab.id]: tab },
      previousWorkspacePath: '/window/workspace',
      nextWorkspacePath: '/next/window',
      getMessageCount: () => 2,
    });

    assert.equal(nextTabs, null);
  });

  test('clears followed window workspaces when the window workspace becomes empty', () => {
    const tab = createConfiguredAgentTab({
      id: 'agent-1',
      modelConfig: getDefaultModelConfig(),
      workspacePath: '/window/workspace',
    });

    const nextTabs = syncIdleAgentTabsToWindowWorkspace({
      tabs: { [tab.id]: tab },
      previousWorkspacePath: '/window/workspace',
      nextWorkspacePath: null,
      getMessageCount: () => 0,
    });

    assert.equal(nextTabs?.[tab.id]?.agent?.runtime.workspacePath, undefined);
  });
});
