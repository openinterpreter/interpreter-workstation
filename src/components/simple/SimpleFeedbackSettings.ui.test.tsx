import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { SimpleFeedbackSettings } from './SimpleFeedbackSettings';

describe('Simple Feedback settings', () => {
  test('hides the floating button without removing the persistent Feedback action', async () => {
    const user = userEvent.setup();
    const onVisibilityChange = vi.fn().mockResolvedValue(undefined);
    const onLeaveFeedback = vi.fn();
    const view = render(
      <SimpleFeedbackSettings visible onVisibilityChange={onVisibilityChange} onLeaveFeedback={onLeaveFeedback} />,
    );
    await user.click(screen.getByRole('switch', { name: 'Show Feedback button' }));
    expect(onVisibilityChange).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
    view.rerender(
      <SimpleFeedbackSettings visible={false} onVisibilityChange={onVisibilityChange} onLeaveFeedback={onLeaveFeedback} />,
    );
    expect(screen.getByRole('switch', { name: 'Show Feedback button' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: 'Leave Feedback' }));
    expect(onLeaveFeedback).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('switch', { name: 'Show Feedback button' }));
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  });

  test('retains the visible state and offers recovery on save failure', async () => {
    const user = userEvent.setup();
    const onVisibilityChange = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    render(
      <SimpleFeedbackSettings visible onVisibilityChange={onVisibilityChange} onLeaveFeedback={vi.fn()} />,
    );
    await user.click(screen.getByRole('switch', { name: 'Show Feedback button' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save'));
    expect(screen.getByRole('switch', { name: 'Show Feedback button' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Show Feedback button' })).toBeEnabled();
  });
});
