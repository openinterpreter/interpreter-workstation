import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseWorkspaceAdmin } from './EnterpriseWorkspaceAdmin';

afterEach(() => vi.unstubAllGlobals());

describe('opt-in organization workspace inventory', () => {
  test('registers, confirms deactivation and refetches authoritative scoped data without a bearer', async () => {
    const workspaces: { id: string; name: string; active: boolean }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(init).toMatchObject({ credentials: 'same-origin', body: expect.any(String) });
        expect(init.headers).toMatchObject({ 'X-Interpreter-CSRF': '1' });
        if (url.endsWith('/deactivate')) workspaces[0]!.active = false;
        else workspaces.push({ ...JSON.parse(String(init.body)), active: true });
        return { status: 204 };
      }
      return { status: 200, json: async () => ({ organizationId: 'org-a', workspaces: structuredClone(workspaces) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseWorkspaceAdmin organizationId="org-a" />);
    expect(await screen.findByText('No workspaces registered.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Workspace identifier'), { target: { value: 'research' } });
    fireEvent.change(screen.getByLabelText('Workspace name'), { target: { value: 'Research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register workspace' }));
    expect(await screen.findByText('Active registry entry', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(screen.getByText('Deactivate Research?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(workspaces[0]!.active).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deactivation' }));
    expect(await screen.findByText('research · Inactive')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(5); // Initial, two writes and two authoritative reads.
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });

  test('rejects foreign or unavailable response and hides the old tenant inventory on switch', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ status: 200, json: async () => ({
      organizationId: url.includes('/org-b/') ? 'org-a' : 'org-a',
      workspaces: [{ id: 'private', name: 'Private A', active: true }],
    }) }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<EnterpriseWorkspaceAdmin organizationId="org-a" />);
    expect(await screen.findByText('Private A')).toBeInTheDocument();
    view.rerender(<EnterpriseWorkspaceAdmin organizationId="org-b" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No access is shown'));
    expect(screen.queryByText('Private A')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-b/workspaces',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });
});
