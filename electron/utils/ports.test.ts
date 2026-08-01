import { describe, expect, test } from 'bun:test';
import { getCurrentProcessPortCleanupExclusions, killPortProcessSync } from './ports';

describe('killPortProcessSync', () => {
  test('returns current process cleanup exclusions from pid and parent pid', () => {
    expect(getCurrentProcessPortCleanupExclusions({ pid: 1234, ppid: 5678 })).toEqual([1234, 5678]);
  });

  test('filters invalid current process cleanup exclusions', () => {
    expect(getCurrentProcessPortCleanupExclusions({
      pid: 0,
      ppid: -1,
    })).toEqual([]);
  });

  test('kills each unique PID on Windows for the target port', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'netstat -ano | findstr :38123') {
        return [
          '  TCP    0.0.0.0:38123   0.0.0.0:0   LISTENING   1234',
          '  TCP    [::]:38123      [::]:0      LISTENING   1234',
          '  TCP    127.0.0.1:38123 127.0.0.1:5555 ESTABLISHED 9876',
        ].join('\n');
      }
      return '';
    };

    killPortProcessSync(38123, { platform: 'win32', exec: run, kill: (pid) => { killedPids.push(pid); } });

    expect(commands).toEqual(['netstat -ano | findstr :38123']);
    expect(killedPids).toEqual([1234, 9876]);
  });

  test('kills all PIDs returned by lsof on non-Windows', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'lsof -ti:38123') {
        return '4321\n8765\n';
      }
      return '';
    };

    killPortProcessSync(38123, { platform: 'darwin', exec: run, kill: (pid) => { killedPids.push(pid); } });

    expect(commands).toEqual(['lsof -ti:38123']);
    expect(killedPids).toEqual([4321, 8765]);
  });

  test('skips excluded PIDs when clearing a port', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'lsof -ti:38123') {
        return '4321\n8765\n';
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'darwin',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
      excludePids: [4321],
    });

    expect(commands).toEqual(['lsof -ti:38123']);
    expect(killedPids).toEqual([8765]);
  });

  test('skips current and parent process PIDs on non-Windows', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'lsof -ti:38123') {
        return '1234\n5678\n9012\n';
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'darwin',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
      excludePids: getCurrentProcessPortCleanupExclusions({ pid: 1234, ppid: 5678 }),
    });

    expect(commands).toEqual(['lsof -ti:38123']);
    expect(killedPids).toEqual([9012]);
  });

  test('skips current and parent process PIDs on Windows', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'netstat -ano | findstr :38123') {
        return [
          '  TCP    0.0.0.0:38123   0.0.0.0:0   LISTENING   1234',
          '  TCP    [::]:38123      [::]:0      LISTENING   5678',
          '  TCP    127.0.0.1:38123 127.0.0.1:5555 ESTABLISHED 9012',
        ].join('\n');
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'win32',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
      excludePids: getCurrentProcessPortCleanupExclusions({ pid: 1234, ppid: 5678 }),
    });

    expect(commands).toEqual(['netstat -ano | findstr :38123']);
    expect(killedPids).toEqual([9012]);
  });

  test('normalizes invalid excluded PIDs before clearing a port', () => {
    const killedPids: number[] = [];
    const run = (command: string): string => {
      if (command === 'lsof -ti:38123') {
        return '1234\n5678\n';
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'darwin',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
      excludePids: [0, -1, Number.NaN, 1234],
    });

    expect(killedPids).toEqual([5678]);
  });

  test('does not kill anything when every discovered PID is excluded', () => {
    const killedPids: number[] = [];
    const run = (command: string): string => {
      if (command === 'lsof -ti:38123') {
        return '1234\n5678\n';
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'darwin',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
      excludePids: getCurrentProcessPortCleanupExclusions({ pid: 1234, ppid: 5678 }),
    });

    expect(killedPids).toEqual([]);
  });

  test('applies current process exclusions across multiple non-Windows ports', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'lsof -ti:3333') {
        return '1234\n33330\n';
      }
      if (command === 'lsof -ti:8089') {
        return '5678\n80890\n';
      }
      return '';
    };

    killPortProcessSync([3333, 8089], {
      platform: 'linux',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
      excludePids: getCurrentProcessPortCleanupExclusions({ pid: 1234, ppid: 5678 }),
    });

    expect(commands).toEqual(['lsof -ti:3333', 'lsof -ti:8089']);
    expect(killedPids).toEqual([33330, 80890]);
  });

  test('ignores malformed non-Windows PID output', () => {
    const killedPids: number[] = [];
    const run = (command: string): string => {
      if (command === 'lsof -ti:38123') {
        return 'abc\n0\n1234\n';
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'darwin',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
    });

    expect(killedPids).toEqual([1234]);
  });

  test('ignores malformed Windows PID output', () => {
    const killedPids: number[] = [];
    const run = (command: string): string => {
      if (command === 'netstat -ano | findstr :38123') {
        return [
          '  TCP    0.0.0.0:38123   0.0.0.0:0   LISTENING   abc',
          '  TCP    [::]:38123      [::]:0      LISTENING   0',
          '  TCP    127.0.0.1:38123 127.0.0.1:5555 ESTABLISHED 1234',
        ].join('\n');
      }
      return '';
    };

    killPortProcessSync(38123, {
      platform: 'win32',
      exec: run,
      kill: (pid) => { killedPids.push(pid); },
    });

    expect(killedPids).toEqual([1234]);
  });

  test('continues when a port lookup command fails', () => {
    const commands: string[] = [];
    const killedPids: number[] = [];
    const run = (command: string): string => {
      commands.push(command);
      if (command === 'lsof -ti:38123') {
        throw new Error('lookup failed');
      }
      return '';
    };

    killPortProcessSync([38123, 38124], { platform: 'darwin', exec: run, kill: (pid) => { killedPids.push(pid); } });

    expect(commands).toEqual(['lsof -ti:38123', 'lsof -ti:38124']);
    expect(killedPids).toEqual([]);
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe('killPortProcessSync (integration)', () => {
  test('kills a discovered subprocess with the default process.kill path', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', '-e', 'setInterval(() => {}, 60000);'],
    });

    try {
      expect(isProcessAlive(proc.pid)).toBe(true);

      // NOTE(victor): bun test sandboxes execSync so lsof returns empty -- feed
      // the known PID via exec, but let process.kill (the real default) do the kill.
      killPortProcessSync(38123, {
        exec: () => String(proc.pid),
      });

      expect(await waitForProcessExit(proc.pid)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited.catch(() => {});
    }
  });
});
