import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseDomainSetup } from './EnterpriseDomainSetup';
import { EnterpriseAdminDashboard } from './EnterpriseAdminDashboard';

afterEach(() => vi.unstubAllGlobals());

describe('opt-in domain setup flow', () => {
  test('recovery locks the assigned domain and requires a fresh login after an authoritative proof', async () => {
    let observed = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/challenge')) return { status: 200, json: async () => ({
        name: '_interpreter-workstation.acme.example',
        value: 'interpreter-workstation-verification=' + 'c'.repeat(43), expiresAt: Date.now() + 60_000 }) };
      if (url.endsWith('/verify')) { observed = true; return { status: 204 }; }
      return { status: 200, json: async () => ({ domain: 'acme.example', challengeExpiresAt: null,
        verifiedUntil: observed ? Date.now() + 60_000 : null }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseDomainSetup organizationId="org-a" recoveryDomain="acme.example" />);
    expect(screen.getByRole('heading', { name: 'Restore domain access' })).toBeInTheDocument();
    expect(screen.getByLabelText('Organization domain')).toHaveValue('acme.example');
    expect(screen.getByLabelText('Organization domain')).toHaveAttribute('readonly');
    expect(screen.queryByRole('link', { name: 'Sign in again' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No current DNS confirmation');
    fireEvent.click(screen.getByRole('button', { name: 'Create DNS challenge' }));
    expect(await screen.findByText('_interpreter-workstation.acme.example')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify DNS record' }));
    expect(await screen.findByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/organizations/org-a/login');
    expect(screen.getByRole('status')).toHaveTextContent('limited session cannot administer');
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('other.example'))).toBe(true);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });

  test('a failed recovery check does not offer admin sign-in or an unverified DNS badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 503 })));
    const { rerender } = render(<EnterpriseDomainSetup organizationId="org-a" recoveryDomain="acme.example" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('status is unavailable');
    expect(screen.queryByRole('link', { name: 'Sign in again' })).not.toBeInTheDocument();
    rerender(<EnterpriseDomainSetup organizationId="org-b" recoveryDomain="beta.example" />);
    await waitFor(() => expect(screen.getByLabelText('Organization domain')).toHaveValue('beta.example'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  test('is not exposed in the default dashboard and verifies a server-issued DNS challenge without SSO claims', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/challenge')) return { status: 200, json: async () => ({ name: '_interpreter-workstation.example.test',
        value: 'interpreter-workstation-verification=' + 'a'.repeat(43), expiresAt: Date.now() + 200_000 }) };
      if (url.endsWith('/verify')) return { status: 204 };
      if (url.includes('/domains/status?')) return { status: 200, json: async () => ({ domain: 'example.test',
        challengeExpiresAt: null, verifiedUntil: Date.now() + 200_000 }) };
      return { ok: true, json: async () => url.endsWith('/members') ? { organizationId: 'org-a', members: [] } :
        { organization: { id: 'org-a', name: 'Alpha' }, users: { total: 1, active: 1, admins: 1 },
          audit: { eventCount: 1, latestAt: null }, identity: { issuer: 'https://idp.example/a', subject: 'alice', status: 'verified session' },
          controls: { policy: 'not enforced', provisioning: 'not configured', modelRegistry: 'not configured' } } };
    });
    vi.stubGlobal('fetch', fetchMock);
    const defaultDashboard = render(<EnterpriseAdminDashboard organizationId="org-a" />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Domain setup' })).not.toBeInTheDocument();
    defaultDashboard.unmount();
    render(<EnterpriseDomainSetup organizationId="org-a" />);
    fireEvent.change(screen.getByLabelText('Organization domain'), { target: { value: 'Example.Test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create DNS challenge' }));
    expect(await screen.findByText('_interpreter-workstation.example.test')).toBeInTheDocument();
    expect(screen.getByText('interpreter-workstation-verification=' + 'a'.repeat(43))).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-a/domains/challenge',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{"domain":"example.test"}' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify DNS record' }));
    expect(await screen.findByRole('status')).toHaveTextContent('SSO remains off');
    expect(screen.queryByText('interpreter-workstation-verification=' + 'a'.repeat(43))).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-a/domains/verify',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{"domain":"example.test"}' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-a/domains/status?domain=example.test',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Authorization');
  });

  test('a denied verification or org switch clears the challenge and any success badge', async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/verify') ? { status: 503 } : { status: 200,
      json: async () => ({ name: '_interpreter-workstation.example.test',
        value: 'interpreter-workstation-verification=' + 'b'.repeat(43), expiresAt: Date.now() + 120_000 }) });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<EnterpriseDomainSetup organizationId="org-a" />);
    fireEvent.change(screen.getByLabelText('Organization domain'), { target: { value: 'example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create DNS challenge' }));
    expect(await screen.findByText('_interpreter-workstation.example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify DNS record' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('interpreter-workstation-verification=' + 'b'.repeat(43))).not.toBeInTheDocument();
    rerender(<EnterpriseDomainSetup organizationId="org-b" />);
    await waitFor(() => expect(screen.getByLabelText('Organization domain')).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  test('a reload reads authoritative status; a mismatched or unavailable response never shows confirmation', async () => {
    let domain = 'example.test';
    let available = true;
    vi.stubGlobal('fetch', vi.fn(async () => available ? { status: 200, json: async () => ({ domain,
      challengeExpiresAt: null, verifiedUntil: Date.now() + 60_000 }) } : { status: 503 }));
    render(<EnterpriseDomainSetup organizationId="org-a" />);
    fireEvent.change(screen.getByLabelText('Organization domain'), { target: { value: 'example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('status')).toHaveTextContent('DNS proof observed; valid until');
    domain = 'foreign.test';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('status is unavailable');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    available = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('status is unavailable');
  });
  test('a lapsed lease and challenge display recovery, not a valid proof badge', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ domain: 'example.test',
      challengeExpiresAt: Date.now() - 120_000, verifiedUntil: Date.now() - 60_000 }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseDomainSetup organizationId="org-a" />);
    fireEvent.change(screen.getByLabelText('Organization domain'), { target: { value: 'example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('status')).toHaveTextContent('DNS proof expired');
    expect(screen.getByRole('status')).toHaveTextContent('ordinary administration remains unavailable');
    expect(screen.getByRole('status')).not.toHaveTextContent('DNS proof observed; valid until');
    expect(fetchMock).toHaveBeenCalledWith('/api/enterprise/organizations/org-a/domains/status?domain=example.test',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });
  test('a proof expiring while the setup page stays open loses its valid badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ domain: 'example.test',
      challengeExpiresAt: null, verifiedUntil: Date.now() + 700 }) })));
    render(<EnterpriseDomainSetup organizationId="org-a" />);
    fireEvent.change(screen.getByLabelText('Organization domain'), { target: { value: 'example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DNS status' }));
    expect(await screen.findByRole('status')).toHaveTextContent('DNS proof observed; valid until');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('DNS proof expired'), { timeout: 3000 });
    expect(screen.getByRole('status')).not.toHaveTextContent('DNS proof observed');
  });
});
