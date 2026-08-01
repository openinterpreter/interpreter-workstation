import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { useAgentNotifications } from './useAgentNotifications';

type NotificationHandler = (event: {
  agentId: string;
  content: string;
  source: string;
}) => void;

let notificationHandler: NotificationHandler | null = null;

vi.mock('../../src/ipc', () => ({
  agentNotifications: {
    onNotification: (handler: NotificationHandler) => {
      notificationHandler = handler;
      return () => {
        if (notificationHandler === handler) {
          notificationHandler = null;
        }
      };
    },
  },
}));

function Harness(props: {
  isRunning: boolean;
  queueAfterNextTool: (text: string) => Promise<{ success: boolean }>;
  sendNow: (text: string) => void;
}) {
  useAgentNotifications({
    agentId: 'agent-1',
    isRunning: props.isRunning,
    queueAfterNextTool: props.queueAfterNextTool,
    sendNow: props.sendNow,
  });
  return null;
}

afterEach(() => {
  notificationHandler = null;
  vi.clearAllMocks();
});

describe('useAgentNotifications', () => {
  test('sends burst notifications after the first idle send as after-next-tool follow-ups', () => {
    const queueAfterNextTool = vi.fn(async () => ({ success: true }));
    const sendNow = vi.fn();

    const view = render(
      <Harness
        isRunning={false}
        queueAfterNextTool={queueAfterNextTool}
        sendNow={sendNow}
      />,
    );

    act(() => {
      notificationHandler?.({ agentId: 'agent-1', content: 'first', source: 'whatsapp' });
      notificationHandler?.({ agentId: 'agent-1', content: 'second', source: 'whatsapp' });
    });

    expect(sendNow).toHaveBeenCalledTimes(1);
    expect(sendNow).toHaveBeenCalledWith('first');
    expect(queueAfterNextTool).toHaveBeenCalledTimes(1);
    expect(queueAfterNextTool).toHaveBeenCalledWith('second');

    view.rerender(
      <Harness
        isRunning={true}
        queueAfterNextTool={queueAfterNextTool}
        sendNow={sendNow}
      />,
    );
    view.rerender(
      <Harness
        isRunning={false}
        queueAfterNextTool={queueAfterNextTool}
        sendNow={sendNow}
      />,
    );

    act(() => {
      notificationHandler?.({ agentId: 'agent-1', content: 'third', source: 'whatsapp' });
    });

    expect(sendNow).toHaveBeenCalledTimes(2);
    expect(sendNow).toHaveBeenLastCalledWith('third');
  });
});
