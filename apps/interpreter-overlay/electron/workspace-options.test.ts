import { describe, expect, test } from 'bun:test';

import { buildOverlayOpenWorkspaceOptions } from './workspace-options';

describe('buildOverlayOpenWorkspaceOptions', () => {
  test('preserves window disambiguation when the same workspace is open in multiple windows', () => {
    expect(buildOverlayOpenWorkspaceOptions([
      {
        sessionKey: 'session-a',
        windowId: 11,
        workspacePath: '/workspaces/project-a',
      },
      {
        sessionKey: 'session-b',
        windowId: 27,
        workspacePath: '/workspaces/project-a',
      },
      {
        sessionKey: 'session-c',
        windowId: 42,
        workspacePath: '/workspaces/project-b',
      },
    ])).toEqual([
      {
        sessionKey: 'session-a',
        windowId: 11,
        workspacePath: '/workspaces/project-a',
        workspaceName: 'project-a',
        label: 'project-a (Window 11)',
      },
      {
        sessionKey: 'session-b',
        windowId: 27,
        workspacePath: '/workspaces/project-a',
        workspaceName: 'project-a',
        label: 'project-a (Window 27)',
      },
      {
        sessionKey: 'session-c',
        windowId: 42,
        workspacePath: '/workspaces/project-b',
        workspaceName: 'project-b',
        label: 'project-b',
      },
    ]);
  });
});
