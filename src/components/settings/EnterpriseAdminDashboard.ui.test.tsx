import { render, screen, waitFor } from '@testing-library/react';
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
    render(<EnterpriseAdminDashboard organizationId="org-a" sessionToken="opaque-local-fixture" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('not enforced')).toBeInTheDocument();
    expect(screen.getByText(/Audit export and SCIM are not available/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/organizations/org-a/overview'), expect.objectContaining({ headers: { Authorization: 'Bearer opaque-local-fixture' }, cache: 'no-store' }));
  });

  test('cross-org payload and failed API clear data rather than show stale tenant', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/members')
      ? { organizationId: 'org-b', members: [] } : overview })));
    render(<EnterpriseAdminDashboard organizationId="org-a" sessionToken="fixture" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Access was not granted');
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
  });
});
