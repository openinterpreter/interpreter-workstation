import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { LowerLeftNoticeProvider, useLowerLeftNotices } from '../contexts/LowerLeftNoticesContext';
import { ToastProvider } from '../contexts/ToastContext';
import { FeedbackPopover } from './FeedbackPopover';
import { useState } from 'react';
import { openFeedbackPopover } from '../utils/feedback';
import { distributionProductConfig } from '../../shared/productConfig';

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: {
      button: React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'> & { whileTap?: unknown; transition?: unknown }>(
        ({ whileTap: _whileTap, transition: _transition, ...props }, ref) => (
          <button ref={ref} {...props} />
        ),
      ),
    },
    useReducedMotion: () => false,
  };
});

const ipcMocks = vi.hoisted(() => ({
  getRuntimeSystemInfo: vi.fn(() => ({ platform: 'darwin' })),
  isBrowserDevMode: vi.fn(() => false),
}));

const telemetryMocks = vi.hoisted(() => ({
  trackFeedbackOpened: vi.fn(),
  trackFeedbackSubmitted: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  getRuntimeSystemInfo: ipcMocks.getRuntimeSystemInfo,
  isBrowserDevMode: ipcMocks.isBrowserDevMode,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    session: {
      user: {
        email: 'tester@example.com',
      },
    },
  }),
}));

vi.mock('../utils/telemetry', () => telemetryMocks);

vi.mock('../utils/userVisibleErrorLog', () => ({
  logUserVisibleError: vi.fn(),
}));

function NoticeViewport() {
  const { notices } = useLowerLeftNotices();
  return (
    <div data-testid="toast-viewport">
      {notices.map((notice) => (
        <div key={notice.id}>{notice.content}</div>
      ))}
    </div>
  );
}

