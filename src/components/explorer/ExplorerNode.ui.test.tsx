import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileTreeNode } from './types';
import { ExplorerNode } from './ExplorerNode';

const ipcMocks = vi.hoisted(() => ({
  showContextMenu: vi.fn(async () => undefined as string | undefined),
  showItemInFolder: vi.fn(async () => undefined),
  showItemsInFolder: vi.fn(async () => undefined),
  isUnpackagedElectron: vi.fn(() => false),
  filePathToUri: vi.fn((targetPath: string) => `file://${targetPath}`),
  pathBasename: vi.fn((targetPath: string) => {
    const segments = targetPath.split(/[\\/]/);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i]) return segments[i];
    }
    return targetPath;
  }),
  pathJoin: vi.fn((...segments: string[]) => segments.filter(Boolean).join('/').replace(/\/+/g, '/')),
  pathDirname: vi.fn((targetPath: string) => {
    const normalized = targetPath.replace(/\/+$/, '');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.slice(0, lastSlash) : '/';
  }),
  projectRunnerListeners: new Set<(event: { state: any }) => void>(),
  files: {
    create: vi.fn(async () => ({ success: true, path: '/workspace/new.md' })),
    createFolder: vi.fn(async () => ({ success: true, path: '/workspace/new-folder' })),
    trash: vi.fn(async () => ({ success: true })),
    duplicate: vi.fn(async () => ({ success: true })),
  },
  projectRunner: {
    start: vi.fn(async (projectPath: string) => ({
      success: true,
      state: {
        projectPath,
        status: 'running',
        url: 'http://127.0.0.1:43800',
      },
    })),
    stop: vi.fn(async (projectPath: string) => ({
      success: true,
      state: {
        projectPath,
        status: 'stopped',
      },
    })),
    getStatus: vi.fn(async (projectPath: string) => ({
      success: true,
      state: {
        projectPath,
        status: 'stopped',
      },
    })),
    onChanged: vi.fn((callback: (event: { state: any }) => void) => {
      ipcMocks.projectRunnerListeners.add(callback);
      return () => ipcMocks.projectRunnerListeners.delete(callback);
    }),
  },
}));

const apiMocks = vi.hoisted(() => ({
  callTool: vi.fn(async () => ({ isError: false })),
}));

const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

const layoutMocks = vi.hoisted(() => ({
  openBrowser: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  showContextMenu: ipcMocks.showContextMenu,
  showItemInFolder: ipcMocks.showItemInFolder,
  showItemsInFolder: ipcMocks.showItemsInFolder,
  getRuntimeSystemInfo: () => ({ platform: 'darwin' }),
  isUnpackagedElectron: ipcMocks.isUnpackagedElectron,
  filePathToUri: ipcMocks.filePathToUri,
  pathBasename: ipcMocks.pathBasename,
  pathJoin: ipcMocks.pathJoin,
  pathDirname: ipcMocks.pathDirname,
  files: ipcMocks.files,
  projectRunner: ipcMocks.projectRunner,
}));

vi.mock('@/api', () => ({
  callTool: apiMocks.callTool,
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => toastMocks,
}));

vi.mock('../../hooks/useLayout', () => ({
  useLayoutActions: () => layoutMocks,
}));

vi.mock('../../contexts/HelpContext', () => ({
  getFileHelp: () => ({
    title: 'File',
    description: 'File',
    itemType: 'file',
  }),
}));

vi.mock('../../lib/react-arborist/context', () => ({
  useNodesContext: () => ({
    drag: { destinationParentId: null },
  }),
}));

vi.mock('../FileSystemProxy', () => ({
  FileSystemProxy: ({ filename, prefix, className }: { filename: string; prefix?: ReactNode; className?: string }) => (
    <div data-testid="mock-file-system-proxy" className={className}>
      {prefix}
      <span>{filename}</span>
    </div>
  ),
}));

vi.mock('./IndentGuides', () => ({
  IndentGuides: () => null,
}));

interface MockTree {
  selectedNodes: MockNode[];
  hasNoSelection: boolean;
  select: ReturnType<typeof vi.fn>;
}

