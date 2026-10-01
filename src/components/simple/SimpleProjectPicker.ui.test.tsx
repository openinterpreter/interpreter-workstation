import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const local = vi.hoisted(() => ({ projects: vi.fn(), createProject: vi.fn(), openProject: vi.fn(), closeProject: vi.fn() }));
const remote = vi.hoisted(() => ({ list: vi.fn() }));
const dialog = vi.hoisted(() => ({ openFolderDialog: vi.fn() }));
vi.mock('./simpleInterfaceClient', () => ({ simpleInterfaceClient: local }));
vi.mock('./remoteSimpleClient', () => ({ remoteSimpleClient: remote }));
vi.mock('@/ipc', () => dialog);
import { SimpleProjectPicker } from './SimpleProjectPicker';

const windowId = '8b998041-3299-43c3-8cc0-49486998e6aa';
const first = { id: 'e789617d-032e-4412-87cc-99fbcf0953cb', path: '/Documents/Interfaces/First', name: 'First' };
const second = { id: '91addb76-f4d9-4671-8222-a24f57b29789', path: '/Documents/Interfaces/Second', name: 'Second' };

beforeEach(() => {
  local.projects.mockReset().mockResolvedValue({ projects: [first, second], active: null });
  local.createProject.mockReset().mockResolvedValue(second);
  local.openProject.mockReset().mockImplementation(async (_id: string, path: string) => path === first.path ? first : second);
  remote.list.mockReset().mockResolvedValue([]);
  dialog.openFolderDialog.mockReset().mockResolvedValue({ canceled: false, filePaths: ['/Documents/Interfaces'] });
});

describe('standalone project chooser', () => {
  test('opens independent projects by this window ID and creates under selected parent', async () => {
    const onOpen = vi.fn();
    render(<SimpleProjectPicker windowId={windowId} onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: /First/ }));
    await waitFor(() => expect(local.openProject).toHaveBeenCalledWith(windowId, first.path));
    fireEvent.click(screen.getByRole('button', { name: 'Choose parent folder' }));
    await screen.findByRole('button', { name: '/Documents/Interfaces' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'New Interface' }));
    await waitFor(() => expect(local.createProject).toHaveBeenCalledWith(windowId, '/Documents/Interfaces', 'Second'));
    expect(onOpen).toHaveBeenCalledWith(second);
  });

  test('offers independent remote project without replacing local project registry', async () => {
    const onOpenRemote = vi.fn();
    remote.list.mockResolvedValue([{ id: 'remote-1', projectId: first.id, threadId: second.id, status: 'connected' }]);
    render(<SimpleProjectPicker windowId={windowId} onOpen={vi.fn()} onOpenRemote={onOpenRemote} />);
    fireEvent.click(await screen.findByRole('button', { name: /Remote project/ }));
    expect(onOpenRemote).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-1', projectId: first.id }));
    expect(local.openProject).not.toHaveBeenCalled();
  });
});
