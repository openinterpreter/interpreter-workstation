import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { QuestionRequest } from '../../../shared/types/approval';
import { ApprovalSupportContent } from './ApprovalSupportContent';

const browserControlMocks = vi.hoisted(() => ({
  activateTab: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/ipc', () => ({
  browserControl: browserControlMocks,
}));

function makeApproval(context: Record<string, unknown>): QuestionRequest {
  return {
    id: 'approval-card',
    toolName: 'show_permission_card',
    serverId: 'builtin-interpreter',
    questions: [
      {
        question: 'Do you approve this action?',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Deny', value: 'deny' },
        ],
      },
    ],
    context,
    timestamp: Date.now(),
    isSimpleApproval: true,
  };
}

describe('ApprovalSupportContent permissionCard', () => {
  beforeEach(() => {
    browserControlMocks.activateTab.mockClear();
  });

  test('renders schema-only text, list, and safe image blocks', () => {
    render(<ApprovalSupportContent approval={makeApproval({
      permissionCard: {
        version: 1,
        blocks: [
          { type: 'text', text: 'Search results preview' },
          {
            type: 'list',
            items: [
              { icon: '1', label: 'First result', description: 'https://example.com/one' },
              { icon: '2', label: 'Second result', description: 'https://example.com/two' },
            ],
          },
          {
            type: 'image',
            src: 'https://example.com/preview.png',
            alt: 'Preview image',
            description: 'Remote preview image',
          },
        ],
      },
    })} />);

    expect(screen.getByText('Search results preview')).toBeInTheDocument();
    expect(screen.getByText('First result')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/two')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Preview image' })).toHaveAttribute(
      'src',
      'https://example.com/preview.png',
    );
    expect(screen.getByText('Remote preview image')).toBeInTheDocument();
  });

  test('renders browser tab reveal blocks without granting browser permission', () => {
    render(<ApprovalSupportContent approval={makeApproval({
      permissionCard: {
        version: 1,
        blocks: [
          {
            type: 'browser-tab',
            title: 'Checkout',
            url: 'https://shop.example.test/checkout',
            tabRef: 'install:work:chrome-tab:91',
            description: 'Review this tab before allowing the browser action.',
          },
        ],
      },
    })} />);

    expect(screen.getByText('Checkout')).toBeInTheDocument();
    expect(screen.getByText('https://shop.example.test/checkout')).toBeInTheDocument();
    expect(screen.getByText('Review this tab before allowing the browser action.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show tab' }));
    expect(browserControlMocks.activateTab).toHaveBeenCalledWith({ tabRef: 'install:work:chrome-tab:91' });
  });

  test('does not execute html-like text or load unsafe image paths', () => {
    const { container } = render(<ApprovalSupportContent approval={makeApproval({
      permissionCard: {
        version: 1,
        blocks: [
          { type: 'text', text: '<button>do not make a button</button>' },
          {
            type: 'image',
            src: 'file:///Users/example/secret.png',
            localPath: '/Users/example/secret.png',
            description: 'Local preview reference',
          },
          {
            type: 'image',
            src: 'javascript:alert(1)',
            description: 'Unsafe remote preview',
          },
        ],
      },
    })} />);

    expect(screen.getByText('<button>do not make a button</button>')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'do not make a button' })).not.toBeInTheDocument();
    expect(screen.getByText('/Users/example/secret.png')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Local preview reference' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Unsafe remote preview' })).not.toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });

  test('renders parallel search result groups and generated image arrays', () => {
    render(<ApprovalSupportContent approval={makeApproval({
      permissionCard: {
        version: 1,
        blocks: [
          {
            type: 'search-results',
            title: 'Last presidents search preview',
            searches: [
              {
                query: 'latest US president',
                results: [
                  {
                    title: 'Official biography',
                    url: 'https://example.com/president',
                    imageSrc: 'https://example.com/president.png',
                  },
                ],
              },
              {
                query: 'previous US president',
                results: [
                  { title: 'Archive result', url: 'https://example.com/archive' },
                  { title: 'Unsafe result', url: 'http://example.com/not-loaded' },
                ],
              },
            ],
          },
          {
            type: 'image-grid',
            images: [
              {
                src: 'https://example.com/grass-a.png',
                alt: 'Mossy grass option A',
                description: 'Darker mossy grass',
              },
              {
                localPath: '/workspace/assets/grass-b.png',
                fileName: 'grass-b.png',
                description: 'Saved local texture',
              },
              {
                src: 'javascript:alert(1)',
                alt: 'Unsafe generated image',
                description: 'Unsafe generated image',
              },
            ],
          },
        ],
      },
    })} />);

    expect(screen.getByText('Last presidents search preview')).toBeInTheDocument();
    expect(screen.getByText('latest US president')).toBeInTheDocument();
    expect(screen.getByText('Official biography')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/president')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Mossy grass option A' })).toHaveAttribute('src', 'https://example.com/grass-a.png');
    expect(screen.getByText('/workspace/assets/grass-b.png')).toBeInTheDocument();
    expect(screen.getByText('Saved local texture')).toBeInTheDocument();
    expect(screen.queryByText('http://example.com/not-loaded')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Unsafe generated image' })).not.toBeInTheDocument();
  });

  test('drags generated local assets with the shared file drag payload', () => {
    render(<ApprovalSupportContent approval={makeApproval({
      permissionCard: {
        version: 1,
        blocks: [
          {
            type: 'image-grid',
            images: [
              {
                localPath: '/workspace/assets/mossy-grass.png',
                fileName: 'mossy-grass.png',
                description: 'Mossy grass texture',
              },
            ],
          },
        ],
      },
    })} />);

    const asset = screen.getByText('/workspace/assets/mossy-grass.png').closest('figure');
    expect(asset).toHaveAttribute('draggable', 'true');
    expect(asset).toHaveAttribute('data-generated-asset', 'true');

    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
    };
    fireEvent.dragStart(asset!, { dataTransfer });

    expect(dataTransfer.effectAllowed).toBe('copy');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', '/workspace/assets/mossy-grass.png');
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/json', JSON.stringify({
      type: 'file',
      sourceContext: 'unknown',
      filePath: '/workspace/assets/mossy-grass.png',
      fileName: 'mossy-grass.png',
      isDirectory: false,
    }));
  });
});