interface MockNode {
  id: string;
  data: FileTreeNode;
  level: number;
  isOpen: boolean;
  isSelected: boolean;
  isEditing: boolean;
  isDraggable: boolean;
  parent: null;
  tree: MockTree;
  select: ReturnType<typeof vi.fn>;
  selectMulti: ReturnType<typeof vi.fn>;
  selectContiguous: ReturnType<typeof vi.fn>;
  deselect: ReturnType<typeof vi.fn>;
  toggle: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function createMockTree(): MockTree {
  return {
    selectedNodes: [],
    hasNoSelection: true,
    select: vi.fn(),
  };
}

function createMockNode(
  tree: MockTree,
  {
    name,
    relativePath,
    type = 'file',
    isSelected = false,
    runnableProject,
  }: {
    name: string;
    relativePath: string;
    type?: 'file' | 'directory';
    isSelected?: boolean;
    runnableProject?: FileTreeNode['runnableProject'];
  },
): MockNode {
  const node: MockNode = {
    id: relativePath,
    data: {
      name,
      path: relativePath,
      type,
      runnableProject,
    },
    level: 0,
    isOpen: false,
    isSelected,
    isEditing: false,
    isDraggable: true,
    parent: null,
    tree,
    select: vi.fn(() => {
      tree.selectedNodes = [node];
      tree.hasNoSelection = false;
      node.isSelected = true;
    }),
    selectMulti: vi.fn(() => {
      tree.selectedNodes = [...tree.selectedNodes, node];
      tree.hasNoSelection = false;
      node.isSelected = true;
    }),
    selectContiguous: vi.fn(() => {
      tree.selectedNodes = [node];
      tree.hasNoSelection = false;
      node.isSelected = true;
    }),
    deselect: vi.fn(() => {
      tree.selectedNodes = tree.selectedNodes.filter((candidate) => candidate.id !== node.id);
      tree.hasNoSelection = tree.selectedNodes.length === 0;
      node.isSelected = false;
    }),
    toggle: vi.fn(),
    edit: vi.fn(),
    submit: vi.fn(),
    reset: vi.fn(),
  };
  return node;
}

function setSelectedNodes(tree: MockTree, nodes: MockNode[]) {
  tree.selectedNodes = nodes;
  tree.hasNoSelection = nodes.length === 0;
  nodes.forEach((node) => {
    node.isSelected = true;
  });
}

function renderExplorerNode(
  node: MockNode,
  options?: {
    onAskAgent?: (items: Array<{ path: string; type: 'file' | 'directory'; name: string }>) => void;
  },
) {
  return render(
    <ExplorerNode
      node={node as any}
      tree={node.tree as any}
      style={{}}
      dragHandle={vi.fn()}
      workspacePath="/workspace"
      onFileOpen={vi.fn()}
      onAskAgent={options?.onAskAgent}
      onTreeMutated={vi.fn()}
    />,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'electron', {
    value: {
      projectRunner: {
        start: ipcMocks.projectRunner.start,
        stop: ipcMocks.projectRunner.stop,
        getStatus: ipcMocks.projectRunner.getStatus,
        onChanged: ipcMocks.projectRunner.onChanged,
      },
    },
    configurable: true,
  });
  ipcMocks.showContextMenu.mockReset();
  ipcMocks.showContextMenu.mockResolvedValue(undefined);
  ipcMocks.showItemInFolder.mockReset();
  ipcMocks.showItemsInFolder.mockReset();
  ipcMocks.projectRunnerListeners.clear();
  ipcMocks.projectRunner.start.mockClear();
  ipcMocks.projectRunner.stop.mockClear();
  ipcMocks.projectRunner.getStatus.mockClear();
  ipcMocks.projectRunner.onChanged.mockClear();
  ipcMocks.files.create.mockClear();
  ipcMocks.files.createFolder.mockClear();
  ipcMocks.files.trash.mockClear();
  ipcMocks.files.duplicate.mockClear();
  apiMocks.callTool.mockClear();
  toastMocks.showToast.mockClear();
  layoutMocks.openBrowser.mockClear();
});

