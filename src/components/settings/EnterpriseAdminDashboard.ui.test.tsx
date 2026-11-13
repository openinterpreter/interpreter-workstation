import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseAdminDashboard } from './EnterpriseAdminDashboard';

afterEach(() => vi.unstubAllGlobals());

const overview = { organization: { id: 'org-a', name: 'Acme' }, users: { total: 1, active: 1, admins: 1 },
  audit: { eventCount: 3, latestAt: null }, identity: { issuer: 'https://idp.example/tenant', status: 'verified session' },
  controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' } };

describe('admin dashboard shell', () => {
  test('loads only tenant-scoped recent audit on request, never an export or bearer', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () =>
      url.endsWith('/activity') ? { organizationId: 'org-a', events: [{ organizationId: 'org-a', subject: 'alice',
        action: 'organization.member.sessions.revoke', outcome: 'allowed', at: '2026-11-08T10:00:00Z' },
      { organizationId: 'org-a', subject: 'alice', targetOrganizationId: 'org-b',
        action: 'organization.overview.cross-tenant', outcome: 'denied', at: '2026-11-08T10:01:00Z' }] } :
        url.endsWith('/members') ? { organizationId: 'org-a', members: [] } : overview }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'View recent activity' }));
    expect(await screen.findByText(/organization.member.sessions.revoke/)).toBeInTheDocument();
    expect(screen.getByText(/attempted org-b/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-a/activity',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
    expect(screen.getByText(/Full export is a sensitive JSON file/)).toBeInTheDocument();
  });

  test('a mismatched activity tenant clears the stale directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
      url.endsWith('/activity') ? { organizationId: 'org-b', events: [] } :
        url.endsWith('/members') ? { organizationId: 'org-a', members: [] } : overview })));
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View recent activity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Access was not granted');
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
  });
  test('session kill requires confirmation, preserves member access and refetches the audit count', async () => {
    let ended = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/revoke-sessions')) {
        expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
        expect(init?.headers).toMatchObject({ 'X-Interpreter-CSRF': '1' });
        ended = true;
        return { status: 204 };
      }
      return { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [{ subject: 'carol', displayName: 'Carol', role: 'member', active: true }] }
        : { ...overview, audit: { eventCount: ended ? 4 : 3, latestAt: null } } };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'End sessions' }));
    expect(screen.getByText(/They can sign in again/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'End sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm end sessions' }));
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
    expect(screen.getByText(/Sessions ended\. This member can sign in again/)).toBeInTheDocument();
    expect(screen.getAllByText('Active')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'End sessions' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  test('sign out hides tenant data immediately and confirms server-side revocation', async () => {
    let resolveLogout!: (value: { status: number }) => void;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/session/logout')) {
        expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
        expect(init?.headers).toMatchObject({ 'X-Interpreter-CSRF': '1' });
        return new Promise<{ status: number }>((resolve) => { resolveLogout = resolve; });
      }
      return { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] } : overview };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    resolveLogout({ status: 204 });
    expect(await screen.findByRole('alert')).toHaveTextContent('Signed out');
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });

  test('failed sign out never claims the session was revoked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/session/logout') ? { status: 503 } :
      { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [] } : overview }));
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('Signed out of this organization session.')).not.toBeInTheDocument();
  });
  test('organization session kill requires confirmation and hides data while revoking its caller', async () => {
    let resolveKill!: (value: { status: number }) => void;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/sessions/revoke-all')) {
        expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
        expect(init?.headers).toMatchObject({ 'X-Interpreter-CSRF': '1' });
        return new Promise<{ status: number }>((resolve) => { resolveKill = resolve; });
      }
      return { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] } : overview };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'End all organization sessions' }));
    expect(screen.getByText(/End every current organization session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel organization action' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'End all organization sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm end all sessions' }));
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    resolveKill({ status: 204 });
    expect(await screen.findByText(/All current organization sessions ended, including yours/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('can sign in again');
    expect(screen.queryByText('Checking organization access…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End all organization sessions' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3); // Never refetch on a revoked session.
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });
  test('organization session kill outage cannot claim revocation or show stale directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/sessions/revoke-all') ? { status: 503 } :
      { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] } : overview }));
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'End all organization sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm end all sessions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.queryByText('All current organization sessions ended')).not.toBeInTheDocument();
  });
  test('shows real scoped directory payload and explicit unshipped controls', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/members')
      ? { organizationId: 'org-a', members: [{ subject: 'alice', displayName: 'Alice', role: 'admin', active: true }] } : overview }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Session verified')).toBeInTheDocument();
    expect(screen.queryByText('Verified organization session required')).not.toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('not enforced')).toBeInTheDocument();
    expect(screen.getByText(/SCIM is not available/)).toBeInTheDocument();
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

  test('exports only a verified tenant audit and refetches the export event', async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn(() => 'blob:approved-test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    let exports = 0;
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/activity/export')
      ? { ok: true, headers: new Headers({ 'content-length': '150' }), text: async () => {
        exports++;
        return JSON.stringify({ organizationId: 'org-a', events: [{ organizationId: 'org-a', subject: 'alice',
          action: 'organization.audit.read', outcome: 'allowed', at: '2026-11-08T10:00:00Z' }] });
      } } : { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [] } : { ...overview, audit: { eventCount: 3 + exports, latestAt: null } } });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export audit JSON' }));
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
    expect(download).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:approved-test'), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-a/activity/export',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
    download.mockRestore();
  });

  test('a cross-tenant or failed audit export never downloads and hides stale directory', async () => {
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/activity/export')
      ? { ok: true, headers: new Headers(), text: async () => JSON.stringify({ organizationId: 'org-b', events: [] }) }
      : { ok: true, json: async () => url.endsWith('/members')
        ? { organizationId: 'org-a', members: [] } : overview }));
    render(<EnterpriseAdminDashboard organizationId="org-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export audit JSON' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
    download.mockRestore();
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
