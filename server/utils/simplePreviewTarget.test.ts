import { describe, expect, test } from 'bun:test';
import {
  reportedSimplePreviewTarget,
  resolveSimplePreviewTargetPort,
  sameSimplePreviewTarget,
  type SimplePreviewSelection,
} from './simplePreviewTarget';

const running = (port: number) => ({ status: 'running', url: `http://127.0.0.1:${port}` });
const session = (path: string): SimplePreviewSelection => ({ path, scope: 'session' });
const global = (path: string): SimplePreviewSelection => ({ path, scope: 'global' });
const isCurrent = () => true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Simple preview target', () => {
  test('forwards to the reported project while it is still selected and running', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, 'ws_1', session('/projects/a'));
    expect(target).toEqual({ path: '/projects/a', scope: 'session', sessionKey: 'ws_1' });
    const seen: Array<string | null> = [];
    const result = await resolveSimplePreviewTargetPort(target, {
      selected: async (sessionKey) => { seen.push(sessionKey); return session('/projects/a'); },
      status: async () => running(43811),
      isCurrent,
    });
    expect(result).toEqual({ port: 43811, stale: false });
    // Checked before and again after the project state was read.
    expect(seen).toEqual(['ws_1', 'ws_1']);
  });

  test('refuses the previous project when another is selected, even though the previous one still runs', async () => {
    const target = reportedSimplePreviewTarget('/projects/old', true, null, global('/projects/old'));
    let statusReads = 0;
    const result = await resolveSimplePreviewTargetPort(target, {
      // The newly selected project is stopped or still starting.
      selected: async () => global('/projects/new'),
      status: async (projectPath) => {
        statusReads += 1;
        return projectPath === '/projects/old' ? running(43800) : { status: 'stopped', url: null };
      },
      isCurrent,
    });
    expect(result).toEqual({ port: null, stale: true });
    expect(statusReads).toBe(0);
  });

  test('refuses a request in flight when the selection changes while the project state is being read', async () => {
    const target = reportedSimplePreviewTarget('/projects/old', true, null, global('/projects/old'));
    let selection = global('/projects/old');
    const state = deferred<{ status: string; url: string }>();
    const pending = resolveSimplePreviewTargetPort(target, {
      selected: async () => selection,
      status: () => state.promise,
      isCurrent,
    });
    // The first selection check has passed and the state read is waiting.
    await Promise.resolve();
    await Promise.resolve();
    selection = global('/projects/new');
    state.resolve(running(43800));
    expect(await pending).toEqual({ port: null, stale: true });
  });

  test('refuses a request in flight when the recorded target is replaced or cleared while the project state is being read', async () => {
    const target = reportedSimplePreviewTarget('/projects/old', true, null, global('/projects/old'));
    let recorded = target;
    const state = deferred<{ status: string; url: string }>();
    const pending = resolveSimplePreviewTargetPort(target, {
      // The stored selection has not caught up yet; only the recorded target changed.
      selected: async () => global('/projects/old'),
      status: () => state.promise,
      isCurrent: () => sameSimplePreviewTarget(recorded, target),
    });
    await Promise.resolve();
    await Promise.resolve();
    recorded = null;
    state.resolve(running(43800));
    expect(await pending).toEqual({ port: null, stale: false });
  });

  test('refuses a session target once the session no longer selects it, even if the global selection is the same project', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, 'ws_closed', session('/projects/a'));
    let statusReads = 0;
    const result = await resolveSimplePreviewTargetPort(target, {
      // The window session is gone, so the lookup falls back to the global selection.
      selected: async () => global('/projects/a'),
      status: async () => { statusReads += 1; return running(43800); },
      isCurrent,
    });
    expect(result).toEqual({ port: null, stale: true });
    expect(statusReads).toBe(0);
  });

  test('refuses when nothing is selected or the selection cannot be resolved', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, null, global('/projects/a'));
    const result = await resolveSimplePreviewTargetPort(target, {
      selected: async () => null,
      status: async () => running(43800),
      isCurrent,
    });
    expect(result).toEqual({ port: null, stale: true });
  });

  test('a report clears the target unless the project is running and is what the session selected', async () => {
    expect(reportedSimplePreviewTarget('/projects/new', false, null, global('/projects/new'))).toBeNull();
    expect(reportedSimplePreviewTarget('/projects/a', true, null, global('/projects/b'))).toBeNull();
    expect(reportedSimplePreviewTarget('/projects/a', true, null, null)).toBeNull();
    const result = await resolveSimplePreviewTargetPort(null, {
      selected: async () => global('/projects/old'),
      status: async () => running(43800),
      isCurrent,
    });
    expect(result).toEqual({ port: null, stale: false });
  });

  test('answers no port when the selected project is not running or its address is unusable', async () => {
    const target = reportedSimplePreviewTarget('/projects/a', true, null, global('/projects/a'));
    const selected = async () => global('/projects/a');
    expect(await resolveSimplePreviewTargetPort(target, { selected, isCurrent, status: async () => ({ status: 'stopped', url: null }) }))
      .toEqual({ port: null, stale: false });
    expect(await resolveSimplePreviewTargetPort(target, { selected, isCurrent, status: async () => ({ status: 'running', url: 'not a url' }) }))
      .toEqual({ port: null, stale: false });
    expect(await resolveSimplePreviewTargetPort(target, { selected, isCurrent, status: async () => ({ status: 'running', url: 'http://127.0.0.1' }) }))
      .toEqual({ port: null, stale: false });
  });

  test('compares targets by project, scope and window session', () => {
    const a = reportedSimplePreviewTarget('/projects/a', true, 'ws_1', session('/projects/a'));
    expect(sameSimplePreviewTarget(a, { ...a! })).toBe(true);
    expect(sameSimplePreviewTarget(a, { ...a!, sessionKey: 'ws_2' })).toBe(false);
    expect(sameSimplePreviewTarget(a, { ...a!, scope: 'global' })).toBe(false);
    expect(sameSimplePreviewTarget(a, null)).toBe(false);
    expect(sameSimplePreviewTarget(null, null)).toBe(true);
  });
});
