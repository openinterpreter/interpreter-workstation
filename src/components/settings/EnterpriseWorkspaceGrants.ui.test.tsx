import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseWorkspaceAdmin } from './EnterpriseWorkspaceAdmin';

afterEach(() => vi.unstubAllGlobals());

describe('explicit workspace access administration', () => {
  test('requires confirmation and authoritative refetch for grant and revocation', async () => {
    let granted = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/grants')) {
        if (init?.method === 'POST') {
          expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
          expect(init.headers).toMatchObject({ 'X-Interpreter-CSRF': '1', 'Content-Type': 'application/json' });
          const change = JSON.parse(String(init.body));
          expect(change).toMatchObject({ subject: 'carol', action: 'tool.invoke' });
          granted = change.granted;
          return { status: 204 };
        }
        return { status: 200, json: async () => ({ organizationId: 'org-a', workspaceId: 'research',
          grants: granted ? [{ subject: 'carol', actions: ['tool.invoke'] }] : [] }) };
      }
      return { status: 200, json: async () => ({ organizationId: 'org-a',
        workspaces: [{ id: 'research', name: 'Research', active: true }] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmed = vi.fn();
    render(<EnterpriseWorkspaceAdmin organizationId="org-a" members={[
      { subject: 'carol', displayName: 'Carol', active: true },
      { subject: 'former', displayName: 'Former', active: false },
    ]} onConfirmed={confirmed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage access' }));
    expect(await screen.findByText('No execution grants for this workspace.')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Former/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Grant member'), { target: { value: 'carol' } });
    fireEvent.change(screen.getByLabelText('Grant capability'), { target: { value: 'tool.invoke' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review grant' }));
    expect(screen.getByText('Grant Invoke tools for Carol?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review grant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm grant' }));
    expect(await screen.findByText('Carol · Invoke tools')).toBeInTheDocument();
    expect(confirmed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(screen.getByText('Revoke Invoke tools for Carol?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
    expect(await screen.findByText('No execution grants for this workspace.')).toBeInTheDocument();
    expect(confirmed).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });

  test('hides grants and inventory on a foreign or unavailable response', async () => {
    const unavailable = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/grants')
      ? { status: 200, json: async () => ({ organizationId: 'org-b', workspaceId: 'research',
        grants: [{ subject: 'foreign', actions: ['tool.invoke'] }] }) }
      : { status: 200, json: async () => ({ organizationId: 'org-a',
        workspaces: [{ id: 'research', name: 'Research', active: true }] }) }));
    render(<EnterpriseWorkspaceAdmin organizationId="org-a" members={[]}
      onUnavailable={unavailable} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage access' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Inventory is hidden'));
    expect(screen.queryByText('Foreign')).not.toBeInTheDocument();
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
});
