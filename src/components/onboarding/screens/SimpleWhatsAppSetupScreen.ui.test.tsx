import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ setFooterConfig: vi.fn(), getAppServerOrigin: vi.fn(async () => 'http://127.0.0.1:5177') }));
vi.mock('@/ipc', () => ({ isBrowserDevMode: () => false, getAppServerOrigin: ipc.getAppServerOrigin }));
vi.mock('../OnboardingContext', () => ({ useOnboarding: () => ({ currentStep: 23, setFooterConfig: ipc.setFooterConfig }) }));
vi.mock('../../InboxSetupWhatsApp', () => ({ InboxSetupWhatsApp: ({ onConnected }: { onConnected: () => void }) =>
  <button type="button" onClick={onConnected}>Simulate pairing in test</button> }));
import { SimpleWhatsAppSetupScreen } from './SimpleWhatsAppSetupScreen';

describe('optional WhatsApp onboarding', () => {
  beforeEach(() => {
    ipc.setFooterConfig.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ configured: false }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  test('permits skipping without a channel and does not force voice or workspace setup', async () => {
    const finish = vi.fn(async () => true);
    render(<SimpleWhatsAppSetupScreen onFinish={finish} />);
    await waitFor(() => expect(ipc.setFooterConfig).toHaveBeenCalledWith(expect.objectContaining({ continueLabel: 'Skip for now' })));
    const action = ipc.setFooterConfig.mock.lastCall?.[0].continueAction;
    action();
    await waitFor(() => expect(finish).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Talk to Interpreter|Choose where Interpreter works/)).not.toBeInTheDocument();
  });

  test('pairs optionally and then completes onboarding', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ configured: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ configured: true, connectionState: 'connected' }) });
    vi.stubGlobal('fetch', fetch);
    render(<SimpleWhatsAppSetupScreen onFinish={async () => true} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pair WhatsApp' }));
    await userEvent.click(screen.getByRole('button', { name: 'Simulate pairing in test' }));
    expect(await screen.findByText(/WhatsApp is connected/)).toBeVisible();
    expect(ipc.setFooterConfig).toHaveBeenCalledWith(expect.objectContaining({ continueLabel: 'Start in Simple' }));
  });
});
