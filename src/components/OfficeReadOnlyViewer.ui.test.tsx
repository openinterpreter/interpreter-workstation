import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { OFFICE_EXTENSION_VIEWER_ID } from '../../shared/element-ids';
import { OfficeReadOnlyViewer } from './OfficeReadOnlyViewer';

type MockFileViewerProps = {
  file: File;
  onStateChange?: (state: MockViewerState) => void;
  options?: {
    rendererMode?: string;
    styleIsolation?: string;
    renderers?: Array<{ id: string }>;
    toolbar?: {
      download?: boolean;
      exportHtml?: boolean;
      print?: boolean;
      theme?: boolean;
      permissions?: Record<string, boolean>;
    };
  };
};

type MockViewerState = {
  loading: boolean;
  ready: boolean;
  error: unknown | null;
};

const mocks = vi.hoisted(() => ({
  readBinary: vi.fn(),
  pathBasename: vi.fn((value: string) => value.split('/').pop() ?? value),
  refresh: null as null | (() => void),
  renderedFiles: [] as File[],
  viewerProps: null as null | MockFileViewerProps,
}));

vi.mock('@/ipc', () => ({
  files: { readBinary: mocks.readBinary },
  pathBasename: mocks.pathBasename,
}));

vi.mock('../hooks/useFileRefresh', () => ({
  useFileRefresh: vi.fn((_filePath: string, callback: () => void) => {
    mocks.refresh = callback;
  }),
}));

vi.mock('@file-viewer/react', () => ({
  default: (props: MockFileViewerProps) => {
    mocks.renderedFiles.push(props.file);
    mocks.viewerProps = props;
    return <div data-file-viewer-renderer>{props.file.name}</div>;
  },
}));

describe('OfficeReadOnlyViewer', () => {
  beforeEach(() => {
    mocks.readBinary.mockReset();
    mocks.refresh = null;
    mocks.renderedFiles.length = 0;
    mocks.viewerProps = null;
  });

  test.each(['report.docx', 'budget.xlsx', 'slides.pptx', 'legacy.doc', 'notes.rtf', 'open.ods'])(
    'loads %s through the privileged binary-file IPC boundary',
    async (name) => {
      mocks.readBinary.mockResolvedValue({ buffer: new Uint8Array([1, 2, 3]).buffer });

      render(<OfficeReadOnlyViewer filePath={`/workspace/${name}`} />);

      expect(await screen.findByText(name)).toBeInTheDocument();
      expect(mocks.readBinary).toHaveBeenCalledWith(`/workspace/${name}`);
    },
  );

  test('configures an isolated hard read-only viewer', async () => {
    mocks.readBinary.mockResolvedValue({ buffer: new Uint8Array([1, 2, 3]).buffer });

    render(<OfficeReadOnlyViewer filePath="/workspace/report.docx" />);

    await screen.findByText('report.docx');

    expect(mocks.viewerProps?.options).toMatchObject({
      rendererMode: 'replace',
      styleIsolation: 'shadow',
      toolbar: {
        download: false,
        exportHtml: false,
        print: false,
        theme: false,
        permissions: {
          download: false,
          print: false,
          'export-html': false,
        },
      },
    });
    expect(mocks.viewerProps?.options?.renderers?.map((renderer) => renderer.id)).toEqual([
      'file-viewer-renderer-word',
      'file-viewer-renderer-spreadsheet',
      'file-viewer-renderer-presentation-pptx',
    ]);
  });

  test('exposes stable readiness and error signals from the renderer', async () => {
    mocks.readBinary.mockResolvedValue({ buffer: new Uint8Array([1, 2, 3]).buffer });

    render(<OfficeReadOnlyViewer filePath="/workspace/report.docx" />);

    await screen.findByText('report.docx');
    const viewer = screen.getByTestId(OFFICE_EXTENSION_VIEWER_ID);
    expect(viewer).toHaveAttribute('data-office-viewer-state', 'loading');
    expect(viewer).toHaveAttribute('data-office-viewer-ready', 'false');

    await act(async () => {
      mocks.viewerProps?.onStateChange?.({ loading: false, ready: true, error: null });
    });

    expect(screen.getByTestId(OFFICE_EXTENSION_VIEWER_ID)).toHaveAttribute('data-office-viewer-state', 'ready');
    expect(screen.getByTestId(OFFICE_EXTENSION_VIEWER_ID)).toHaveAttribute('data-office-viewer-ready', 'true');

    await act(async () => {
      mocks.viewerProps?.onStateChange?.({ loading: false, ready: false, error: new Error('invalid package') });
    });

    const errorViewer = screen.getByTestId(OFFICE_EXTENSION_VIEWER_ID);
    expect(errorViewer).toHaveAttribute('data-office-viewer-state', 'error');
    expect(errorViewer).toHaveAttribute('data-office-viewer-error', 'true');
    expect(errorViewer).toHaveAttribute('data-office-viewer-ready', 'false');
    expect(screen.getByText('invalid package')).toBeInTheDocument();
  });

  test('offers the optional editor install action without hiding the preview', async () => {
    mocks.readBinary.mockResolvedValue({ buffer: new Uint8Array([1, 2, 3]).buffer });
    const onInstallEditor = vi.fn();

    render(
      <OfficeReadOnlyViewer
        filePath="/workspace/report.docx"
        editingUnavailable
        onInstallEditor={onInstallEditor}
      />,
    );

    expect(await screen.findByText('report.docx')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install oo-editors' }));
    expect(onInstallEditor).toHaveBeenCalledTimes(1);
  });

  test('re-reads and replaces the preview after a file refresh', async () => {
    mocks.readBinary
      .mockResolvedValueOnce({ buffer: new Uint8Array([1]).buffer })
      .mockResolvedValueOnce({ buffer: new Uint8Array([2]).buffer });

    render(<OfficeReadOnlyViewer filePath="/workspace/report.docx" />);
    await screen.findByText('report.docx');

    await act(async () => {
      mocks.refresh?.();
    });

    await waitFor(() => expect(mocks.readBinary).toHaveBeenCalledTimes(2));
    expect(mocks.renderedFiles.length).toBeGreaterThanOrEqual(2);
    expect(mocks.renderedFiles[mocks.renderedFiles.length - 2]).not.toBe(
      mocks.renderedFiles[mocks.renderedFiles.length - 1],
    );
  });

  test('shows a recoverable error when IPC cannot read the document', async () => {
    mocks.readBinary.mockRejectedValue(new Error('permission denied'));

    render(<OfficeReadOnlyViewer filePath="/workspace/report.docx" />);

    expect(await screen.findByText('Unable to preview this file')).toBeInTheDocument();
    expect(screen.getByText('permission denied')).toBeInTheDocument();
  });
});
