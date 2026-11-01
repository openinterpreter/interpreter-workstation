import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseAdminDashboard } from './EnterpriseAdminDashboard';

afterEach(() => vi.unstubAllGlobals());

const overview = { organization: { id: 'org-a', name: 'Acme' }, users: { total: 1, active: 1, admins: 1 },
  audit: { eventCount: 3, latestAt: null }, identity: { issuer: 'https://idp.example/tenant', status: 'verified session' },
  controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' } };

describe('admin dashboard shell', () => {
  test('shows real scoped directory payload and explicit unshipped controls', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/members')
      ? { organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] } : overview }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('not enforced')).toBeInTheDocument();
    expect(screen.getByText(/Audit export and SCIM are not available/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/organizations/org-a/overview'), expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('opaque-local-fixture');
  });

  test('cross-org payload and failed API clear data rather than show stale tenant', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/members')
      ? { organizationId: 'org-b', members: [] } : overview })));
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Access was not granted');
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
  });

  test('confirms deactivation, sends no bearer, and refetches the authoritative directory', async () => {
    let active = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/deactivate')) {
        expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
        expect(init?.headers).toMatchObject({ 'X-Interpreter-CSRF': '1' });
        active = false;
        return { status: 204 };
      }
      return { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [{ subject: 'carol', displayName: 'Carol', role: 'member', active }] }
        : { ...overview, users: { total: 1, active: active ? 1 : 0, admins: 0 } } };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deactivation' }));
    await waitFor(() => expect(screen.getByText('Inactive')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });

  test('failed mutation clears stale organization data and shows a denial', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/deactivate') ? { status: 403 } :
      { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [{ subject: 'carol', displayName: 'Carol', role: 'member', active: true }] }
        : overview }));
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deactivation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('change was not confirmed');
    expect(screen.queryByText('Carol')).not.toBeInTheDocument();
  });
});
