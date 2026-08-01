import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';

import { OFFICE_EXTENSION_VIEWER_ID } from '../../shared/element-ids';
import { OfficeExtensionViewer } from './OfficeExtensionViewer';

const ipcMocks = vi.hoisted(() => ({
  clearNativeDropTargetBounds: vi.fn(),
  getRuntimeSystemInfo: vi.fn(() => ({ platform: 'darwin' })),
  pathBasename: vi.fn((targetPath: string) => targetPath.split('/').pop() ?? targetPath),
  setNativeDropTargetBounds: vi.fn(),
  theme: {
    get: vi.fn(async () => ({ theme: 'light' as const })),
    onChanged: vi.fn(() => () => {}),
  },
}));

const refreshMocks = vi.hoisted(() => ({
  trigger: null as null | (() => void),
}));

vi.mock('@/ipc', () => ({
  getRuntimeSystemInfo: ipcMocks.getRuntimeSystemInfo,
  pathBasename: ipcMocks.pathBasename,
  theme: ipcMocks.theme,
}));

vi.mock('../utils/nativeDropTargets', () => ({
  clearNativeDropTargetBounds: ipcMocks.clearNativeDropTargetBounds,
  setNativeDropTargetBounds: ipcMocks.setNativeDropTargetBounds,
}));

vi.mock('../utils/feedback', () => ({
  openFeedbackPopover: vi.fn(),
}));

vi.mock('../hooks/useFileRefresh', () => ({
  useFileRefresh: vi.fn((_filePath: string, handlers: (() => void) | { onAgentRefresh?: () => void; onExternalRefresh?: () => void }) => {
    refreshMocks.trigger = typeof handlers === 'function'
      ? handlers
      : (handlers.onAgentRefresh ?? handlers.onExternalRefresh ?? null);
  }),
}));

type InstallProgressEvent = {
  stage: 'downloading' | 'extracting' | 'configuring' | 'complete' | 'error';
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
};

function createSelectionMessage(filePath = '/workspace/report.xlsx') {
  return {
    type: 'ONLYOFFICE_SELECTION_CHANGED',
    filePath,
    filename: 'report.xlsx',
    doctype: 'spreadsheet',
    timestamp: 1710000000000,
    selection: { kind: 'cell', cell: 'B2', range: 'B2:C4', activeCell: 'B2', sheetIndex: 1, text: 'Revenue' },
  };
}

function dispatchOfficeMessage(data: unknown, options: { source?: MessageEventSource | null; origin?: string } = {}) {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    source: options.source ?? document.querySelector('iframe')?.contentWindow ?? null,
    origin: options.origin ?? 'http://localhost:38123',
  }));
}

async function waitForOfficeIframe() {
  await screen.findByTestId(OFFICE_EXTENSION_VIEWER_ID);

  return await waitFor(() => {
    const iframe = document.querySelector('iframe');
    if (!iframe || !iframe.contentWindow) {
      throw new Error('Office iframe is not ready');
    }
    return iframe;
  });
}

