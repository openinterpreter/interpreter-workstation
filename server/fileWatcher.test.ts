// Unit tests for FileWatcherManager - @parcel/watcher implementation
// Tests verify main branch parity: full recursive watching with addPath/removePath as no-ops
// Test patterns adapted from VSCode's file watcher tests

import { mkdtemp, mkdir, rm, writeFile, rename, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcherManager } from './fileWatcher';

type EventRecord = { type: string; path: string; mtime?: number };

// NOTE(victor): Test subclass with faster debounce - VSCode pattern for reducing test flakiness
class TestFileWatcherManager extends FileWatcherManager {
  protected override readonly DEBOUNCE_MS = 20;
}

// NOTE(victor): Helper to wait for events with timeout and cleanup - adapted from VSCode's awaitEvent pattern
const waitForEvent = (
  events: EventRecord[],
  predicate: (e: EventRecord) => boolean,
  timeout = 2000
): Promise<EventRecord> => {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) {
        return reject(new Error(`Event timeout. Events received: ${JSON.stringify(events)}`));
      }
      setTimeout(check, 20);
    };
    check();
  });
};

// NOTE(victor): Wait for events to settle (no new events for duration)
const waitForQuiet = (events: EventRecord[], duration = 150): Promise<void> => {
  return new Promise((resolve) => {
    let lastCount = events.length;
    const check = () => {
      if (events.length === lastCount) {
        resolve();
      } else {
        lastCount = events.length;
        setTimeout(check, duration);
      }
    };
    setTimeout(check, duration);
  });
};

