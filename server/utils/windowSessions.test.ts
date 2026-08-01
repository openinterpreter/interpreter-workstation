import { afterEach, describe, expect, it } from 'bun:test';
import {
  assignWorkspaceToSessionsWithoutOverride,
  getCurrentWindowSessionKey,
  getWindowIdsForWorkspace,
  getWindowSessionByKey,
  getWindowSessionByWindowId,
  getWindowSessionKeyForWindowId,
  getWindowSessionKeysForWorkspace,
  getWindowSessionWorkspace,
  listWindowSessions,
  registerWindowSession,
  resolveSessionWorkspaceOverride,
  runWithWindowSessionOverride,
  unregisterWindowSession,
  updateWindowSessionWorkspace,
} from './windowSessions';

const registeredWindowIds = new Set<number>();

afterEach(() => {
  for (const windowId of registeredWindowIds) {
    unregisterWindowSession(windowId);
  }
  registeredWindowIds.clear();
});

describe('windowSessions', () => {
  it('registers and updates window session workspace state', () => {
    registerWindowSession({
      sessionKey: 'session-a',
      windowId: 101,
      workspacePath: '/workspace/one',
    });
    registeredWindowIds.add(101);

    expect(getWindowSessionKeyForWindowId(101)).toBe('session-a');
    expect(getWindowSessionByKey('session-a')?.workspacePath).toBe('/workspace/one');
    expect(getWindowSessionByWindowId(101)?.sessionKey).toBe('session-a');
    expect(getWindowSessionWorkspace({ sessionKey: 'session-a' })).toBe('/workspace/one');
    expect(getWindowSessionWorkspace({ windowId: 101 })).toBe('/workspace/one');

    updateWindowSessionWorkspace('session-a', '/workspace/two');

    expect(getWindowSessionByKey('session-a')?.workspacePath).toBe('/workspace/two');
    expect(getWindowSessionWorkspace({ windowId: 101 })).toBe('/workspace/two');
    expect(getWindowSessionKeysForWorkspace('/workspace/two')).toEqual(['session-a']);
    expect(getWindowIdsForWorkspace('/workspace/two')).toEqual([101]);
    expect(listWindowSessions()).toHaveLength(1);
  });

  it('replaces an existing session when a window id is reused', () => {
    registerWindowSession({
      sessionKey: 'session-a',
      windowId: 202,
      workspacePath: '/workspace/one',
    });
    registeredWindowIds.add(202);

    registerWindowSession({
      sessionKey: 'session-b',
      windowId: 202,
      workspacePath: '/workspace/two',
    });

    expect(getWindowSessionByKey('session-a')).toBeNull();
    expect(getWindowSessionKeyForWindowId(202)).toBe('session-b');
    expect(getWindowSessionWorkspace({ windowId: 202 })).toBe('/workspace/two');
    expect(listWindowSessions()).toHaveLength(1);
  });

  it('scopes the current session key with AsyncLocalStorage overrides', async () => {
    expect(getCurrentWindowSessionKey()).toBeNull();

    await runWithWindowSessionOverride('session-scope', async () => {
      expect(getCurrentWindowSessionKey()).toBe('session-scope');
      await Promise.resolve();
      expect(getCurrentWindowSessionKey()).toBe('session-scope');
    });

    expect(getCurrentWindowSessionKey()).toBeNull();
  });

  it('does not create a workspace override for sessionless requests', () => {
    expect(resolveSessionWorkspaceOverride(null)).toBeUndefined();
    expect(resolveSessionWorkspaceOverride(undefined)).toBeUndefined();

    registerWindowSession({
      sessionKey: 'session-c',
      windowId: 303,
      workspacePath: '/workspace/three',
    });
    registeredWindowIds.add(303);

    expect(resolveSessionWorkspaceOverride('session-c')).toBe('/workspace/three');

    updateWindowSessionWorkspace('session-c', null);
    expect(resolveSessionWorkspaceOverride('session-c')).toBeNull();
  });

  it('assigns initialized workspace only to sessions that still have no override', () => {
    registerWindowSession({
      sessionKey: 'session-null',
      windowId: 404,
      workspacePath: null,
    });
    registerWindowSession({
      sessionKey: 'session-explicit',
      windowId: 405,
      workspacePath: '/workspace/explicit',
    });
    registeredWindowIds.add(404);
    registeredWindowIds.add(405);

    const updatedRecords = assignWorkspaceToSessionsWithoutOverride('/workspace/initialized');

    expect(updatedRecords.map((record) => record.sessionKey)).toEqual(['session-null']);
    expect(getWindowSessionByKey('session-null')?.workspacePath).toBe('/workspace/initialized');
    expect(getWindowSessionByKey('session-explicit')?.workspacePath).toBe('/workspace/explicit');
  });
});
