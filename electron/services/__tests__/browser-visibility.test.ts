// Validates that detach() calls setVisible(false) before removeChildView().
// See issue #1060.
import { afterEach, describe, expect, mock, test } from 'bun:test';

const mockViewInstances: MockView[] = [];
const mockWindowRegistry = new Map<number, MockWindow>();
let nextWindowId = 1;

class MockView {
  webContents: Record<string, any>;
  setVisible = mock(() => {});
  setBounds = mock(() => {});
  setBackgroundColor = mock(() => {});

  constructor(_opts?: unknown) {
    this.webContents = {
      on: mock(() => this.webContents),
      once: mock(() => this.webContents),
      setWindowOpenHandler: mock(() => {}),
      loadURL: mock(() => Promise.resolve()),
      canGoBack: () => false,
      canGoForward: () => false,
      getURL: () => '',
      getTitle: () => '',
      close: mock(() => {}),
      isDestroyed: () => false,
    };
    mockViewInstances.push(this);
  }
}

class MockWindow {
  id: number;
  contentView = {
    addChildView: mock(() => {}),
    removeChildView: mock(() => {}),
  };

  constructor(_opts?: unknown) {
    this.id = nextWindowId++;
    mockWindowRegistry.set(this.id, this);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    mockWindowRegistry.delete(this.id);
  }

  static fromId(id: number) {
    return mockWindowRegistry.get(id) ?? null;
  }

  static getAllWindows() {
    return Array.from(mockWindowRegistry.values());
  }
}

mock.module('electron', () => ({
  WebContentsView: MockView,
  BrowserWindow: MockWindow,
  app: {
    isReady: () => true,
    getPath: () => '/tmp/browser-visibility-test',
    once: mock(() => {}),
  },
}));

const { browserService } = await import('../browser');

function lastView(): MockView {
  return mockViewInstances[mockViewInstances.length - 1];
}

describe('BrowserService attach/detach visibility', () => {
  afterEach(() => {
    browserService.closeAll();
  });

  test('attach sets view visible', () => {
    browserService.create('tab-a', 'https://example.com');
    const view = lastView();
    const win = new MockWindow();

    browserService.attach('tab-a', win.id);

    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  test('detach sets view invisible', () => {
    browserService.create('tab-b', 'https://example.com');
    const view = lastView();
    const win = new MockWindow();

    browserService.attach('tab-b', win.id);
    view.setVisible.mockClear();

    browserService.detach('tab-b');

    expect(view.setVisible).toHaveBeenCalledWith(false);
  });

  test('detach removes view from owning window', () => {
    browserService.create('tab-c', 'https://example.com');
    const win = new MockWindow();

    browserService.attach('tab-c', win.id);

    browserService.detach('tab-c');

    expect(win.contentView.removeChildView).toHaveBeenCalled();
  });

  test('detach when not attached is a no-op', () => {
    browserService.create('tab-d', 'https://example.com');
    const view = lastView();
    view.setVisible.mockClear();

    browserService.detach('tab-d');

    expect(view.setVisible).not.toHaveBeenCalled();
  });

  test('attach after detach re-enables visibility', () => {
    browserService.create('tab-e', 'https://example.com');
    const view = lastView();
    const win = new MockWindow();

    browserService.attach('tab-e', win.id);
    browserService.detach('tab-e');
    view.setVisible.mockClear();

    browserService.attach('tab-e', win.id);

    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  test('setVisible(false) is called before removeChildView', () => {
    browserService.create('tab-f', 'https://example.com');
    const view = lastView();
    const win = new MockWindow();

    browserService.attach('tab-f', win.id);
    view.setVisible.mockClear();
    win.contentView.removeChildView.mockClear();

    const callOrder: string[] = [];
    view.setVisible.mockImplementation(() => {
      callOrder.push('setVisible');
    });
    win.contentView.removeChildView.mockImplementation(() => {
      callOrder.push('removeChildView');
    });

    browserService.detach('tab-f');

    expect(callOrder).toEqual(['setVisible', 'removeChildView']);
  });
});