async function waitForOfficeMessageListener(listenerSpy: MockInstance) {
  await waitFor(() => {
    expect(listenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });
}

describe('OfficeExtensionViewer', () => {
  beforeEach(() => {
    refreshMocks.trigger = null;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => 'true',
      })),
    );
  });

  test('rechecks installation and opens the viewer after a background install completes', async () => {
    const checkInstalled = vi.fn()
      .mockResolvedValueOnce({ installed: false })
      .mockResolvedValueOnce({ installed: true });
    const ensureRunning = vi.fn().mockResolvedValue({ success: true });
    const install = vi.fn().mockResolvedValue({ success: true });
    let progressListener: ((event: InstallProgressEvent) => void) | null = null;

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        officeExtension: {
          checkInstalled,
          ensureRunning,
          install,
          onInstallProgress: vi.fn((listener: (event: InstallProgressEvent) => void) => {
            progressListener = listener;
            return () => {
              progressListener = null;
            };
          }),
        },
      },
    });

    render(<OfficeExtensionViewer filePath="/workspace/report.docx" />);

    expect(await screen.findByText('Office extension required')).toBeInTheDocument();
    expect(checkInstalled).toHaveBeenCalledTimes(1);
    expect(ensureRunning).not.toHaveBeenCalled();

    await act(async () => {
      progressListener?.({ stage: 'complete' });
    });

    await waitFor(() => {
      expect(checkInstalled).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(ensureRunning).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId(OFFICE_EXTENSION_VIEWER_ID)).toBeInTheDocument();
  });

  test('remounts the visible office iframe with a cache-busted URL after a file refresh event', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1712700000000);

    const checkInstalled = vi.fn().mockResolvedValue({ installed: true });
    const ensureRunning = vi.fn().mockResolvedValue({ success: true });

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        officeExtension: {
          checkInstalled,
          ensureRunning,
          install: vi.fn(),
          onInstallProgress: vi.fn(() => () => {}),
        },
      },
    });

    try {
      const { container } = render(<OfficeExtensionViewer filePath="/workspace/report.docx" />);

      await waitFor(() => {
        expect(ensureRunning).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByTestId(OFFICE_EXTENSION_VIEWER_ID)).toBeInTheDocument();

      const activeIframe = container.querySelector('iframe[title="report.docx"]') as HTMLIFrameElement | null;
      expect(activeIframe).not.toBeNull();
      expect(activeIframe?.src).toContain('filepath=%2Fworkspace%2Freport.docx');
      expect(activeIframe?.src).not.toContain('&t=');
      expect(refreshMocks.trigger).not.toBeNull();

      await act(async () => {
        refreshMocks.trigger?.();
      });

      await waitFor(() => {
        const nextActiveIframe = container.querySelector('iframe[title="report.docx"]') as HTMLIFrameElement | null;
        expect(nextActiveIframe?.src).toContain('t=1712700000000');
      });
      expect(container.querySelector('iframe[title="report.docx (loading)"]')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('dispatches selection changed events for current office file', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        officeExtension: {
          checkInstalled: vi.fn().mockResolvedValue({ installed: true }),
          ensureRunning: vi.fn().mockResolvedValue({ success: true }),
          install: vi.fn(),
          onInstallProgress: vi.fn(() => () => {}),
        },
      },
    });
    const selections: unknown[] = [];
    const listener = (event: Event) => selections.push((event as CustomEvent).detail);
    window.addEventListener('selection:changed', listener);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    try {
      render(<OfficeExtensionViewer filePath="/workspace/report.xlsx" />);
      const iframe = await waitForOfficeIframe();
      await waitForOfficeMessageListener(addEventListenerSpy);

      dispatchOfficeMessage(createSelectionMessage(), { source: iframe.contentWindow });

      await waitFor(() => {
        expect(selections).toEqual([{ type: 'office', filePath: '/workspace/report.xlsx', filename: 'report.xlsx', doctype: 'spreadsheet', kind: 'cell', cell: 'B2', range: 'B2:C4', activeCell: 'B2', sheetIndex: 1, text: 'Revenue' }]);
      });
    } finally {
      addEventListenerSpy.mockRestore();
      window.removeEventListener('selection:changed', listener);
    }
  });

  test('does not dispatch selection changed events for another office file', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        officeExtension: {
          checkInstalled: vi.fn().mockResolvedValue({ installed: true }),
          ensureRunning: vi.fn().mockResolvedValue({ success: true }),
          install: vi.fn(),
          onInstallProgress: vi.fn(() => () => {}),
        },
      },
    });
    const selections: unknown[] = [];
    const listener = (event: Event) => selections.push((event as CustomEvent).detail);
    window.addEventListener('selection:changed', listener);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    try {
      render(<OfficeExtensionViewer filePath="/workspace/report.xlsx" />);
      const iframe = await waitForOfficeIframe();
      await waitForOfficeMessageListener(addEventListenerSpy);

      dispatchOfficeMessage(createSelectionMessage('/workspace/other.xlsx'), { source: iframe.contentWindow });

      await waitFor(() => {
        expect(selections).toEqual([]);
      });
    } finally {
      addEventListenerSpy.mockRestore();
      window.removeEventListener('selection:changed', listener);
    }
  });

  test('ignores spoofed office selection messages from another source', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        officeExtension: {
          checkInstalled: vi.fn().mockResolvedValue({ installed: true }),
          ensureRunning: vi.fn().mockResolvedValue({ success: true }),
          install: vi.fn(),
          onInstallProgress: vi.fn(() => () => {}),
        },
      },
    });
    const selections: unknown[] = [];
    const listener = (event: Event) => selections.push((event as CustomEvent).detail);
    window.addEventListener('selection:changed', listener);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    try {
      render(<OfficeExtensionViewer filePath="/workspace/report.xlsx" />);
      await waitForOfficeIframe();
      await waitForOfficeMessageListener(addEventListenerSpy);

      dispatchOfficeMessage(createSelectionMessage(), { source: window });

      await waitFor(() => {
        expect(selections).toEqual([]);
      });
    } finally {
      addEventListenerSpy.mockRestore();
      window.removeEventListener('selection:changed', listener);
    }
  });

  test('ignores spoofed office selection messages from another origin', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        officeExtension: {
          checkInstalled: vi.fn().mockResolvedValue({ installed: true }),
          ensureRunning: vi.fn().mockResolvedValue({ success: true }),
          install: vi.fn(),
          onInstallProgress: vi.fn(() => () => {}),
        },
      },
    });
    const selections: unknown[] = [];
    const listener = (event: Event) => selections.push((event as CustomEvent).detail);
    window.addEventListener('selection:changed', listener);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    try {
      render(<OfficeExtensionViewer filePath="/workspace/report.xlsx" />);
      const iframe = await waitForOfficeIframe();
      await waitForOfficeMessageListener(addEventListenerSpy);

      dispatchOfficeMessage(createSelectionMessage(), { source: iframe.contentWindow, origin: 'https://evil.example' });

      await waitFor(() => {
        expect(selections).toEqual([]);
      });
    } finally {
      addEventListenerSpy.mockRestore();
      window.removeEventListener('selection:changed', listener);
    }
  });
});
