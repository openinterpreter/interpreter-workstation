import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type TestEventSource = {
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
};

const connections: Array<{ url: string; options: EventSourceInit; source: TestEventSource }> = [];

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, '', '/');
  delete (window as { electron?: unknown }).electron;
  connections.length = 0;
  vi.stubGlobal('EventSource', class {
    onopen = null;
    onmessage = null;
    onerror = null;
    close = vi.fn();

    constructor(url: string, options: EventSourceInit) {
      connections.push({ url, options, source: this });
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { electron?: unknown }).electron;
  window.history.replaceState(null, '', '/');
});

test('ordinary browser host retains desktop app-server SSE channel delivery and reconnection', async () => {
  const { agentNotifications } = await import('../ipc');
  const onNotification = vi.fn();
  const unsubscribe = agentNotifications.onNotification(onNotification);
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({ url: '/api/events', options: { withCredentials: true } });

  connections[0].source.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify({ channel: 'agentNotifications:notification', data: { method: 'turn/completed' } }),
  }));
  expect(onNotification).toHaveBeenCalledWith({ method: 'turn/completed' });

  vi.useFakeTimers();
  connections[0].source.onerror?.();
  expect(connections[0].source.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(connections).toHaveLength(2);
  expect(connections[1].url).toBe('/api/events');
  unsubscribe();
});

test('restoring browser host reconnects preexisting desktop subscribers without resubscribing', async () => {
  const { agentNotifications, disableBrowserProjectNativeEvents,
    registerBrowserProjectLocalProfile, restoreBrowserProjectNativeEvents } = await import('../ipc');
  const callback = vi.fn();
  const unsubscribe = agentNotifications.onNotification(callback);
  expect(connections).toHaveLength(1);
  disableBrowserProjectNativeEvents();
  registerBrowserProjectLocalProfile('project_restore', 'local_model', 'Local');
  expect(connections[0].source.close).toHaveBeenCalledOnce();
  restoreBrowserProjectNativeEvents('project_restore');
  expect(connections).toHaveLength(2);
  connections[1].source.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify({ channel: 'agentNotifications:notification', data: { method: 'turn/completed' } }),
  }));
  expect(callback).toHaveBeenCalledWith({ method: 'turn/completed' });
  unsubscribe();
});

test('paired Electron remote host retains remote SSE rather than local native preload events', async () => {
  window.history.replaceState(null, '', '/?surface=workstation&endpoint=https%3A%2F%2Fremote.example');
  const nativeSubscribe = vi.fn(() => () => {});
  (window as { electron?: unknown }).electron = {
    agentNotifications: { onNotification: nativeSubscribe },
  };
  const { agentNotifications } = await import('../ipc');
  const callback = vi.fn();
  agentNotifications.onNotification(callback);
  expect(nativeSubscribe).not.toHaveBeenCalled();
  expect(connections[0]?.url).toBe('https://remote.example/api/events');
  connections[0].source.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify({ channel: 'agentNotifications:notification', data: { method: 'thread/started' } }),
  }));
  expect(callback).toHaveBeenCalledWith({ method: 'thread/started' });
});

test('local Electron desktop keeps preload notifications and never opens SSE', async () => {
  const nativeSubscribe = vi.fn(() => () => {});
  (window as { electron?: unknown }).electron = {
    agentNotifications: { onNotification: nativeSubscribe },
  };
  const { agentNotifications, disableBrowserProjectNativeEvents } = await import('../ipc');
  disableBrowserProjectNativeEvents(); // Browser-only gate must not affect local desktop.
  const callback = vi.fn();
  agentNotifications.onNotification(callback);
  expect(nativeSubscribe).toHaveBeenCalledWith(callback);
  expect(connections).toHaveLength(0);
});
