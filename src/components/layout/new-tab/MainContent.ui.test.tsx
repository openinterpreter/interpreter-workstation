import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { MainContent } from './MainContent';

const ipcMocks = vi.hoisted(() => ({
  globalTools: {
    get: vi.fn(async () => ({ enabled: true })),
    onChanged: vi.fn(() => () => {}),
  },
  workspace: {
    get: vi.fn(async () => ({ workspace: '/workspace' })),
    onChanged: vi.fn(() => () => {}),
  },
  skills: {
    list: vi.fn(async () => ({
      success: true,
      data: {
        project: {
          skills: [
            {
              id: 'workspace-refactor',
              name: 'workspace-refactor',
              title: 'Refactor workspace',
              description: 'Refactor the current workspace',
              filePath: '/workspace/.skills/workspace-refactor/SKILL.md',
            },
          ],
        },
      },
    })),
    onChanged: vi.fn(() => () => {}),
  },
}));

const layoutMocks = vi.hoisted(() => ({
  openFile: vi.fn(),
}));

vi.mock('../../../ipc', () => ipcMocks);

vi.mock('../../../hooks/useLayout', () => ({
  useLayoutActions: () => layoutMocks,
}));

vi.mock('../../../api', () => ({
  getUserName: vi.fn(async () => ({ userName: 'Vic' })),
  getWorkspaceType: vi.fn(async () => null),
  getActivitySignals: vi.fn(async () => null),
  recordCardClickActivity: vi.fn(async () => undefined),
  recordSkillUseActivity: vi.fn(async () => undefined),
}));

vi.mock('../../ui/ghost-element', () => ({
  GhostElement: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('./ApprovalsContainer', () => ({
  ApprovalsContainer: () => null,
}));

vi.mock('./NewTabComposer', async () => {
  const React = await import('react');

  return {
    NewTabComposer: React.forwardRef(function MockNewTabComposer(
      { onSend }: { onSend: (text: string) => void },
      ref: React.ForwardedRef<{
        focus: () => void;
        getContent: () => string;
        setContent: (value: string) => void;
        clearContent: () => void;
        insertText: (value: string) => void;
        setContentWithTokenFlash: (value: string) => void;
        setPreviewText: (value: string | null) => void;
      }>,
    ) {
      const [content, setContent] = React.useState('');

      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
        getContent: () => content,
        setContent: (value: string) => setContent(value),
        clearContent: () => setContent(''),
        insertText: (value: string) => setContent((previous) => `${previous}${value}`),
        setContentWithTokenFlash: (value: string) => setContent(value),
        setPreviewText: () => undefined,
      }), [content]);

      return (
        <div>
          <div data-testid="mock-new-tab-composer-content">{content}</div>
          <button type="button" onClick={() => onSend(content)}>
            Send
          </button>
        </div>
      );
    }),
  };
});

describe('MainContent', () => {
  test('keeps adjunct guidance above the normal composer surface', () => {
    render(
      <MainContent
        userName="Vic"
        onComposerSend={() => {}}
        onCreateEmptyNote={() => {}}
        onCreateDailyNote={() => {}}
        topBanner={<div data-testid="adjunct-guidance">Use Interpreter from anywhere</div>}
      />,
    );

    expect(screen.getByTestId('adjunct-guidance')).toBeVisible();
    expect(screen.getByTestId('mock-new-tab-composer-content')).toBeVisible();
  });

  test('loads workspace skills and inserts a skill chip into the composer', async () => {
    const user = userEvent.setup();

    render(
      <MainContent
        userName="Vic"
        onComposerSend={() => {}}
        onCreateEmptyNote={() => {}}
        onCreateDailyNote={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('button', { name: 'Refactor workspace' }));

    expect(screen.getByTestId('mock-new-tab-composer-content')).toHaveTextContent(
      'skill:[Refactor workspace](id=workspace-refactor',
    );
  });

  test('navigates prompt categories and inserts the selected leaf prompt', async () => {
    const user = userEvent.setup();

    render(
      <MainContent
        userName="Vic"
        onComposerSend={() => {}}
        onCreateEmptyNote={() => {}}
        onCreateDailyNote={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Ask Folder' }));

    expect(screen.getByTestId('mock-new-tab-composer-content')).toHaveTextContent(
      'Answer my question according to the contents of this folder.',
    );
  });
});
