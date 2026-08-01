import { describe, expect, test, vi } from 'vitest';
import { IPC_CHANNELS } from './registry';
import { emitWorkspaceChanged } from './events';

const broadcastMock = vi.fn();
const sendToWindowMock = vi.fn(() => true);

vi.mock('../../server/utils/sse', () => ({
  broadcast: broadcastMock,
}));

vi.mock('../utils/safeIpcSend', () => ({
  sendToWindow: sendToWindowMock,
}));

describe('emitWorkspaceChanged', () => {
  test('emits a structured workspace event to the renderer and broadcast bridge', () => {
    const window = {} as any;

    emitWorkspaceChanged(window, '/workspace/demo');

    expect(sendToWindowMock).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.WORKSPACE_CHANGED,
      { workspacePath: '/workspace/demo' },
    );
    expect(broadcastMock).toHaveBeenCalledWith('workspace:changed', {
      workspacePath: '/workspace/demo',
    });
  });

  test('preserves null workspace paths in the structured event payload', () => {
    const window = {} as any;

    emitWorkspaceChanged(window, null);

    expect(sendToWindowMock).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.WORKSPACE_CHANGED,
      { workspacePath: null },
    );
    expect(broadcastMock).toHaveBeenCalledWith('workspace:changed', {
      workspacePath: null,
    });
  });
});
