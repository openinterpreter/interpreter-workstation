import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const theme = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), onChanged: vi.fn() }));
vi.mock('@/ipc', () => ({ theme }));
import { SimpleThemeSettings } from './SimpleThemeSettings';

describe('Simple appearance setting', () => {
  beforeEach(() => {
    theme.get.mockReset().mockResolvedValue({ theme: 'system' });
    theme.set.mockReset().mockResolvedValue({ success: true });
    theme.onChanged.mockReset().mockReturnValue(() => {});
  });

  test('loads persisted System and writes Light / Dark selections', async () => {
    const user = userEvent.setup();
    render(<SimpleThemeSettings />);
    expect(await screen.findByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(theme.set).toHaveBeenCalledWith('light');
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(theme.set).toHaveBeenCalledWith('dark');
  });

  test('follows shared theme changes, unhooks on unmount, and keeps selection on save failure', async () => {
    let changed: (event: { theme: 'dark' }) => void = () => {};
    const unsubscribe = vi.fn();
    theme.onChanged.mockImplementation((callback) => { changed = callback; return unsubscribe; });
    theme.set.mockResolvedValue({ success: false, error: 'unavailable' });
    const user = userEvent.setup();
    const rendered = render(<SimpleThemeSettings />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true'));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { changed({ theme: 'dark' }); });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true'));
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save appearance');
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
