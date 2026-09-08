import { beforeEach, describe, expect, test, vi } from 'vitest';

const ipcMock = vi.hoisted(() => ({
  getApiUrl: vi.fn(async (path: string) => path),
}));

vi.mock('../../src/ipc', () => ipcMock);

import { executeThreadGoalCommand, parseThreadGoalCommand } from './threadGoalCommand';

describe('thread goal slash commands', () => {
  test('parses set, clear, pause, and resume commands without matching prose', () => {
    expect(parseThreadGoalCommand('/goal Ship the release')).toEqual({
      kind: 'set',
      objective: 'Ship the release',
    });
    expect(parseThreadGoalCommand('/goal set Ship the release')).toEqual({
      kind: 'set',
      objective: 'Ship the release',
    });
    expect(parseThreadGoalCommand('/goal clear')).toEqual({ kind: 'clear' });
    expect(parseThreadGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
    expect(parseThreadGoalCommand('/goal resume')).toEqual({ kind: 'resume' });
    expect(parseThreadGoalCommand('Please use /goal Ship the release')).toBeNull();
  });

  test('returns a local usage error for a bare /goal command', () => {
    expect(parseThreadGoalCommand('/goal')).toMatchObject({ kind: 'invalid' });
  });
});

describe('executeThreadGoalCommand', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  test('sets a goal through the thread endpoint without sending a model message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ goal: {} }), { status: 200 }));

    await expect(executeThreadGoalCommand('thread/one', '/goal Build the demo')).resolves.toEqual({
      kind: 'set',
      objective: 'Build the demo',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/threads/thread%2Fone/goal',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({ objective: 'Build the demo', status: 'active' }),
      }),
    );
  });

  test('uses the goal endpoint for lifecycle commands', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ goal: {} }), { status: 200 }));

    await executeThreadGoalCommand('thread-one', '/goal pause');
    await executeThreadGoalCommand('thread-one', '/goal resume');
    await executeThreadGoalCommand('thread-one', '/goal clear');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/agent/threads/thread-one/goal',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'paused' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/agent/threads/thread-one/goal',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'active' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/agent/threads/thread-one/goal',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
