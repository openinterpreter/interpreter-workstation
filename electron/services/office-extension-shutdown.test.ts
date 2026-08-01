import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';
import { gracefulTerminateChild, waitForChildExit } from './office-extension-shutdown';

class FakeChildProcess extends EventEmitter {
  pid?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  markExited(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function asChildProcess(fake: FakeChildProcess): ChildProcess {
  return fake as unknown as ChildProcess;
}

describe('waitForChildExit', () => {
  test('returns true when child already exited', async () => {
    const child = new FakeChildProcess(1234);
    child.exitCode = 0;

    const result = await waitForChildExit(asChildProcess(child), 50);
    expect(result).toBe(true);
  });

  test('returns true when child exits before timeout', async () => {
    const child = new FakeChildProcess(1234);
    setTimeout(() => child.markExited(0, null), 10);

    const result = await waitForChildExit(asChildProcess(child), 100);
    expect(result).toBe(true);
  });

  test('returns false when child does not exit before timeout', async () => {
    const child = new FakeChildProcess(1234);

    const result = await waitForChildExit(asChildProcess(child), 20);
    expect(result).toBe(false);
  });
});

describe('gracefulTerminateChild', () => {
  test('does not send SIGKILL when child exits after SIGTERM', async () => {
    const child = new FakeChildProcess(1111);
    setTimeout(() => child.markExited(0, null), 10);
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await gracefulTerminateChild(asChildProcess(child), {
      termTimeoutMs: 100,
      killTimeoutMs: 20,
      sendSignal: (pid, signal) => sentSignals.push({ pid, signal }),
    });

    expect(result).toEqual({ exitedAfterTerm: true, sentSigkill: false });
    expect(sentSignals).toEqual([]);
  });

  test('sends SIGKILL when child does not exit after SIGTERM timeout', async () => {
    const child = new FakeChildProcess(2222);
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const resultPromise = gracefulTerminateChild(asChildProcess(child), {
      termTimeoutMs: 20,
      killTimeoutMs: 100,
      sendSignal: (pid, signal) => {
        sentSignals.push({ pid, signal });
        if (signal === 'SIGKILL') {
          setTimeout(() => child.markExited(null, 'SIGKILL'), 10);
        }
      },
    });

    const result = await resultPromise;

    expect(result).toEqual({ exitedAfterTerm: false, sentSigkill: true });
    expect(sentSignals).toEqual([{ pid: 2222, signal: 'SIGKILL' }]);
  });

  test('handles SIGKILL signal failure without throwing', async () => {
    const child = new FakeChildProcess(3333);

    const result = await gracefulTerminateChild(asChildProcess(child), {
      termTimeoutMs: 10,
      killTimeoutMs: 10,
      sendSignal: () => {
        throw new Error('signal failed');
      },
    });

    expect(result).toEqual({ exitedAfterTerm: false, sentSigkill: false });
  });
});
