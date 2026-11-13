import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  configure: vi.fn(),
  clearCredential: vi.fn(),
}));

vi.mock('@/ipc', () => ({ simpleLive: mocks }));

import { SimpleConnectionsSettings } from './SimpleConnectionsSettings';

describe('Simple GPT Live settings', () => {
  beforeEach(() => {
    mocks.status.mockReset().mockResolvedValue({ configured: false, source: 'none' });
    mocks.configure.mockReset().mockResolvedValue({ configured: true, source: 'secure' });
    mocks.clearCredential.mockReset().mockResolvedValue({ configured: false, source: 'none' });
  });

  test('saves the optional key without echoing it or showing deferred connections', async () => {
    const user = userEvent.setup();
    render(<SimpleConnectionsSettings />);

    const input = await screen.findByLabelText('OpenAI API key');
    await user.type(input, 'example-test-key');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.configure).toHaveBeenCalledWith({ apiKey: 'example-test-key' });
    expect(screen.queryByText('example-test-key')).not.toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp|Tailscale|Private connection/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Open another Workstation')).not.toBeInTheDocument();
  });

  test('onboarding and settings share only the optional GPT Live setup', async () => {
    render(<SimpleConnectionsSettings />);
    expect(await screen.findByLabelText('OpenAI API key')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'GPT Live' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'WhatsApp' })).not.toBeInTheDocument();
  });

  test('an existing secure key can be removed without rendering credentials', async () => {
    mocks.status.mockResolvedValue({ configured: true, source: 'secure' });
    const user = userEvent.setup();
    render(<SimpleConnectionsSettings />);
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(mocks.clearCredential).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Open another Workstation')).not.toBeInTheDocument();
  });
});
