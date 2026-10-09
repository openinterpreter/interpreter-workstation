import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getStatus, openExternal, onChanged, setFooterConfig } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  onChanged: vi.fn(() => () => {}),
  setFooterConfig: vi.fn(),
}));
vi.mock('../../../ipc', () => ({ browserControl: { getStatus, onChanged }, openExternal }));
vi.mock('../OnboardingContext', () => ({ useOnboarding: () => ({ currentStep: 14, setFooterConfig }) }));

import { SimpleBrowserSetupScreen } from './SimpleBrowserSetupScreen';

describe('Simple Chrome onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStatus.mockResolvedValue({ connectedBrowsers: 0, profiles: [] });
  });

  afterEach(() => vi.useRealTimers());

  it('offers extension installation and reports an absent connection', async () => {
    render(<SimpleBrowserSetupScreen onNext={vi.fn()} discoveryReady />);
    expect(await screen.findByText('Chrome is not connected yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Get the Chrome extension' }));
    expect(openExternal).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/chromewebstore\.google\.com\//));
    expect(setFooterConfig).toHaveBeenCalledWith(expect.objectContaining({ continueDisabled: false }));
  });

  it('recognizes an already-connected extension and responds to status updates', async () => {
    getStatus.mockResolvedValueOnce({ connectedBrowsers: 1, profiles: [] });
    render(<SimpleBrowserSetupScreen onNext={vi.fn()} discoveryReady />);
    expect(await screen.findByText('Chrome is connected.')).toBeTruthy();
    getStatus.mockResolvedValue({ connectedBrowsers: 0, profiles: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Chrome is not connected yet.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('waits for MCP discovery before advancing and permits recovery from browser status failure', async () => {
    getStatus.mockRejectedValue(new Error('offline'));
    render(<SimpleBrowserSetupScreen onNext={vi.fn()} discoveryReady={false} />);
    expect(await screen.findByText(/Could not check Chrome connection/)).toBeTruthy();
    await waitFor(() => expect(setFooterConfig).toHaveBeenCalledWith(expect.objectContaining({ continueDisabled: true })));
  });

  it('recovers from an unresponsive browser bridge without accepting a stale response', async () => {
    vi.useFakeTimers();
    let finishFirst: (status: { connectedBrowsers: number; profiles: never[] }) => void = () => {};
    getStatus.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }));
    render(<SimpleBrowserSetupScreen onNext={vi.fn()} discoveryReady />);
    expect(screen.getByRole('status').textContent).toContain('Checking Chrome connection');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole('status').textContent).toContain('Could not check Chrome connection');

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('status').textContent).toBe('Chrome is not connected yet.');
    await act(async () => { finishFirst({ connectedBrowsers: 1, profiles: [] }); });
    expect(screen.getByRole('status').textContent).toBe('Chrome is not connected yet.');
  });
});
