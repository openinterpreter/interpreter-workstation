import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EnterpriseReadiness } from './EnterpriseReadiness';

afterEach(() => vi.unstubAllGlobals());

describe('enterprise readiness account card', () => {
  test('shows truthful unavailable state from server without promising SSO', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: false, detail: 'Local sign-in is not organization SSO.' }) })));
    render(<EnterpriseReadiness />);
    expect(await screen.findByText('Local sign-in is not organization SSO.')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  test('fails closed when server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<EnterpriseReadiness />);
    expect(await screen.findByText('Enterprise control-plane status could not be verified.')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });
});
