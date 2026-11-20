import { afterEach, beforeEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { CodexService, setUnloadedThreadCarrierProvider, type CodexClient } from './service';
import { GoalRevisionConflictError } from './goal-revision';

const threadId = '00000000-0000-4000-8000-000000000077';
const goalId = '00000000-0000-4000-8000-000000000088';
const cwd = '/workspace/goal-thread';
const blocked = { goalId, status: 'blocked' as const, missionRevision: 2, lifecycleRevision: 3 };
const goal = { threadId, objective: 'Mission', status: 'active' as const, tokenBudget: null,
  tokensUsed: 4, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 };
const resumed = { ...blocked, status: 'active' as const, lifecycleRevision: 4 };

type ThreadState = 'notLoaded' | 'idle' | 'active' | 'systemError';

/** A native runtime seam: ordered calls, a thread load state, and the
 * outcome of a Goal CAS and of a thread resume. */
function runtime(options: { state?: ThreadState | 'unreadable'; cas?: 'ok' | 'conflict';
  resume?: 'ok' | 'fail' } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const client = {
    subscribe: () => () => {},
    threadGoalRevisionSet: async (params: unknown) => {
      calls.push(['goal/set', params]);
      if (options.cas === 'conflict') throw { code: -32009, message: 'stale' };
      return { goal, revision: resumed };
    },
    threadRead: async (params: unknown) => {
      calls.push(['thread/read', params]);
      if (options.state === 'unreadable') throw Error('PRIVATE runtime detail');
      const state = options.state ?? 'notLoaded';
      return { thread: { id: threadId, cwd, turns: [], status: state === 'active'
        ? { type: 'active', activeFlags: [] } : { type: state } } };
    },
    resumeThread: async (id: string, _provider: unknown, _model: unknown, resumeCwd: unknown,
      config: unknown) => {
      calls.push(['thread/resume', id, resumeCwd, config]);
      if (options.resume === 'fail') throw { code: -32603, message: 'PRIVATE resume failure' };
      return id;
    },
  } as unknown as CodexClient;
  return { service: new CodexService(client), calls };
}

let restoreCarrier: () => void;
const logged: string[] = [];
const originalWarn = console.warn;
const originalInfo = console.info;
beforeEach(() => {
  // No caller carrier: the resume is the ordinary saved-thread resume.
  restoreCarrier = setUnloadedThreadCarrierProvider(null);
  logged.length = 0;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
});
afterEach(() => {
  restoreCarrier();
  console.warn = originalWarn;
  console.info = originalInfo;
});

describe('Goal resume continuation', () => {
  test('a Goal resumed on an unloaded thread loads the thread after the confirmed CAS', async () => {
    const { service, calls } = runtime({ state: 'notLoaded' });
    const result = await service.resumeThreadGoalWithRevision(threadId, blocked);
    assert.deepEqual(result, { goal, revision: resumed, continuation: 'loaded' });
    assert.deepEqual(calls.map(call => call[0]), ['goal/set', 'thread/read', 'thread/resume']);
    // The CAS carries the exact expected state; the resume keeps the thread's
    // own directory and never replaces its tool servers.
    assert.deepEqual(calls[0]![1], { threadId, status: 'active', expectedGoalId: goalId,
      expectedStatus: 'blocked', expectedMissionRevision: 2, expectedLifecycleRevision: 3 });
    assert.deepEqual(calls[1]![1], { threadId, includeTurns: false });
    assert.equal(calls[2]![1], threadId);
    assert.equal(calls[2]![2], cwd);
    assert.deepEqual((calls[2]![3] as Record<string, unknown>).mcp_servers, {});
    assert.deepEqual(logged, [
      `[Goal continuation] ${JSON.stringify({ threadId, continuation: 'loaded' })}`]);
  });

  test('a loaded idle thread is not resumed again; the runtime continues its Goal', async () => {
    const { service, calls } = runtime({ state: 'idle' });
    assert.equal((await service.resumeThreadGoalWithRevision(threadId, blocked)).continuation,
      'already_loaded');
    assert.deepEqual(calls.map(call => call[0]), ['goal/set', 'thread/read']);
    assert.deepEqual(logged, []);
  });

  test('a thread already running a turn gets no second turn and no resume', async () => {
    const { service, calls } = runtime({ state: 'active' });
    assert.equal((await service.resumeThreadGoalWithRevision(threadId, blocked)).continuation,
      'already_running');
    assert.deepEqual(calls.map(call => call[0]), ['goal/set', 'thread/read']);
  });

  test('a failed load after a confirmed CAS still returns the new revision, and is logged', async () => {
    const { service, calls } = runtime({ state: 'notLoaded', resume: 'fail' });
    const result = await service.resumeThreadGoalWithRevision(threadId, blocked);
    assert.deepEqual(result, { goal, revision: resumed, continuation: 'not_started' });
    assert.deepEqual(calls.map(call => call[0]), ['goal/set', 'thread/read', 'thread/resume']);
    assert.deepEqual(logged, [`[Goal continuation] ${JSON.stringify({ threadId,
      continuation: 'not_started', cause: 'thread_resume_failed', nativeCode: -32603 })}`]);
    assert.ok(!logged.join('\n').includes('PRIVATE'));
  });

  test('an unreadable or unusable thread state is not_started, never a guessed resume', async () => {
    for (const [state, cause] of [['unreadable', 'thread_read_unavailable'],
      ['systemError', 'thread_unavailable']] as const) {
      logged.length = 0;
      const { service, calls } = runtime({ state });
      assert.equal((await service.resumeThreadGoalWithRevision(threadId, blocked)).continuation,
        'not_started');
      assert.deepEqual(calls.map(call => call[0]), ['goal/set', 'thread/read']);
      assert.deepEqual(logged, [`[Goal continuation] ${JSON.stringify({ threadId,
        continuation: 'not_started', cause, nativeCode: null })}`]);
      assert.ok(!logged.join('\n').includes('PRIVATE'));
    }
  });

  test('a CAS conflict neither reads nor loads the thread', async () => {
    const { service, calls } = runtime({ state: 'notLoaded', cas: 'conflict' });
    await assert.rejects(service.resumeThreadGoalWithRevision(threadId, blocked),
      GoalRevisionConflictError);
    assert.deepEqual(calls.map(call => call[0]), ['goal/set']);
    assert.deepEqual(logged, []);
  });
});
