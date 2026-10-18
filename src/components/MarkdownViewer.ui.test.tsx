import React, { forwardRef, useImperativeHandle } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { MarkdownViewer } from './MarkdownViewer';

const LARGE_MARKDOWN = `# Large\n\n${'large markdown line\n'.repeat(30_000)}`;

const apiMocks = vi.hoisted(() => ({
  readFile: vi.fn<(filePath: string) => Promise<{ content: string }>>(),
  writeFile: vi.fn<(filePath: string, content: string) => Promise<void>>(),
}));

const ipcMocks = vi.hoisted(() => ({
  showContextMenu: vi.fn(),
  getNoteContext: vi.fn(async () => ({
    workspacePath: '/workspace',
    builtAt: 0,
    noteCount: 0,
    tagCount: 0,
    note: null,
  })),
  getReviewMarkdownEdits: vi.fn(async () => ({ enabled: true })),
  onReviewMarkdownEditsChanged: vi.fn(() => () => {}),
}));

const connectionMocks = vi.hoisted(() => ({
  readOnly: false,
}));

const parserMocks = vi.hoisted(() => ({
  markdownToTiptap: vi.fn((markdown: string) => ({ type: 'doc', text: markdown })),
  tiptapToMarkdown: vi.fn(() => ''),
}));

const refreshMocks = vi.hoisted(() => {
  type RefreshHandlers = {
    onAgentRefresh?: () => void;
    onExternalRefresh?: () => void;
  };

  let handlers: RefreshHandlers | null = null;

  return {
    getHandlers: () => handlers,
    reset: () => {
      handlers = null;
    },
    useFileRefresh: vi.fn((_filePath: string, nextHandlers: RefreshHandlers) => {
      handlers = nextHandlers;
    }),
  };
});

vi.mock('../api', () => apiMocks);

vi.mock('../utils/markdown-parser', () => parserMocks);

vi.mock('@/ipc', () => ({
  showContextMenu: ipcMocks.showContextMenu,
  getFileUrl: vi.fn((filePath: string) => `file://${filePath}`),
  pathBasename: vi.fn((filePath: string) => filePath.split('/').pop() ?? filePath),
  pathDirname: vi.fn((filePath: string) => filePath.slice(0, filePath.lastIndexOf('/')) || '/'),
  pathJoin: vi.fn((...segments: string[]) => segments.join('/')),
  isAbsolutePath: vi.fn((filePath: string) => filePath.startsWith('/')),
  getRuntimeSystemInfo: vi.fn(() => ({ platform: 'darwin' })),
  uiSettings: {
    getReviewMarkdownEdits: ipcMocks.getReviewMarkdownEdits,
    onReviewMarkdownEditsChanged: ipcMocks.onReviewMarkdownEditsChanged,
  },
  vault: {
    getNoteContext: ipcMocks.getNoteContext,
  },
}));

