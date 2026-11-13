import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const topNotices = vi.hoisted(() => ({ list: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/ipc', () => ({ topNotices }));
import { SimpleWhatsNew } from './SimpleWhatsNew';

describe('Simple versioned update note', () => {
  beforeEach(() => {
    topNotices.list.mockReset().mockResolvedValue({ notices: [{ id: 'simple-whats-new', version: '2026-10-simple-first-run' }] });
    topNotices.dismiss.mockReset().mockResolvedValue({ success: true });
  });

  test('never interrupts fresh onboarding, recording that this version was seen', async () => {
    const visible = vi.fn();
    render(<SimpleWhatsNew firstRunSession onVisibilityChange={visible} />);
    await waitFor(() => expect(topNotices.dismiss).toHaveBeenCalledWith('simple-whats-new'));
    expect(topNotices.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: "What's New" })).not.toBeInTheDocument();
  });

  test('upgrade note appears independently and dismissal persists across remount', async () => {
    const user = userEvent.setup();
    const visible = vi.fn();
    const rendered = render(<SimpleWhatsNew firstRunSession={false} onVisibilityChange={visible} />);
    expect(await screen.findByRole('region', { name: "What's New" })).toBeVisible();
    expect(visible).toHaveBeenCalledWith(true);
    expect(screen.getByText(/Switch to Advanced/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: "Dismiss What's New" }));
    await waitFor(() => expect(topNotices.dismiss).toHaveBeenCalledWith('simple-whats-new'));
    expect(screen.queryByRole('region', { name: "What's New" })).not.toBeInTheDocument();
    rendered.unmount();
    topNotices.list.mockResolvedValue({ notices: [] });
    render(<SimpleWhatsNew firstRunSession={false} onVisibilityChange={visible} />);
    await waitFor(() => expect(topNotices.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: "What's New" })).not.toBeInTheDocument();
  });

  test('a successful retry clears a previous dismissal error', async () => {
    const user = userEvent.setup();
    topNotices.dismiss.mockRejectedValueOnce(new Error('temporary write failure'));
    render(<SimpleWhatsNew firstRunSession={false} onVisibilityChange={vi.fn()} />);
    await screen.findByRole('region', { name: "What's New" });

    await user.click(screen.getByRole('button', { name: "Dismiss What's New" }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this change. Try again.');

    await user.click(screen.getByRole('button', { name: "Dismiss What's New" }));
    await waitFor(() => expect(screen.queryByRole('region', { name: "What's New" })).not.toBeInTheDocument());
    expect(screen.queryByText('Could not save this change. Try again.')).not.toBeInTheDocument();
    expect(topNotices.dismiss).toHaveBeenCalledTimes(2);
  });
});
