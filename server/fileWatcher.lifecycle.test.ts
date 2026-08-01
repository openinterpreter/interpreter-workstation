import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { FileWatcherManager } = await import('./fileWatcher');

class TestLifecycleFileWatcherManager extends FileWatcherManager {
  constructor(
    private readonly subscribeImpl: () => Promise<{ unsubscribe: () => Promise<void> }>,
  ) {
    super();
  }

  protected override async subscribe(): Promise<{ unsubscribe: () => Promise<void> }> {
    return this.subscribeImpl();
  }
}

describe('FileWatcherManager lifecycle serialization', () => {
  let watcher: TestLifecycleFileWatcherManager;
  let testDir: string;
  let subscribeCallCount: number;
  let subscribeImpl: () => Promise<{ unsubscribe: () => Promise<void> }>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'file-watcher-lifecycle-'));
    subscribeCallCount = 0;
    subscribeImpl = async () => ({
      unsubscribe: async () => {},
    });
    watcher = new TestLifecycleFileWatcherManager(async () => {
      subscribeCallCount += 1;
      return subscribeImpl();
    });
    watcher.setWorkspaceOverride(testDir);
  });

  afterEach(async () => {
    await watcher.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test('concurrent start() calls serialize subscribe and unsubscribe work', async () => {
    const operations: string[] = [];
    let resolveFirstUnsubscribeStarted!: () => void;
    const firstUnsubscribeStarted = new Promise<void>((resolve) => {
      resolveFirstUnsubscribeStarted = resolve;
    });
    let releaseFirstUnsubscribe: (() => void) | null = null;

    subscribeImpl = async () => {
      const currentId = subscribeCallCount;
      operations.push(`subscribe:${currentId}`);

      return {
        unsubscribe: async () => {
          operations.push(`unsubscribe:${currentId}:start`);
          if (currentId === 1) {
            resolveFirstUnsubscribeStarted();
            await new Promise<void>((resolve) => {
              releaseFirstUnsubscribe = () => {
                operations.push(`unsubscribe:${currentId}:end`);
                resolve();
              };
            });
            return;
          }

          operations.push(`unsubscribe:${currentId}:end`);
        },
      };
    };

    const firstStart = watcher.start(() => {});
    const secondStart = watcher.start(() => {});

    await firstUnsubscribeStarted;

    expect(subscribeCallCount).toBe(1);
    expect(operations).toEqual(['subscribe:1', 'unsubscribe:1:start']);

    releaseFirstUnsubscribe?.();
    await Promise.all([firstStart, secondStart]);

    expect(operations).toEqual([
      'subscribe:1',
      'unsubscribe:1:start',
      'unsubscribe:1:end',
      'subscribe:2',
    ]);
    expect(subscribeCallCount).toBe(2);
    expect(watcher.isWatching()).toBe(true);
  });
});
