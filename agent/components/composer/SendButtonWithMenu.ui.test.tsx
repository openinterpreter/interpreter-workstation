import type { HTMLAttributes, ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { SendButtonWithMenu } from './SendButtonWithMenu';
import { MAIN_COMPOSER_SEND_BUTTON_ID } from '../../../shared/element-ids';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

describe('SendButtonWithMenu', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('interrupts and sends immediately when clicking primary send during an active turn', () => {
    const onSend = vi.fn();
    const onSendAfterNextTool = vi.fn();
    const onInterruptAndSendImmediately = vi.fn();

    render(
      <SendButtonWithMenu
        isStreaming={true}
        hasInput={true}
        hasQueue={false}
        onSend={onSend}
        onSendAfterNextTool={onSendAfterNextTool}
        onQueueForEndOfTurn={vi.fn()}
        onInterruptAndSendImmediately={onInterruptAndSendImmediately}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId(MAIN_COMPOSER_SEND_BUTTON_ID));

    expect(onInterruptAndSendImmediately).toHaveBeenCalledTimes(1);
    expect(onSendAfterNextTool).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  test('keeps the non-interrupting after-next-tool action in the active-turn hover menu', () => {
    vi.useFakeTimers();
    const onSendAfterNextTool = vi.fn();

    render(
      <SendButtonWithMenu
        isStreaming={true}
        hasInput={true}
        hasQueue={false}
        onSend={vi.fn()}
        onSendAfterNextTool={onSendAfterNextTool}
        onQueueForEndOfTurn={vi.fn()}
        onInterruptAndSendImmediately={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    const menuContainer = screen.getByTestId(MAIN_COMPOSER_SEND_BUTTON_ID).closest('.relative');
    expect(menuContainer).toBeTruthy();
    fireEvent.mouseEnter(menuContainer!);
    act(() => {
      vi.advanceTimersByTime(400);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send after next tool call' }));

    expect(onSendAfterNextTool).toHaveBeenCalledTimes(1);
  });
});