describe('ExplorerNode', () => {
  test('cmd-click toggles multi-selection without activating the item', () => {
    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'report.docx',
      relativePath: 'report.docx',
    });

    renderExplorerNode(node);

    fireEvent.click(screen.getByText('report.docx'), { metaKey: true });

    expect(node.selectMulti).toHaveBeenCalledTimes(1);
    expect(node.selectContiguous).not.toHaveBeenCalled();
    expect(node.select).not.toHaveBeenCalled();
  });

  test('shift-click extends the contiguous selection when an anchor already exists', () => {
    const tree = createMockTree();
    tree.hasNoSelection = false;
    const node = createMockNode(tree, {
      name: 'report.docx',
      relativePath: 'report.docx',
    });

    renderExplorerNode(node);

    fireEvent.click(screen.getByText('report.docx'), { shiftKey: true });

    expect(node.selectContiguous).toHaveBeenCalledTimes(1);
    expect(node.select).not.toHaveBeenCalled();
  });

  test('filters the convert submenu down to formats every selected file supports', async () => {
    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'draft.docx',
      relativePath: 'draft.docx',
      isSelected: true,
    });
    const otherNode = createMockNode(tree, {
      name: 'slides.pptx',
      relativePath: 'slides.pptx',
      isSelected: true,
    });
    setSelectedNodes(tree, [node, otherNode]);

    renderExplorerNode(node);
    fireEvent.contextMenu(screen.getByText('draft.docx'));

    await waitFor(() => {
      expect(ipcMocks.showContextMenu).toHaveBeenCalledTimes(1);
    });

    const menuCalls = ipcMocks.showContextMenu.mock.calls as unknown as Array<[unknown]>;
    const menuCall = menuCalls[0];
    expect(menuCall).toBeDefined();
    const items = menuCall[0] as Array<{
      label: string;
      submenu?: Array<{ label: string }>;
    }>;
    const convertItem = items.find((item) => item.label === 'Convert');

    expect(convertItem?.submenu?.map((item) => item.label)).toEqual(['To .pdf']);
  });

  test('shows every selected item in Finder from the context menu', async () => {
    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'draft.docx',
      relativePath: 'draft.docx',
      isSelected: true,
    });
    const otherNode = createMockNode(tree, {
      name: 'slides.pptx',
      relativePath: 'slides.pptx',
      isSelected: true,
    });
    setSelectedNodes(tree, [node, otherNode]);
    ipcMocks.showContextMenu.mockResolvedValueOnce('show-in-finder');

    renderExplorerNode(node);
    fireEvent.contextMenu(screen.getByText('draft.docx'));

    await waitFor(() => {
      expect(ipcMocks.showItemsInFolder).toHaveBeenCalledTimes(1);
    });

    expect(ipcMocks.showItemsInFolder).toHaveBeenCalledWith([
      '/workspace/draft.docx',
      '/workspace/slides.pptx',
    ]);
  });

  test('passes the full selection to Ask Agent from the context menu', async () => {
    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'draft.docx',
      relativePath: 'draft.docx',
      isSelected: true,
    });
    const otherNode = createMockNode(tree, {
      name: 'project-notes',
      relativePath: 'project-notes',
      type: 'directory',
      isSelected: true,
    });
    setSelectedNodes(tree, [node, otherNode]);
    ipcMocks.showContextMenu.mockResolvedValueOnce('ask-agent');
    const onAskAgent = vi.fn();

    renderExplorerNode(node, { onAskAgent });
    fireEvent.contextMenu(screen.getByText('draft.docx'));

    await waitFor(() => {
      expect(onAskAgent).toHaveBeenCalledTimes(1);
    });

    expect(onAskAgent).toHaveBeenCalledWith([
      {
        path: '/workspace/draft.docx',
        type: 'file',
        name: 'draft.docx',
      },
      {
        path: '/workspace/project-notes',
        type: 'directory',
        name: 'project-notes',
      },
    ]);
  });

  test('moves every selected item to the trash from the context menu', async () => {
    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'draft.docx',
      relativePath: 'draft.docx',
      isSelected: true,
    });
    const otherNode = createMockNode(tree, {
      name: 'slides.pptx',
      relativePath: 'slides.pptx',
      isSelected: true,
    });
    setSelectedNodes(tree, [node, otherNode]);
    ipcMocks.showContextMenu.mockResolvedValueOnce('trash');

    renderExplorerNode(node);
    fireEvent.contextMenu(screen.getByText('draft.docx'));

    await waitFor(() => {
      expect(ipcMocks.files.trash).toHaveBeenCalledTimes(2);
    });

    expect(ipcMocks.files.trash).toHaveBeenNthCalledWith(1, '/workspace/draft.docx');
    expect(ipcMocks.files.trash).toHaveBeenNthCalledWith(2, '/workspace/slides.pptx');
  });

  test('right-clicking an unselected item retargets the context menu to that item only', async () => {
    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'draft.docx',
      relativePath: 'draft.docx',
      isSelected: false,
    });
    const previouslySelectedNode = createMockNode(tree, {
      name: 'slides.pptx',
      relativePath: 'slides.pptx',
      isSelected: true,
    });
    setSelectedNodes(tree, [previouslySelectedNode]);

    tree.select.mockImplementation((id: string) => {
      if (id !== node.id) {
        return;
      }
      previouslySelectedNode.isSelected = false;
      tree.selectedNodes = [node];
      tree.hasNoSelection = false;
      node.isSelected = true;
    });
    ipcMocks.showContextMenu.mockResolvedValueOnce('trash');

    renderExplorerNode(node);
    fireEvent.contextMenu(screen.getByText('draft.docx'));

    await waitFor(() => {
      expect(tree.select).toHaveBeenCalledWith(node.id, { focus: false });
      expect(ipcMocks.files.trash).toHaveBeenCalledTimes(1);
    });

    expect(ipcMocks.files.trash).toHaveBeenCalledWith('/workspace/draft.docx');
  });

  test('runs runnable project folders and opens the in-app browser when ready', async () => {
    let resolveStart!: (value: {
      success: boolean;
      state: {
        projectPath: string;
        status: 'running';
        url: string;
      };
    }) => void;

    ipcMocks.projectRunner.start.mockImplementationOnce(() => (
      new Promise<{
        success: boolean;
        state: {
          projectPath: string;
          status: 'running';
          url: string;
        };
      }>((resolve) => {
        resolveStart = resolve;
      })
    ));

    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'graph-app',
      relativePath: 'graph-app',
      type: 'directory',
      runnableProject: {
        kind: 'node-web-app',
        runScript: 'start',
      },
    });

    renderExplorerNode(node);

    await waitFor(() => {
      expect(ipcMocks.projectRunner.getStatus).toHaveBeenCalledWith('/workspace/graph-app');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run graph-app' }));

    expect(ipcMocks.projectRunner.start).toHaveBeenCalledWith('/workspace/graph-app');
    expect(screen.getByRole('button', { name: 'Starting graph-app' })).toBeDisabled();

    resolveStart({
      success: true,
      state: {
        projectPath: '/workspace/graph-app',
        status: 'running',
        url: 'http://127.0.0.1:43800',
      },
    });

    await waitFor(() => {
      expect(layoutMocks.openBrowser).toHaveBeenCalledWith('http://127.0.0.1:43800');
    });
    expect(screen.getByRole('button', { name: 'Stop graph-app' })).toBeInTheDocument();
  });

  test('stops runnable project folders from the row control', async () => {
    ipcMocks.projectRunner.getStatus.mockImplementationOnce(async (projectPath: string) => ({
      success: true,
      state: {
        projectPath,
        status: 'running',
        url: 'http://127.0.0.1:43800',
      },
    }));

    const tree = createMockTree();
    const node = createMockNode(tree, {
      name: 'graph-app',
      relativePath: 'graph-app',
      type: 'directory',
      runnableProject: {
        kind: 'node-web-app',
        runScript: 'start',
      },
    });

    renderExplorerNode(node);

    const stopButton = await screen.findByRole('button', { name: 'Stop graph-app' });
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(ipcMocks.projectRunner.stop).toHaveBeenCalledWith('/workspace/graph-app');
    });
    expect(await screen.findByRole('button', { name: 'Run graph-app' })).toBeInTheDocument();
  });
});
