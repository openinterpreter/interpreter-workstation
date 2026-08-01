import { describe, expect, test } from 'bun:test';

import {
  getToolServerCapabilityCount,
  isToolServerAgentAccessible,
  isToolServerAuthRequired,
  isToolServerDisplayConnected,
  resolveRemoteToolServerSetupPhase,
  type RemoteToolServerSetupPhase,
  type ToolServerStateLike,
} from './toolServerAvailability';

describe('toolServerAvailability', () => {
  test('treats oauth-required failures as not connected or agent-accessible', () => {
    const state: ToolServerStateLike = {
      status: 'failed',
      error: 'Waiting for OAuth authorization',
      needsAuth: true,
    };

    expect(isToolServerAuthRequired(state)).toBe(true);
    expect(isToolServerDisplayConnected({ state, isBuiltin: false })).toBe(false);
    expect(isToolServerAgentAccessible(state)).toBe(false);
    expect(resolveRemoteToolServerSetupPhase(state)).toBe('needs-auth');
  });

  test('does not treat remote connected servers with zero capabilities as connected', () => {
    const state: ToolServerStateLike = {
      status: 'connected',
      tools: [],
      resources: [],
      prompts: [],
    };

    expect(getToolServerCapabilityCount(state)).toBe(0);
    expect(isToolServerDisplayConnected({ state, isBuiltin: false })).toBe(false);
    expect(isToolServerAgentAccessible(state)).toBe(false);
    expect(resolveRemoteToolServerSetupPhase(state)).toBe(null);
  });

  test('treats remote servers with non-tool capabilities as connected but not agent-accessible', () => {
    const state: ToolServerStateLike = {
      status: 'connected',
      tools: [],
      resources: [{ uri: 'file://report' }],
      prompts: [],
    };

    expect(getToolServerCapabilityCount(state)).toBe(1);
    expect(isToolServerDisplayConnected({ state, isBuiltin: false })).toBe(true);
    expect(isToolServerAgentAccessible(state)).toBe(false);
    expect(resolveRemoteToolServerSetupPhase(state)).toBe('connected');
  });

  test('treats remote servers with tools as connected and agent-accessible', () => {
    const state: ToolServerStateLike = {
      status: 'connected',
      tools: [{ name: 'query_db' }],
      resources: [],
      prompts: [],
    };

    expect(isToolServerDisplayConnected({ state, isBuiltin: false })).toBe(true);
    expect(isToolServerAgentAccessible(state)).toBe(true);
    expect(resolveRemoteToolServerSetupPhase(state)).toBe('connected');
  });

  test('keeps builtins display-connected even if they do not publish capabilities', () => {
    const state: ToolServerStateLike = {
      status: 'connected',
      tools: [],
      resources: [],
      prompts: [],
    };

    expect(isToolServerDisplayConnected({ state, isBuiltin: true })).toBe(true);
  });
});

type ServerEvent = { servers: Array<{ id: string; state: ToolServerStateLike }> };
type SnapshotFn = () => Promise<ServerEvent | null>;
type OnChangedFn = (cb: (event: ServerEvent) => void) => () => void;

/**
 * Minimal reproduction of the waitForServerStatus pattern from
 * ToolAddonsScreen / ToolSetupStep onboarding screens.
 * subscribe-only: listens to onChanged, never checks getSnapshot.
 */
function waitForServerStatus_subscribeOnly(
  serverId: string,
  ipc: { onChanged: OnChangedFn; getSnapshot: SnapshotFn },
  timeoutMs: number,
): Promise<{ phase: RemoteToolServerSetupPhase | 'timeout' }> {
  void ipc.getSnapshot;
  return new Promise((resolve) => {
    const unsubscribe = ipc.onChanged((event) => {
      const server = event.servers.find((s) => s.id === serverId);
      if (!server) return;
      const phase = resolveRemoteToolServerSetupPhase(server.state);
      if (phase) {
        clearTimeout(timer);
        unsubscribe();
        resolve({ phase });
      }
    });

    const timer = setTimeout(() => {
      unsubscribe();
      resolve({ phase: 'timeout' });
    }, timeoutMs);
  });
}

/**
 * Fixed version: checks snapshot first, then subscribes.
 */
function waitForServerStatus_snapshotThenSubscribe(
  serverId: string,
  ipc: { onChanged: OnChangedFn; getSnapshot: SnapshotFn },
  timeoutMs: number,
): Promise<{ phase: RemoteToolServerSetupPhase | 'timeout' }> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (phase: RemoteToolServerSetupPhase) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ phase });
    };

    const checkServer = (event: ServerEvent) => {
      const server = event.servers.find((s) => s.id === serverId);
      if (!server) return;
      const phase = resolveRemoteToolServerSetupPhase(server.state);
      if (phase) finish(phase);
    };

    const unsubscribe = ipc.onChanged((event) => checkServer(event));

    ipc.getSnapshot().then((snapshot) => {
      if (snapshot) checkServer(snapshot);
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        resolve({ phase: 'timeout' });
      }
    }, timeoutMs);
  });
}

describe('waitForServerStatus race condition', () => {
  function makeIpc(snapshot: ServerEvent | null): {
    onChanged: OnChangedFn;
    getSnapshot: SnapshotFn;
    emit: (event: ServerEvent) => void;
  } {
    const listeners = new Set<(event: ServerEvent) => void>();
    return {
      onChanged: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getSnapshot: async () => snapshot,
      emit: (event) => {
        for (const cb of listeners) cb(event);
      },
    };
  }

  const OAUTH_SERVER_EVENT: ServerEvent = {
    servers: [{
      id: 'github',
      state: { status: 'failed', error: 'OAuth login required', needsAuth: true },
    }],
  };

  test('subscribe-only pattern times out when broadcast fired before subscription (current bug)', async () => {
    const ipc = makeIpc(OAUTH_SERVER_EVENT);
    const result = await waitForServerStatus_subscribeOnly('github', ipc, 50);
    expect(result.phase).toBe('timeout');
  });

  test('snapshot-then-subscribe pattern resolves immediately from snapshot', async () => {
    const ipc = makeIpc(OAUTH_SERVER_EVENT);
    const result = await waitForServerStatus_snapshotThenSubscribe('github', ipc, 50);
    expect(result.phase).toBe('needs-auth');
  });

  test('snapshot-then-subscribe still resolves from live events when snapshot is empty', async () => {
    const ipc = makeIpc(null);
    const promise = waitForServerStatus_snapshotThenSubscribe('github', ipc, 50);
    ipc.emit(OAUTH_SERVER_EVENT);
    const result = await promise;
    expect(result.phase).toBe('needs-auth');
  });
});
