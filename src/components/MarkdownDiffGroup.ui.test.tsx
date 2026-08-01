import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { MarkdownDiffGroup } from './MarkdownDiffGroup';

vi.mock('./TipTapViewer', () => ({
  TipTapViewer: ({ content }: { content: unknown }) => <div data-testid="mock-tiptap-viewer">{JSON.stringify(content)}</div>,
}));

describe('MarkdownDiffGroup', () => {
  test('describes modified content and routes accept/reject actions', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const onReject = vi.fn();

    render(
      <MarkdownDiffGroup
        group={{
          index: 2,
          oldContent: 'Old line\nAnother line',
          newContent: 'Old line\nAnother line\nNew line',
          lineNumber: 10,
          oldLines: 2,
          newLines: 3,
        }}
        onAccept={onAccept}
        onReject={onReject}
      />,
    );

    expect(screen.getByText('Modifies 2 lines, adds 1 line')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(onReject).toHaveBeenCalledWith(2);
    expect(onAccept).toHaveBeenCalledWith(2);
  });
});
