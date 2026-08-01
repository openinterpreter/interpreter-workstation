import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserView } from './BrowserView';

const layoutMocks = vi.hoisted(() => ({
  updateBrowserTabLabel: vi.fn(),
}));

const browserIpcMocks = vi.hoisted(() => ({
  create: vi.fn(),
  attach: vi.fn(async () => ({ success: true })),
  detach: vi.fn(),
  setBounds: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  navigate: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  stop: vi.fn(),
  reload: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  getWindowId: vi.fn(async () => 99),
}));

vi.mock('../hooks/useLayout', () => ({
  useLayoutActions: () => layoutMocks,
}));

vi.mock('@/ipc', () => ({
  browser: browserIpcMocks,
  getWindowId: ipcMocks.getWindowId,
}));

vi.mock('../utils/nativeDropTargets', () => ({
  setNativeDropTargetBounds: vi.fn(),
  clearNativeDropTargetBounds: vi.fn(),
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BrowserView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    layoutMocks.updateBrowserTabLabel.mockReset();
    browserIpcMocks.create.mockReset();
    browserIpcMocks.attach.mockReset();
    browserIpcMocks.attach.mockResolvedValue({ success: true });
    browserIpcMocks.detach.mockReset();
    browserIpcMocks.setBounds.mockReset();
    browserIpcMocks.onEvent.mockReset();
    browserIpcMocks.onEvent.mockReturnValue(() => {});
    ipcMocks.getWindowId.mockReset();
    ipcMocks.getWindowId.mockResolvedValue(99);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('attaches to the current window when visible', async () => {
    render(
      <BrowserView
        tabId="tab-attach"
        initialUrl="https://example.com"
        isVisible
      />,
    );

    expect(browserIpcMocks.create).toHaveBeenCalledWith(
      'tab-attach',
      'https://example.com',
      undefined,
      undefined,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    });

    expect(browserIpcMocks.attach).toHaveBeenCalledWith('tab-attach', 99);
  });

  test('calls detach when becoming invisible after attach completes', async () => {
    const { rerender } = render(
      <BrowserView
        tabId="tab-detach"
        initialUrl="https://example.com"
        isVisible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    });

    expect(browserIpcMocks.attach).toHaveBeenCalledWith('tab-detach', 99);
    browserIpcMocks.detach.mockClear();

    rerender(
      <BrowserView
        tabId="tab-detach"
        initialUrl="https://example.com"
        isVisible={false}
      />,
    );

    expect(browserIpcMocks.detach).toHaveBeenCalledWith('tab-detach');
  });

  test('does not attach when getWindowId is pending and visibility flips to false', async () => {
    const deferredWindowId = createDeferred<number>();
    ipcMocks.getWindowId.mockReturnValueOnce(deferredWindowId.promise);

    const { rerender } = render(
      <BrowserView
        tabId="tab-race-getwin"
        initialUrl="https://example.com"
        isVisible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    rerender(
      <BrowserView
        tabId="tab-race-getwin"
        initialUrl="https://example.com"
        isVisible={false}
      />,
    );

    expect(browserIpcMocks.detach).toHaveBeenCalledWith('tab-race-getwin');

    await act(async () => {
      deferredWindowId.resolve(123);
      await Promise.resolve();
    });

    expect(browserIpcMocks.attach).not.toHaveBeenCalled();
  });

  test('detaches stale attach when visibility flips false while attach IPC is in flight', async () => {
    const deferredAttach = createDeferred<{ success: boolean }>();
    browserIpcMocks.attach.mockReturnValueOnce(deferredAttach.promise);

    const { rerender } = render(
      <BrowserView
        tabId="tab-race-attach"
        initialUrl="https://example.com"
        isVisible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
    });

    expect(browserIpcMocks.attach).toHaveBeenCalledWith('tab-race-attach', 99);
    browserIpcMocks.detach.mockClear();

    rerender(
      <BrowserView
        tabId="tab-race-attach"
        initialUrl="https://example.com"
        isVisible={false}
      />,
    );

    expect(browserIpcMocks.detach).toHaveBeenCalledWith('tab-race-attach');

    await act(async () => {
      deferredAttach.resolve({ success: true });
      await Promise.resolve();
    });

    // Post-attach staleness check should trigger a second detach
    expect(browserIpcMocks.detach).toHaveBeenCalledTimes(2);
  });

  test('rapid visible-invisible-visible only attaches once from final state', async () => {
    const { rerender } = render(
      <BrowserView
        tabId="tab-rapid"
        initialUrl="https://example.com"
        isVisible
      />,
    );

    // Toggle invisible then visible before the 100ms timeout fires
    rerender(
      <BrowserView
        tabId="tab-rapid"
        initialUrl="https://example.com"
        isVisible={false}
      />,
    );

    rerender(
      <BrowserView
        tabId="tab-rapid"
        initialUrl="https://example.com"
        isVisible
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    // Only one attach from the final visible state (first timeout was cancelled)
    expect(browserIpcMocks.attach).toHaveBeenCalledTimes(1);
    expect(browserIpcMocks.attach).toHaveBeenCalledWith('tab-rapid', 99);
  });
});