vi.mock('../remote/workstationConnection', () => ({
  isWorkstationReadOnly: () => connectionMocks.readOnly,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

vi.mock('../hooks/useFileRefresh', () => ({
  useFileRefresh: refreshMocks.useFileRefresh,
}));

vi.mock('../utils/feedback', () => ({
  openFeedbackPopover: vi.fn(),
}));

vi.mock('./MarkdownNoteContextCard', () => ({
  MarkdownNoteContextCard: () => null,
}));

vi.mock('./TipTapViewer', () => ({
  TipTapViewer: forwardRef(({ content }: { content: Record<string, unknown> }, ref) => {
    useImperativeHandle(ref, () => ({
      getJSON: () => content,
      getEditor: () => null,
      search: () => [],
      highlightMatch: vi.fn(),
      clearHighlights: vi.fn(),
      focus: vi.fn(),
      toggleBold: vi.fn(),
      toggleItalic: vi.fn(),
      toggleUnderline: vi.fn(),
      toggleStrike: vi.fn(),
      toggleCode: vi.fn(),
      toggleBulletList: vi.fn(),
      toggleOrderedList: vi.fn(),
      toggleTaskList: vi.fn(),
      toggleBlockquote: vi.fn(),
      toggleHeading: vi.fn(),
      insertImage: vi.fn(),
      insertFileLink: vi.fn(),
      insertFileMention: vi.fn(),
      insertLinkedImage: vi.fn(),
      isActive: () => false,
      setEditable: vi.fn(),
      setContentJSON: vi.fn(),
    }));

    return <div data-testid="markdown-content">{JSON.stringify(content)}</div>;
  }),
}));

describe('MarkdownViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMocks.reset();
    connectionMocks.readOnly = false;
  });

  test('renders markdown content without waiting for note context indexing', async () => {
    apiMocks.readFile.mockResolvedValue({ content: '# Ready\n\nBody text' });
    ipcMocks.getNoteContext.mockReturnValue(new Promise(() => {}));

    render(<MarkdownViewer filePath="/workspace/trunk.md" />);

    expect(await screen.findByTestId('markdown-content')).toHaveTextContent('Ready');
    expect(ipcMocks.getNoteContext).toHaveBeenCalledWith({ filePath: '/workspace/trunk.md' });
  });

  test('opens very large markdown in raw mode before formatted parsing', async () => {
    apiMocks.readFile.mockResolvedValue({ content: LARGE_MARKDOWN });

    render(<MarkdownViewer filePath="/workspace/Full-Markdown.md" />);

    const rawEditor = await screen.findByPlaceholderText('markdown.placeholder') as HTMLTextAreaElement;
    expect(rawEditor.value).toHaveLength(LARGE_MARKDOWN.length);
    expect(parserMocks.markdownToTiptap).not.toHaveBeenCalled();
    expect(ipcMocks.getNoteContext).toHaveBeenCalledWith({ filePath: '/workspace/Full-Markdown.md' });
  });

  test('keeps unsaved large raw edits during a self-save refresh', async () => {
    const editedMarkdown = `${LARGE_MARKDOWN}\nunsaved`;
    apiMocks.readFile.mockResolvedValue({ content: LARGE_MARKDOWN });

    render(<MarkdownViewer filePath="/workspace/Full-Markdown.md" />);

    const rawEditor = await screen.findByPlaceholderText('markdown.placeholder') as HTMLTextAreaElement;
    fireEvent.change(rawEditor, { target: { value: editedMarkdown } });

    const handlers = refreshMocks.getHandlers();
    expect(handlers?.onAgentRefresh).toBeTypeOf('function');

    await act(async () => {
      handlers?.onAgentRefresh?.();
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });

    expect((screen.getByPlaceholderText('markdown.placeholder') as HTMLTextAreaElement).value).toBe(editedMarkdown);
  });

  test('saves a pending raw edit as soon as the editor loses focus', async () => {
    apiMocks.readFile.mockResolvedValue({ content: LARGE_MARKDOWN });
    apiMocks.writeFile.mockResolvedValue(undefined);
    render(<MarkdownViewer filePath="/workspace/Full-Markdown.md" />);

    const rawEditor = await screen.findByPlaceholderText('markdown.placeholder');
    const editedMarkdown = `${LARGE_MARKDOWN}\nSaved on blur`;
    fireEvent.change(rawEditor, { target: { value: editedMarkdown } });
    fireEvent.blur(rawEditor);

    expect(apiMocks.writeFile).toHaveBeenCalledWith('/workspace/Full-Markdown.md', editedMarkdown);
  });

  test('does not discard a pending raw edit when a live interface remounts the viewer', async () => {
    apiMocks.readFile.mockResolvedValue({ content: LARGE_MARKDOWN });
    apiMocks.writeFile.mockResolvedValue(undefined);
    const { unmount } = render(<MarkdownViewer filePath="/workspace/Full-Markdown.md" />);

    const rawEditor = await screen.findByPlaceholderText('markdown.placeholder');
    const editedMarkdown = `${LARGE_MARKDOWN}\nSaved on unmount`;
    fireEvent.change(rawEditor, { target: { value: editedMarkdown } });
    unmount();

    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledWith('/workspace/Full-Markdown.md', editedMarkdown));
  });

  test('finishes a newer raw edit after an in-flight save and a viewer remount', async () => {
    apiMocks.readFile.mockResolvedValue({ content: LARGE_MARKDOWN });
    let finishFirstSave!: () => void;
    apiMocks.writeFile
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstSave = resolve; }))
      .mockResolvedValue(undefined);
    const { unmount } = render(<MarkdownViewer filePath="/workspace/Full-Markdown.md" />);

    const rawEditor = await screen.findByPlaceholderText('markdown.placeholder');
    fireEvent.change(rawEditor, { target: { value: `${LARGE_MARKDOWN}\nfirst edit` } });
    fireEvent.blur(rawEditor);
    expect(apiMocks.writeFile).toHaveBeenCalledTimes(1);

    const latestContent = `${LARGE_MARKDOWN}\nlast edit`;
    fireEvent.change(rawEditor, { target: { value: latestContent } });
    unmount();
    await act(async () => { finishFirstSave(); });

    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenLastCalledWith('/workspace/Full-Markdown.md', latestContent));
    expect(apiMocks.writeFile).toHaveBeenCalledTimes(2);
  });

  test('saves the previous file, not the next file, when an editor changes paths', async () => {
    apiMocks.readFile.mockResolvedValue({ content: LARGE_MARKDOWN });
    apiMocks.writeFile.mockResolvedValue(undefined);
    const { rerender } = render(<MarkdownViewer filePath="/workspace/first.md" />);

    const rawEditor = await screen.findByPlaceholderText('markdown.placeholder');
    const editedMarkdown = `${LARGE_MARKDOWN}\nold file edit`;
    fireEvent.change(rawEditor, { target: { value: editedMarkdown } });
    rerender(<MarkdownViewer filePath="/workspace/second.md" />);

    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledWith('/workspace/first.md', editedMarkdown));
    expect(apiMocks.writeFile).not.toHaveBeenCalledWith('/workspace/second.md', editedMarkdown);
  });

  test('renders markdown and frontmatter without editing controls in read-only mode', async () => {
    connectionMocks.readOnly = true;
    apiMocks.readFile.mockResolvedValue({
      content: '---\ntitle: Remote note\ntags:\n  - science\n---\n\n# Read only',
    });

    render(<MarkdownViewer filePath="/workspace/remote-note.md" />);

    const document = await screen.findByTestId('markdown-content');
    expect(screen.getByText('Remote note')).toBeInTheDocument();
    expect(screen.getByText('science')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /markdown\.bold/ })).not.toBeInTheDocument();

    fireEvent.contextMenu(document);
    expect(ipcMocks.showContextMenu).not.toHaveBeenCalled();
  });
});
