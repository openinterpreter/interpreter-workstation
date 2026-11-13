import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseReadiness } from './EnterpriseReadiness';

vi.mock('@/ipc', () => ({ getApiUrl: async (path: string) => `http://127.0.0.1:5177${path}` }));

afterEach(() => vi.unstubAllGlobals());

describe('enterprise readiness account card', () => {
  test('shows truthful unavailable state from server without promising SSO', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ available: false, detail: 'Local sign-in is not organization SSO.' }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<EnterpriseReadiness />);
    expect(await screen.findByText('Local sign-in is not organization SSO.')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5177/api/enterprise/readiness', { cache: 'no-store' });
  });

  test('fails closed when server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<EnterpriseReadiness />);
    expect(await screen.findByText('Enterprise control-plane status could not be verified.')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });
});