function renderFeedbackPopover() {
  return render(
    <LowerLeftNoticeProvider>
      <ToastProvider>
        <FeedbackPopover />
        <NoticeViewport />
      </ToastProvider>
    </LowerLeftNoticeProvider>,
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function submitMeaningfulFeedback(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Feedback' }));
  await user.clear(await screen.findByLabelText('Email'));
  await user.type(screen.getByLabelText('Email'), 'tester@example.com');
  await user.type(screen.getByLabelText('Message'), 'Feedback submission should show visible toast progress.');
  await user.click(screen.getByRole('button', { name: 'Send Feedback' }));
}

describe('FeedbackPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    distributionProductConfig.feedbackUrl = '';
    (window as any).electron = {
      feedback: {
        submit: vi.fn(),
      },
    };
  });

  test('closes the popover after submit and keeps success visible in the toast', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<{ success: boolean; id: string }>();
    (window as any).electron.feedback.submit.mockReturnValue(deferred.promise);

    renderFeedbackPopover();

    await submitMeaningfulFeedback(user);

    expect(await screen.findByText('Sending feedback...')).toBeVisible();
    expect((window as any).electron.feedback.submit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    });

    await act(async () => {
      deferred.resolve({ success: true, id: 'a'.repeat(32) });
    });

    expect(await screen.findByText(`Feedback sent! Report ID: ${'a'.repeat(32)}`)).toBeVisible();
    expect(screen.queryByText('Sending feedback...')).not.toBeInTheDocument();
  });

  test('closes the popover after submit and replaces the sending toast when submission fails', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<{ success: boolean; error: string }>();
    (window as any).electron.feedback.submit.mockReturnValue(deferred.promise);

    renderFeedbackPopover();

    await submitMeaningfulFeedback(user);
    expect(await screen.findByText('Sending feedback...')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    });

    await act(async () => {
      deferred.resolve({ success: false, error: 'Feedback server unavailable' });
    });

    expect(await screen.findByText('Feedback server unavailable')).toBeVisible();
    expect(screen.queryByText('Sending feedback...')).not.toBeInTheDocument();
  });

  test('does not show a sending toast when validation blocks submission', async () => {
    const user = userEvent.setup();

    renderFeedbackPopover();

    await user.click(screen.getByRole('button', { name: 'Feedback' }));
    await user.type(await screen.findByLabelText('Message'), 'abcd');
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }));

    expect(await screen.findByText('Please add more details')).toBeVisible();
    expect(screen.queryByText('Sending feedback...')).not.toBeInTheDocument();
    expect((window as any).electron.feedback.submit).not.toHaveBeenCalled();
  });

  test('tabs from the email field to the message field inside the popover form', async () => {
    const user = userEvent.setup();

    renderFeedbackPopover();

    await user.click(screen.getByRole('button', { name: 'Feedback' }));
    const emailInput = await screen.findByLabelText('Email');
    const messageInput = screen.getByLabelText('Message');

    await user.click(emailInput);
    expect(emailInput).toHaveFocus();

    await user.tab();

    expect(messageInput).toHaveFocus();
  });

  test('opens after a hidden Feedback trigger mounts in response to Settings', async () => {
    const user = userEvent.setup();
    function HiddenFeedback() {
      const [requested, setRequested] = useState(false);
      return (
        <LowerLeftNoticeProvider>
          <ToastProvider>
            <button onClick={() => setRequested(true)}>Leave Feedback</button>
            {requested && <FeedbackPopover openRequested onOpenChange={(open) => {
              if (!open) setRequested(false);
            }} />}
            <NoticeViewport />
          </ToastProvider>
        </LowerLeftNoticeProvider>
      );
    }

    render(<HiddenFeedback />);
    expect(screen.queryByRole('button', { name: 'Feedback' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave Feedback' }));
    expect(await screen.findByLabelText('Message')).toBeVisible();
    expect(telemetryMocks.trackFeedbackOpened).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Feedback' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Leave Feedback' }));
    expect(await screen.findByLabelText('Message')).toBeVisible();
    expect(telemetryMocks.trackFeedbackOpened).toHaveBeenCalledTimes(2);
  });

  test('keeps the existing event-based Advanced feedback action', async () => {
    renderFeedbackPopover();
    act(() => openFeedbackPopover());
    expect(await screen.findByLabelText('Message')).toBeVisible();
    expect(telemetryMocks.trackFeedbackOpened).toHaveBeenCalledOnce();
  });

  test('dedicated feedback requires a separate password field without placing it in the message', async () => {
    distributionProductConfig.feedbackUrl = 'https://feedback.example.test/v0/feedback';
    const user = userEvent.setup();
    (window as any).electron.feedback.submit.mockResolvedValue({ success: true, id: 'a'.repeat(32) });
    renderFeedbackPopover();
    await user.click(screen.getByRole('button', { name: 'Feedback' }));
    await user.type(await screen.findByLabelText('Message'), 'A complete report for support to inspect.');
    const field = screen.getByLabelText('Report passcode');
    expect(field).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }));
    expect((window as any).electron.feedback.submit).not.toHaveBeenCalled();
    await user.type(field, 'operator-report-passcode');
    await user.click(screen.getByRole('button', { name: 'Send Feedback' }));
    await waitFor(() => expect((window as any).electron.feedback.submit).toHaveBeenCalledTimes(1));
    expect((window as any).electron.feedback.submit.mock.calls[0][0]).toMatchObject({
      message: 'A complete report for support to inspect.', reportPasscode: 'operator-report-passcode',
    });
    expect(telemetryMocks.trackFeedbackSubmitted).not.toHaveBeenCalledWith(
      expect.objectContaining({ reportPasscode: 'operator-report-passcode' }),
    );
  });

  test('dedicated transport errors never echo a report passcode in toast or logs', async () => {
    distributionProductConfig.feedbackUrl = 'https://feedback.example.test/v0/feedback';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (window as any).electron.feedback.submit.mockRejectedValue(new Error('operator-report-passcode leaked in transport'));
      const user = userEvent.setup();
      renderFeedbackPopover();
      await user.click(screen.getByRole('button', { name: 'Feedback' }));
      await user.type(await screen.findByLabelText('Message'), 'A complete report for support to inspect.');
      await user.type(screen.getByLabelText('Report passcode'), 'operator-report-passcode');
      await user.click(screen.getByRole('button', { name: 'Send Feedback' }));
      await waitFor(() => expect(errorLog).toHaveBeenCalled());
      expect(screen.queryByText(/operator-report-passcode/u)).not.toBeInTheDocument();
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('operator-report-passcode');
    } finally {
      errorLog.mockRestore();
    }
  });
});