// NOTE(victor): Some platforms can deliver late startup addDir events well after
// subscribe() resolves. For pre-existing path deletion tests, wait for a quiet
// window after a minimum startup delay so we don't delete during the initial crawl.
const waitForWatcherStartupToSettle = async (
  events: EventRecord[],
  {
    minimumWaitMs = 1000,
    quietMs = 250,
    maxWaitMs = 3000,
  }: {
    minimumWaitMs?: number;
    quietMs?: number;
    maxWaitMs?: number;
  } = {}
): Promise<void> => {
  const startedAt = Date.now();
  let lastChangeAt = startedAt;
  let lastCount = events.length;

  while (Date.now() - startedAt <= maxWaitMs) {
    if (events.length !== lastCount) {
      lastCount = events.length;
      lastChangeAt = Date.now();
    }

    const elapsedMs = Date.now() - startedAt;
    const quietForMs = Date.now() - lastChangeAt;
    if (elapsedMs >= minimumWaitMs && quietForMs >= quietMs) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Watcher startup did not settle. Events received: ${JSON.stringify(events)}`);
};

describe('FileWatcherManager - Main Branch Parity', () => {
  let testDir: string;
  let watcher: TestFileWatcherManager;
  let events: EventRecord[];

  beforeEach(async () => {
    // NOTE(victor): Use realpath to resolve symlinks (macOS: /var -> /private/var)
    // This ensures paths match between mkdtemp and @parcel/watcher events
    const tmpDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    testDir = await realpath(tmpDir);
    events = [];
    watcher = new TestFileWatcherManager();
    watcher.setWorkspaceOverride(testDir);
  });

  afterEach(async () => {
    await watcher.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  // ===== LIFECYCLE TESTS =====

  describe('lifecycle', () => {
    test('start() begins watching, isWatching() returns true', async () => {
      expect(watcher.isWatching()).toBe(false);
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      expect(watcher.isWatching()).toBe(true);
    });

    test('stop() stops watching, isWatching() returns false', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      expect(watcher.isWatching()).toBe(true);
      await watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });

    test('start() with no workspace does not start watcher', async () => {
      watcher.setWorkspaceOverride(null);
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      expect(watcher.isWatching()).toBe(false);
    });

    test('stop() when not watching is safe', async () => {
      await watcher.stop();
      expect(watcher.isWatching()).toBe(false);
    });

    test('concurrent stop() calls only unsubscribe once', async () => {
      let unsubscribeCalls = 0;
      (watcher as any).subscription = {
        unsubscribe: async () => {
          unsubscribeCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      };

      await Promise.all([watcher.stop(), watcher.stop()]);

      expect(unsubscribeCalls).toBe(1);
      expect(watcher.isWatching()).toBe(false);
    });

    test('multiple start() calls clean up previous watcher', async () => {
      const events1: EventRecord[] = [];
      await watcher.start((type, path, mtime) => events1.push({ type, path, mtime }));

      const events2: EventRecord[] = [];
      await watcher.start((type, path, mtime) => events2.push({ type, path, mtime }));

      await writeFile(join(testDir, 'test.txt'), 'content');
      await new Promise((r) => setTimeout(r, 500));

      expect(events1.length).toBe(0);
      expect(events2.length).toBeGreaterThan(0);
    });
  });

  // ===== API COMPATIBILITY TESTS =====

  describe('API compatibility (no-ops)', () => {
    test('addPath() is a no-op', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      watcher.addPath(join(testDir, 'some-folder'));
      expect(watcher.isWatching()).toBe(true);
    });

    test('removePath() is a no-op', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      watcher.removePath(join(testDir, 'some-folder'));
      expect(watcher.isWatching()).toBe(true);
    });
  });

  // ===== FILE EVENT TESTS =====

  describe('file events', () => {
    test('file creation emits "add" with mtime', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const testFile = join(testDir, 'new-file.txt');
      await writeFile(testFile, 'content');

      const event = await waitForEvent(events, (e) => e.path === 'new-file.txt');
      expect(event.type).toBe('add');
      expect(event.mtime).toBeGreaterThan(0);
    });

    test('file modification emits "change" with mtime', async () => {
      const testFile = join(testDir, 'existing-file.txt');
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      await writeFile(testFile, 'initial');
      await waitForEvent(events, (e) => e.path === 'existing-file.txt' && e.type === 'add');
      events.length = 0;

      await writeFile(testFile, 'modified');

      const event = await waitForEvent(
        events,
        (e) => e.path === 'existing-file.txt' && e.type === 'change'
      );
      expect(event.type).toBe('change');
      expect(event.mtime).toBeGreaterThan(0);
    });

    test('file deletion emits "unlink" without mtime', async () => {
      const testFile = join(testDir, 'to-delete.txt');
      await writeFile(testFile, 'content');

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await rm(testFile);

      const event = await waitForEvent(events, (e) => e.path === 'to-delete.txt');
      expect(event.type).toBe('unlink');
      expect(event.mtime).toBeUndefined();
    });
  });

  // ===== DIRECTORY EVENT TESTS =====

  describe('directory events', () => {
    test('directory creation emits "addDir"', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const newDir = join(testDir, 'new-dir');
      await mkdir(newDir);

      const event = await waitForEvent(events, (e) => e.path === 'new-dir');
      expect(event.type).toBe('addDir');
    });

    test('directory deletion emits "unlink" (same as files)', async () => {
      // NOTE(victor): We emit 'unlink' for both files and directories because:
      // 1. @parcel/watcher doesn't provide file type on delete cross-platform (Windows limitation)
      // 2. Our consumers (Explorer, LayoutContext) handle them identically
      // 3. This follows VS Code's approach for recursive watchers
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const subDir = join(testDir, 'temp-dir');
      await mkdir(subDir);

      await waitForEvent(events, (e) => e.path === 'temp-dir' && e.type === 'addDir');

      await rm(subDir, { recursive: true });

      const deleteEvent = await waitForEvent(
        events,
        (e) => e.path === 'temp-dir' && e.type === 'unlink'
      );
      expect(deleteEvent.type).toBe('unlink');
    });

    test('pre-existing directory deletion emits "unlink"', async () => {
      const existingDir = join(testDir, 'existing-dir');
      await mkdir(existingDir);

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      // Allow startup events to flush before exercising deletion to avoid
      // subscription-settle races on slower CI runners (notably macOS).
      await waitForWatcherStartupToSettle(events);
      events.length = 0;

      await rm(existingDir, { recursive: true });

      const event = await waitForEvent(events, (e) => e.path === 'existing-dir');
      expect(event.type).toBe('unlink');
    });

    test('nested directory deletion emits "unlink"', async () => {
      const level1 = join(testDir, 'level1');
      const level2 = join(level1, 'level2');
      await mkdir(level2, { recursive: true });

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      await waitForWatcherStartupToSettle(events);
      events.length = 0;

      await rm(level2, { recursive: true });

      const event = await waitForEvent(events, (e) => {
        const nestedPath = ['level1', 'level2'].join(sep);
        const parentPath = 'level1';
        return (e.path === nestedPath || e.path === parentPath) && e.type === 'unlink';
      });
      expect(event.type).toBe('unlink');
    });
  });

  // ===== RECURSIVE WATCHING TESTS =====

  describe('recursive watching', () => {
    test('emits events for nested files', async () => {
      const nestedDir = join(testDir, 'level1', 'level2');
      await mkdir(nestedDir, { recursive: true });

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const nestedFile = join(nestedDir, 'nested.txt');
      await writeFile(nestedFile, 'content');

      const expectedPath = ['level1', 'level2', 'nested.txt'].join(sep);
      const event = await waitForEvent(events, (e) => e.path === expectedPath);
      expect(event.type).toBe('add');
    });

    test('emits events for deeply nested new directories', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const deepDir = join(testDir, 'a', 'b', 'c');
      await mkdir(deepDir, { recursive: true });

      // NOTE(victor): mkdir recursive creates atomically; Linux only emits top-level addDir
      await waitForEvent(events, (e) => e.path.startsWith('a') && e.type === 'addDir');
    });

    test('emits events without visibleFolders filtering (main branch parity)', async () => {
      // NOTE(victor): Main branch emits ALL events recursively, not just "visible" folders
      const nestedDir = join(testDir, 'deep', 'nested', 'folder');
      await mkdir(nestedDir, { recursive: true });

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      // Create file in deep nested folder - should emit without calling addPath
      const nestedFile = join(nestedDir, 'file.txt');
      await writeFile(nestedFile, 'content');

      const expectedPath = ['deep', 'nested', 'folder', 'file.txt'].join(sep);
      const event = await waitForEvent(events, (e) => e.path === expectedPath);
      expect(event.type).toBe('add');
    });
  });

  // ===== PATH FORMAT TESTS =====

  describe('path format', () => {
    test('paths are relative to workspace', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await writeFile(join(testDir, 'file.txt'), 'content');

      const event = await waitForEvent(events, (e) => e.type === 'add');
      expect(event.path).toBe('file.txt');
      expect(event.path).not.toContain(testDir);
    });
  });

  // ===== IGNORE PATTERN TESTS =====

  describe('ignore patterns', () => {
    test('ignores dotfiles', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await writeFile(join(testDir, '.hidden'), 'content');
      await writeFile(join(testDir, 'visible.txt'), 'content');

      await waitForEvent(events, (e) => e.path === 'visible.txt');
      await new Promise((r) => setTimeout(r, 200));

      expect(events.find((e) => e.path === '.hidden')).toBeUndefined();
    });

    test('ignores node_modules', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'pkg.json'), '{}');
      await writeFile(join(testDir, 'visible.txt'), 'content');

      await waitForEvent(events, (e) => e.path === 'visible.txt');
      await new Promise((r) => setTimeout(r, 200));

      expect(events.find((e) => e.path.includes('node_modules'))).toBeUndefined();
    });

    test('ignores .git directory', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await mkdir(join(testDir, '.git'), { recursive: true });
      await writeFile(join(testDir, '.git', 'config'), 'content');
      await writeFile(join(testDir, 'visible.txt'), 'content');

      await waitForEvent(events, (e) => e.path === 'visible.txt');
      await new Promise((r) => setTimeout(r, 200));

      expect(events.find((e) => e.path.includes('.git'))).toBeUndefined();
    });

    test('ignores AppData directory', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await mkdir(join(testDir, 'AppData', 'Roaming'), { recursive: true });
      await writeFile(join(testDir, 'AppData', 'Roaming', 'noise.txt'), 'content');
      await writeFile(join(testDir, 'visible.txt'), 'content');

      await waitForEvent(events, (e) => e.path === 'visible.txt');
      await new Promise((r) => setTimeout(r, 200));

      expect(events.find((e) => e.path.includes('AppData'))).toBeUndefined();
    });
  });

  // ===== INITIAL STATE TESTS =====

  describe('initial state', () => {
    test('does not emit events for pre-existing files (ignoreInitial behavior)', async () => {
      await writeFile(join(testDir, 'pre-existing.txt'), 'content');

      // NOTE(victor): Allow file system to settle before starting watcher
      // @parcel/watcher may pick up very recent changes otherwise
      await new Promise((r) => setTimeout(r, 100));

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await new Promise((r) => setTimeout(r, 500));

      expect(events.find((e) => e.path === 'pre-existing.txt')).toBeUndefined();
    });
  });

  // ===== EDGE CASES =====

  describe('edge cases', () => {
    test('file rename emits unlink + add', async () => {
      const oldPath = join(testDir, 'old.txt');
      await writeFile(oldPath, 'content');

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await rename(oldPath, join(testDir, 'new.txt'));

      await waitForEvent(events, (e) => e.path === 'old.txt' && e.type === 'unlink');
      await waitForEvent(events, (e) => e.path === 'new.txt' && e.type === 'add');
    });

    test('concurrent file creations all emit events', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          writeFile(join(testDir, `concurrent-${i}.txt`), 'content')
        )
      );

      await new Promise((r) => setTimeout(r, 1000));

      for (let i = 0; i < 5; i++) {
        expect(events.find((e) => e.path === `concurrent-${i}.txt`)).toBeDefined();
      }
    });

    // NOTE(victor): VSCode pattern - atomic writes (common in editors that write to temp then rename)
    test('atomic write (delete + recreate) coalesces to change', async () => {
      const testFile = join(testDir, 'atomic.txt');
      await writeFile(testFile, 'original');

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      await new Promise((r) => setTimeout(r, 100));

      // Simulate atomic write: delete then immediately recreate
      await rm(testFile);
      await writeFile(testFile, 'updated');

      await waitForQuiet(events);

      // Should see either a single 'change' or 'add' (recreate), not both delete and add separately
      const fileEvents = events.filter((e) => e.path === 'atomic.txt');
      const lastEvent = fileEvents[fileEvents.length - 1];
      expect(['change', 'add']).toContain(lastEvent?.type);
    });

    test('atomic temp-file rename does not emit unlink for destination file', async () => {
      const testFile = join(testDir, 'note.md');
      const tempFile = join(testDir, 'note.md.tmp');
      await writeFile(testFile, 'original');

      await new Promise((r) => setTimeout(r, 100));
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));
      await new Promise((r) => setTimeout(r, 300));
      events.length = 0;

      await writeFile(tempFile, 'updated');
      await rename(tempFile, testFile);

      await waitForEvent(
        events,
        (e) => e.path === 'note.md' && (e.type === 'add' || e.type === 'change')
      );
      await waitForQuiet(events);

      const destinationEvents = events.filter((e) => e.path === 'note.md');
      const relatedEvents = events.filter(
        (e) => e.path === 'note.md' || e.path === 'note.md.tmp'
      );
      expect(destinationEvents.some((e) => e.type === 'unlink')).toBe(false);
      expect(relatedEvents.length).toBeGreaterThan(0);
    });

    // NOTE(victor): VSCode pattern - rapid create+delete should not emit spurious events
    test('create followed by immediate delete emits unlink (or nothing)', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const testFile = join(testDir, 'ephemeral.txt');

      // Create and immediately delete within debounce window
      await writeFile(testFile, 'temp');
      await rm(testFile);

      await waitForQuiet(events);

      // Should either emit nothing (coalesced away) or just unlink (latest wins)
      const fileEvents = events.filter((e) => e.path === 'ephemeral.txt');
      if (fileEvents.length > 0) {
        const lastEvent = fileEvents[fileEvents.length - 1];
        expect(lastEvent?.type).toBe('unlink');
      }
    });

    // NOTE(victor): VSCode pattern - handle case where stat fails during event processing
    test('handles stat failure gracefully (file deleted before processing)', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const testFile = join(testDir, 'vanishing.txt');
      await writeFile(testFile, 'content');

      // Wait for create event
      await waitForEvent(events, (e) => e.path === 'vanishing.txt' && e.type === 'add');

      // Delete file - should not throw during event processing
      await rm(testFile);

      await waitForEvent(events, (e) => e.path === 'vanishing.txt' && e.type === 'unlink');
    });
  });

  // ===== DEBOUNCING TESTS =====

  describe('debouncing', () => {
    test('rapid changes to same file are coalesced', async () => {
      const testFile = join(testDir, 'rapid-change.txt');
      await writeFile(testFile, 'initial');

      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      // Rapid writes within debounce window (100ms)
      await writeFile(testFile, 'change1');
      await writeFile(testFile, 'change2');
      await writeFile(testFile, 'change3');

      // Wait for debounce to flush (100ms) plus processing time
      await new Promise((r) => setTimeout(r, 300));

      // Should have coalesced into single event (or very few)
      const changeEvents = events.filter(
        (e) => e.path === 'rapid-change.txt' && e.type === 'change'
      );
      expect(changeEvents.length).toBeLessThanOrEqual(2);
    });

    test('events for different paths within debounce window are all emitted', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      // Create multiple files rapidly
      await writeFile(join(testDir, 'file-a.txt'), 'a');
      await writeFile(join(testDir, 'file-b.txt'), 'b');
      await writeFile(join(testDir, 'file-c.txt'), 'c');

      // Wait for debounce + processing
      await new Promise((r) => setTimeout(r, 500));

      // All files should have events (not coalesced since different paths)
      expect(events.find((e) => e.path === 'file-a.txt')).toBeDefined();
      expect(events.find((e) => e.path === 'file-b.txt')).toBeDefined();
      expect(events.find((e) => e.path === 'file-c.txt')).toBeDefined();
    });

    test('a delete becomes the final event after a prior create', async () => {
      await watcher.start((type, path, mtime) => events.push({ type, path, mtime }));

      const testFile = join(testDir, 'create-delete.txt');

      // Create file and wait for watcher to see it
      await writeFile(testFile, 'content');
      await new Promise((r) => setTimeout(r, 500));

      // Delete after the create has settled. Native watcher delivery time varies
      // under CI load, especially on macOS, so wait for the contract event
      // instead of assuming it will arrive within a fixed 300ms sleep.
      await rm(testFile);
      await waitForEvent(
        events,
        (event) => event.path === 'create-delete.txt' && event.type === 'unlink'
      );

      // The delete should be the final event for this path
      const fileEvents = events.filter((e) => e.path === 'create-delete.txt');
      const lastEvent = fileEvents[fileEvents.length - 1];
      expect(lastEvent?.type).toBe('unlink');
    });
  });
});
