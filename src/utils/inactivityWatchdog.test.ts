import { beforeEach, describe, expect, test } from 'bun:test';
import { createInactivityWatchdog } from './inactivityWatchdog';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createInactivityWatchdog', () => {
  let callCount: number;
  let watchdog: ReturnType<typeof createInactivityWatchdog>;

  beforeEach(() => {
    callCount = 0;
    watchdog = createInactivityWatchdog(25, () => {
      callCount += 1;
    });
  });

  test('fires after inactivity', async () => {
    watchdog.poke();
    await wait(40);
    expect(callCount).toBe(1);
  });

  test('resets timer on repeated activity', async () => {
    watchdog.poke();
    await wait(15);
    watchdog.poke();
    await wait(15);
    expect(callCount).toBe(0);
    await wait(20);
    expect(callCount).toBe(1);
  });

  test('clear cancels pending timeout', async () => {
    watchdog.poke();
    watchdog.clear();
    await wait(40);
    expect(callCount).toBe(0);
  });
});
