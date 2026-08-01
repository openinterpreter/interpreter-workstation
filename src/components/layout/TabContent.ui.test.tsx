import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Tab } from '../../../shared/types/layout';
import { TabContent } from './TabContent';

const layoutMocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getWorkspace: vi.fn(async () => ({ workspace: '/workspace' })),
}));

const ipcMocks = vi.hoisted(() => ({
  workspace: {
    onChanged: vi.fn(() => () => {}),
  },
  files: {
    isDirectory: vi.fn(async () => ({ isDirectory: false })),
  },
}));

vi.mock('../../hooks/useLayout', () => ({
  useLayoutActions: () => layoutMocks,
}));

vi.mock('../../api', () => apiMocks);

vi.mock('@/ipc', () => ({
  workspace: ipcMocks.workspace,
  files: ipcMocks.files,
  pathDirname: (targetPath: string) => path.dirname(targetPath),
  pathStartsWith: (targetPath: string, basePath: string) => targetPath.startsWith(basePath),
}));

vi.mock('../EditorArea', () => ({
  EditorArea: ({ filePath }: { filePath: string }) => <div data-testid="mock-editor-area">{filePath}</div>,
}));

vi.mock('../BrowserView', () => ({
  BrowserView: () => <div data-testid="mock-browser-view" />,
}));

vi.mock('../EmailView', () => ({
  EmailView: () => <div data-testid="mock-email-view" />,
}));

vi.mock('../ChatView', () => ({
  ChatView: () => <div data-testid="mock-chat-view" />,
}));

vi.mock('../FolderTabView', () => ({
  FolderTabView: () => <div data-testid="mock-folder-tab-view" />,
}));

vi.mock('../GlobalSettings', () => ({
  GlobalSettings: () => <div data-testid="mock-global-settings" />,
}));

vi.mock('./WorkspaceSwitchBanner', () => ({
  WorkspaceSwitchBanner: ({ message, targetWorkspacePath }: { message: string; targetWorkspacePath: string }) => (
    <div>
      <div>{message}</div>
      <div>{targetWorkspacePath}</div>
    </div>
  ),
}));

function createFileTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    type: 'file',
    label: 'notes.txt',
    path: '/workspace/notes.txt',
    ...overrides,
  };
}

describe('TabContent', () => {
  test('renders the editor for an in-workspace file without an outside-workspace banner', async () => {
    render(<TabContent activeTab={createFileTab()} />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-editor-area')).toHaveTextContent('/workspace/notes.txt');
    });

    expect(screen.queryByText('This file is not in the workspace.')).not.toBeInTheDocument();
  });

  test('shows the outside-workspace banner for files opened outside the current workspace', async () => {
    render(
      <TabContent
        activeTab={createFileTab({
          label: 'outside.md',
          path: '/outside/outside.md',
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('This file is not in the workspace.')).toBeVisible();
    });
    expect(screen.getByText('/outside')).toBeVisible();
  });

  test('renders the non-displayable folder state for directory tabs', async () => {
    ipcMocks.files.isDirectory.mockResolvedValueOnce({ isDirectory: true });

    render(
      <TabContent
        activeTab={createFileTab({
          label: 'outside',
          path: '/outside',
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Folder cannot be displayed')).toBeVisible();
    });

    expect(screen.queryByTestId('mock-editor-area')).not.toBeInTheDocument();
  });
});
