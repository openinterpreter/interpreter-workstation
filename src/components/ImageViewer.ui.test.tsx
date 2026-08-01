import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { ImageViewer } from './ImageViewer';

const svgFixture = readFileSync(
  resolve(__dirname, '__fixtures__/sankey-diagram.svg'),
  'utf-8',
);
const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgFixture).toString('base64')}`;

const ipcMocks = vi.hoisted(() => ({
  getFileUrl: vi.fn(async (filePath: string) => `file://${filePath}`),
  pathBasename: vi.fn((filePath: string) => filePath.split('/').pop() ?? filePath),
}));

vi.mock('@/ipc', () => ({
  getFileUrl: ipcMocks.getFileUrl,
  pathBasename: ipcMocks.pathBasename,
}));

vi.mock('../hooks/useFileRefresh', () => ({
  useFileRefresh: vi.fn(),
}));

vi.mock('../utils/feedback', () => ({
  openFeedbackPopover: vi.fn(),
}));

function getSvgIframe() {
  return document.querySelector('iframe[sandbox="allow-same-origin"]') as HTMLIFrameElement | null;
}

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders SVG files in a sandboxed iframe', async () => {
    ipcMocks.getFileUrl.mockResolvedValue(svgDataUrl);

    render(<ImageViewer filePath="/workspace/sankey-diagram.svg" />);

    await waitFor(() => {
      const iframe = getSvgIframe();
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute('src', svgDataUrl);
      expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
      expect(iframe).toHaveAttribute('title', 'sankey-diagram.svg');
    });

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('renders non-SVG files with <img>', async () => {
    render(<ImageViewer filePath="/workspace/photo.png" />);

    const image = await screen.findByRole('img', { name: 'photo.png' });
    expect(image).toHaveAttribute('src', 'file:///workspace/photo.png');
    expect(getSvgIframe()).not.toBeInTheDocument();
  });

  // NOTE(victor): the iframe error listener is attached in useEffect([imageUrl]),
  // which runs asynchronously after paint. Without an explicit act() flush between
  // finding the iframe and dispatching the event, the listener may not be attached
  // yet -- especially on slow CI runners (Windows). See CI run 24816920801.
  test('shows error state when SVG iframe fires an error event', async () => {
    render(<ImageViewer filePath="/workspace/broken.svg" />);

    await waitFor(() => {
      expect(getSvgIframe()).toBeInTheDocument();
    });

    await act(async () => {});
    act(() => { getSvgIframe()!.dispatchEvent(new Event('error')); });

    await waitFor(() => {
      expect(screen.getByText('Unable to load this file')).toBeInTheDocument();
    });
  });

  test('shows error state when SVG contains invalid XML (parsererror)', async () => {
    render(<ImageViewer filePath="/workspace/malformed.svg" />);

    await waitFor(() => {
      expect(getSvgIframe()).toBeInTheDocument();
    });

    await act(async () => {});
    const iframe = getSvgIframe()!;
    const doc = iframe.contentDocument!;
    doc.appendChild(doc.createElement('parsererror'));
    act(() => { iframe.dispatchEvent(new Event('load')); });

    await waitFor(() => {
      expect(screen.getByText('Unable to load this file')).toBeInTheDocument();
    });
  });

  test('shows error state when non-SVG image fails to load', async () => {
    render(<ImageViewer filePath="/workspace/broken.png" />);

    const image = await screen.findByRole('img', { name: 'broken.png' });
    fireEvent.error(image);

    await waitFor(() => {
      expect(screen.getByText('Unable to load this file')).toBeInTheDocument();
    });
  });
});
