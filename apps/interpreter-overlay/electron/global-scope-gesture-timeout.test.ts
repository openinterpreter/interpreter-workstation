import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('overlay global scope gesture timeout', () => {
  test('keeps active slow drags alive based on last movement', async () => {
    const source = await readFile(
      join(process.cwd(), 'apps/interpreter-overlay/electron/service.ts'),
      'utf-8',
    );

    expect(source).toContain('lastActivityAt: number;');
    expect(source).toContain('const GLOBAL_SCOPE_GESTURE_ACTIVE_STALE_TIMEOUT_MS = 30000;');
    expect(source).toContain('this.globalScopeGesture.lastActivityAt = Date.now();');
    expect(source).toContain('this.scheduleGlobalScopeGestureTimeout(this.globalScopeGesture.lastActivityAt);');
    expect(source).toContain('gesture.lastActivityAt !== expectedLastActivityAt');
    expect(source).toContain('idleMs: Date.now() - gesture.lastActivityAt');

    const moveIndex = source.indexOf('this.globalScopeGesture.lastActivityAt = Date.now();');
    const scheduleIndex = source.indexOf('this.scheduleGlobalScopeGestureTimeout(this.globalScopeGesture.lastActivityAt);', moveIndex);
    const activeTimeoutIndex = source.indexOf('GLOBAL_SCOPE_GESTURE_ACTIVE_STALE_TIMEOUT_MS');
    const staleCompareIndex = source.indexOf('gesture.lastActivityAt !== expectedLastActivityAt');

    expect(moveIndex).toBeGreaterThan(-1);
    expect(scheduleIndex).toBeGreaterThan(moveIndex);
    expect(activeTimeoutIndex).toBeGreaterThan(-1);
    expect(staleCompareIndex).toBeGreaterThan(activeTimeoutIndex);
  });
});
