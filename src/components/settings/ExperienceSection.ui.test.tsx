import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  get: vi.fn(async () => ({ enabled: false })),
  set: vi.fn(async (_enabled: boolean) => ({ success: true })),
  getSimple: vi.fn(async () => ({ workspacePath: '/documents/Interpreter' })),
  setSimple: vi.fn(async ({ workspacePath }: { workspacePath: string }) => ({ workspacePath })),
  folder: vi.fn(async () => ({ canceled: false, filePaths: ['/documents/Other'] })),
}));

vi.mock('@/ipc', () => ({
  uiSettings: {
    getAdvancedMode: bridge.get,
    setAdvancedMode: bridge.set,
    onAdvancedModeChanged: () => () => {},
  },
  workspace: { getSimple: bridge.getSimple, setSimple: bridge.setSimple },
  openFolderDialog: bridge.folder,
}));
vi.mock('../../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));

import { ExperienceSectionContent } from './ExperienceSection';

describe('Simple experience settings', () => {
  beforeEach(() => vi.clearAllMocks());

  test('defaults to Simple, switches to Advanced and back through durable preference', async () => {
    const user = userEvent.setup();
    render(<ExperienceSectionContent />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'true'));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(bridge.set).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Simple' }));
    expect(bridge.set).toHaveBeenCalledWith(false);
  });

  test('choosing a folder sends path through validating backend, not Advanced workspace', async () => {
    const user = userEvent.setup();
    render(<ExperienceSectionContent />);
    await screen.findByText('/documents/Interpreter');
    await user.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(bridge.setSimple).toHaveBeenCalledWith({ workspacePath: '/documents/Other' });
    await screen.findByText('/documents/Other');
  });

  test('save failure is visible and does not claim a mode switch', async () => {
    bridge.set.mockResolvedValueOnce({ success: false } as never);
    const user = userEvent.setup();
    render(<ExperienceSectionContent />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Simple' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'true');
  });
});
