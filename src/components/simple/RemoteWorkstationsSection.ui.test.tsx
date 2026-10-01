import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const client = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('./remoteSimpleClient', () => ({ remoteSimpleClient: client }));
vi.mock('@/ipc', () => ({ apiRequest: vi.fn(), writeClipboardText: vi.fn() }));

import { RemoteWorkstationsSection } from './RemoteWorkstationsSection';

const connection = { id: 'connection-1', projectId: 'e789617d-032e-4412-87cc-99fbcf0953cb',
  threadId: '8b998041-3299-43c3-8cc0-49486998e6aa', status: 'connected' };

beforeEach(() => {
  client.list.mockReset().mockResolvedValue([connection]);
  client.capabilities.mockReset().mockRejectedValue(new Error('offline'));
});

describe('restrained remote connection settings', () => {
  test('reports an unavailable project instead of trusting cached connected state', async () => {
    render(<RemoteWorkstationsSection />);
    expect(await screen.findByText(/Remote project e789617d · Unavailable/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open window' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  test('rechecks the exact project and thread before offering an independent window', async () => {
    render(<RemoteWorkstationsSection />);
    await screen.findByText(/Unavailable/);
    client.capabilities.mockResolvedValue({ version: 1, projectId: connection.projectId, threadId: connection.threadId });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(screen.getByText(/Remote project e789617d · Connected/)).toBeVisible());
    expect(screen.getByRole('button', { name: 'Open window' })).toBeEnabled();
  });
});
