import { EventEmitter } from 'node:events';
import { describe, expect, mock, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';

import { ProgressiveBlur } from '../../apps/interpreter-overlay/runtime/infra/progressive-blur';

type MockProgressiveBlurProcess = ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    destroyed: boolean;
    writableEnded: boolean;
    write: ReturnType<typeof mock>;
  };
  kill: ReturnType<typeof mock>;
};

function createMockProgressiveBlurProcess(): MockProgressiveBlurProcess {
  const stdin = new EventEmitter() as MockProgressiveBlurProcess['stdin'];
  stdin.destroyed = false;
  stdin.writableEnded = false;
  stdin.write = mock(() => true);

  const child = new EventEmitter() as MockProgressiveBlurProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = stdin;
  child.kill = mock(() => true);
  return child;
}

async function startReadyProgressiveBlur(child: MockProgressiveBlurProcess): Promise<ProgressiveBlur> {
  const blur = new ProgressiveBlur({
    platform: 'darwin',
    getBinaryPath: () => '/tmp/progressive-blur',
    spawnProcess: () => child,
  });

  const ready = blur.start();
  child.stdout.emit('data', Buffer.from('ready\n'));
  await ready;
  return blur;
}

describe('ProgressiveBlur helper process writes', () => {
  test('does not throw when dispose writes exit to a closed helper pipe', async () => {
    const child = createMockProgressiveBlurProcess();
    const blur = await startReadyProgressiveBlur(child);

    child.stdin.write = mock(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    expect(() => blur.dispose()).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(blur.getDebugState().ready).toBe(false);
  });

  test('handles asynchronous helper stdin EPIPE events', async () => {
    const child = createMockProgressiveBlurProcess();
    const blur = await startReadyProgressiveBlur(child);

    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(blur.getDebugState().ready).toBe(false);
  });

  test('ignores stale helper events after a broken pipe restart', async () => {
    const firstChild = createMockProgressiveBlurProcess();
    const secondChild = createMockProgressiveBlurProcess();
    const children = [firstChild, secondChild];
    const blur = new ProgressiveBlur({
      platform: 'darwin',
      getBinaryPath: () => '/tmp/progressive-blur',
      spawnProcess: () => children.shift() ?? createMockProgressiveBlurProcess(),
    });

    const firstReady = blur.start();
    firstChild.stdout.emit('data', Buffer.from('ready\n'));
    await firstReady;

    firstChild.stdin.write = mock(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    blur.dispose();

    const secondReady = blur.start();
    let secondSettled = false;
    secondReady.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    firstChild.stdout.emit('data', Buffer.from('ready\n'));
    firstChild.emit('exit', 0, null);
    firstChild.emit('error', new Error('old helper launch failure'));
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(blur.getDebugState().ready).toBe(false);

    secondChild.stdout.emit('data', Buffer.from('ready\n'));
    await secondReady;

    expect(blur.getDebugState().ready).toBe(true);
    expect(secondChild.kill).not.toHaveBeenCalled();
  });

  test('does not hide unrelated synchronous helper write failures', async () => {
    const child = createMockProgressiveBlurProcess();
    const blur = await startReadyProgressiveBlur(child);

    child.stdin.write = mock(() => {
      throw new Error('permission denied');
    });

    expect(() => blur.dispose()).toThrow('permission denied');
    expect(child.kill).not.toHaveBeenCalled();
  });
});
