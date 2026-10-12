import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => ({ entry: vi.fn() }));
vi.mock('../../contexts/LowerLeftNoticesContext', () => ({ useLowerLeftNotice: notices.entry }));
vi.mock('../FeedbackPopover', () => ({ FeedbackPopover: ({ className }: { className: string }) => <button className={className}>Feedback</button> }));
import { OnboardingFeedbackToast } from './OnboardingFeedbackToast';

describe('floating Simple Feedback', () => {
  it('keeps the pill-sized action in the lower-left Windows notice layer after onboarding', () => {
    render(<OnboardingFeedbackToast visible side="left" />);
    expect(notices.entry).toHaveBeenCalledWith('onboarding-feedback', expect.anything(), 'left');
    // The notice layer is portaled in production; inspect the actual passed element.
    const entry = notices.entry.mock.lastCall?.[1];
    const rendered = render(entry);
    expect(screen.getByRole('button', { name: 'Feedback' })).toHaveClass('h-9', 'rounded-[12px]', 'justify-center');
    rendered.unmount();
  });

  it('selects lower-right on macOS, and hides the floating entry without changing the menu command', () => {
    const view = render(<OnboardingFeedbackToast visible side="right" />);
    expect(notices.entry).toHaveBeenCalledWith('onboarding-feedback', expect.anything(), 'right');
    view.rerender(<OnboardingFeedbackToast visible={false} side="right" />);
    expect(notices.entry).toHaveBeenCalledWith('onboarding-feedback', null, 'right');
  });
});
