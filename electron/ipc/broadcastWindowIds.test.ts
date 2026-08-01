import { describe, expect, test } from 'bun:test';

import type { WindowSessionRecord } from '../../server/utils/windowSessions';
import { getBroadcastWindowIds } from './broadcastWindowIds';

type MockWindow = {
  id: number;
  isDestroyed(): boolean;
};

function createSession(
  sessionKey: string,
  windowId: number,
  workspacePath: string | null,
): WindowSessionRecord {
  return {
    sessionKey,
    windowId,
    workspacePath,
    createdAt: 0,
  };
}

function createWindow(id: number, destroyed = false): MockWindow {
  return {
    id,
    isDestroyed: () => destroyed,
  };
}

describe('getBroadcastWindowIds', () => {
  test('targets only session-backed live windows by default', () => {
    const sessions = [
      createSession('main', 2, '/tmp/workspace'),
    ];
    const windows = [
      createWindow(1),
      createWindow(2),
    ];

    expect(getBroadcastWindowIds(undefined, sessions, windows)).toEqual([2]);
  });

  test('filters scoped broadcasts through live session-backed windows', () => {
    const sessions = [
      createSession('main', 2, '/tmp/workspace-a'),
      createSession('secondary', 3, '/tmp/workspace-b'),
      createSession('detached', 4, '/tmp/workspace-b'),
    ];
    const windows = [
      createWindow(2),
      createWindow(3),
      createWindow(4, true),
    ];

    expect(
      getBroadcastWindowIds({ windowSessionKey: 'secondary' }, sessions, windows),
    ).toEqual([3]);
    expect(
      getBroadcastWindowIds({ workspacePath: '/tmp/workspace-b' }, sessions, windows),
    ).toEqual([3]);
  });

  test('keeps explicit null workspace broadcasts scoped to matching sessions', () => {
    const sessions = [
      createSession('null-workspace', 2, null),
      createSession('workspace', 3, '/tmp/workspace'),
    ];
    const windows = [
      createWindow(2),
      createWindow(3),
    ];

    expect(
      getBroadcastWindowIds({ workspacePath: null }, sessions, windows),
    ).toEqual([2]);
  });
});
