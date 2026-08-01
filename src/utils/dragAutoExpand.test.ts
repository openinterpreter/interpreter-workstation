import { describe, test, expect, beforeEach } from 'bun:test';
import { DragAutoExpandTimer, DRAG_AUTO_EXPAND_DELAY } from './dragAutoExpand';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AFTER_DELAY = DRAG_AUTO_EXPAND_DELAY + 50;

describe('DragAutoExpandTimer', () => {
  let timer: DragAutoExpandTimer;

  beforeEach(() => {
    timer = new DragAutoExpandTimer();
  });

  test('should start timer on first drag enter', () => {
    timer.start(() => {});
    expect(timer.isRunning).toBe(true);
    expect(timer.counter).toBe(1);
    timer.clear();
  });

  test('should increment counter on multiple drag enters', () => {
    timer.start(() => {});
    timer.start(() => {});
    expect(timer.counter).toBe(2);
    timer.clear();
  });

  test('should not restart timer on second drag enter', () => {
    timer.start(() => {});
    expect(timer.isRunning).toBe(true);
    timer.start(() => {});
    expect(timer.isRunning).toBe(true);
    expect(timer.counter).toBe(2);
    timer.clear();
  });

  test('should cancel timer when drag counter reaches zero', () => {
    timer.start(() => {});
    timer.leave();
    expect(timer.isRunning).toBe(false);
    expect(timer.counter).toBe(0);
  });

  test('should not cancel when counter still positive', () => {
    timer.start(() => {});
    timer.start(() => {});
    timer.leave();
    expect(timer.isRunning).toBe(true);
    expect(timer.counter).toBe(1);
    timer.clear();
  });

  test('should fire onExpand after delay', async () => {
    let called = false;
    timer.start(() => {
      called = true;
    });
    await wait(AFTER_DELAY);
    expect(called).toBe(true);
    expect(timer.isRunning).toBe(false);
  });

  test('should not fire onExpand if cleared before delay', async () => {
    let called = false;
    timer.start(() => {
      called = true;
    });
    timer.clear();
    await wait(AFTER_DELAY);
    expect(called).toBe(false);
  });

  test('should not fire onExpand if drag leaves before delay', async () => {
    let called = false;
    timer.start(() => {
      called = true;
    });
    timer.leave();
    await wait(AFTER_DELAY);
    expect(called).toBe(false);
  });

  test('should reset all state on clear', () => {
    timer.start(() => {});
    timer.start(() => {});
    timer.start(() => {});
    expect(timer.counter).toBe(3);
    expect(timer.isRunning).toBe(true);
    timer.clear();
    expect(timer.counter).toBe(0);
    expect(timer.isRunning).toBe(false);
  });

  test('should handle negative counter gracefully', () => {
    timer.leave();
    expect(timer.counter).toBe(0);
    expect(timer.isRunning).toBe(false);
  });
});
