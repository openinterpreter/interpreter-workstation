import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { CodexService, type CodexClient } from './service';
import { GoalRevisionUnavailableError, goalCasExpectedParams, verifyThreadGoalRevision } from './goal-revision';

const threadId = '00000000-0000-4000-8000-000000000077';
const goalId = '00000000-0000-4000-8000-000000000088';
const goal = { threadId, objective: 'Mission', status: 'active' as const, tokenBudget: null,
  tokensUsed: 4, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 };
const revision = { goalId, status: 'active' as const, missionRevision: 2, lifecycleRevision: 3 };

describe('exact native Goal revision read', () => {
  test('accepts native identity and revision without exposing mission content', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionGet: async (params: { threadId: string }) => {
      calls++;
      assert.deepEqual(params, { threadId });
      return { goal, revision };
    } } as unknown as CodexClient;
    assert.deepEqual(await new CodexService(client).getThreadGoalWithRevision(threadId),
      { goal, revision });
    assert.equal(calls, 1);
  });

  test('returns a genuinely absent Goal only with a matching absent revision', () => {
    assert.equal(verifyThreadGoalRevision(null, null, threadId), null);
    assert.throws(() => verifyThreadGoalRevision(null, null, 'wrong-owner'), GoalRevisionUnavailableError);
    assert.throws(() => verifyThreadGoalRevision(null, undefined, threadId), GoalRevisionUnavailableError);
    assert.throws(() => verifyThreadGoalRevision(null, revision, threadId), GoalRevisionUnavailableError);
  });

  test('a client without the no-reconnect inspection method is unavailable', async () => {
    let ordinaryReads = 0;
    const client = { subscribe: () => () => {}, threadGoalGet: async () => {
      ordinaryReads++;
      return { goal, revision };
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).getThreadGoalWithRevision(threadId),
      { category: 'read_unavailable' });
    assert.equal(ordinaryReads, 0);
  });

  test('old runtime and contradictory owner, status, or revisions fail closed', async () => {
    const cases = [undefined, { ...revision, goalId: 'not-an-id' },
      { ...revision, status: 'paused' }, { ...revision, status: 'invalid' },
      { ...revision, missionRevision: 0 },
      { ...revision, lifecycleRevision: Number.MAX_SAFE_INTEGER + 1 }];
    for (const value of cases) {
      const client = { subscribe: () => () => {}, threadGoalRevisionGet: async () =>
        ({ goal, revision: value }) } as unknown as CodexClient;
      await assert.rejects(new CodexService(client).getThreadGoalWithRevision(threadId),
        { category: 'read_unavailable' });
    }
    assert.throws(() => verifyThreadGoalRevision({ ...goal, threadId: goalId }, revision, threadId),
      GoalRevisionUnavailableError);
  });

  test('a future native mutation receives every expected-state field together', () => {
    assert.deepEqual(goalCasExpectedParams(revision), {
      expectedGoalId: goalId, expectedStatus: 'active', expectedMissionRevision: 2,
      expectedLifecycleRevision: 3,
    });
    assert.throws(() => goalCasExpectedParams({ ...revision, lifecycleRevision: -1 }),
      GoalRevisionUnavailableError);
  });

  test('invalid exact-thread caller is denied before native read', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionGet: async () => {
      calls++;
      return { goal, revision };
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).getThreadGoalWithRevision('wrong-owner'),
      { category: 'read_unavailable' });
    assert.equal(calls, 0);
  });

  test('native errors remain typed and suppress private backend text', async () => {
    const client = { subscribe: () => () => {}, threadGoalRevisionGet: async () => {
      throw new Error('PRIVATE native backend text');
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).getThreadGoalWithRevision(threadId),
      (error: unknown) => error instanceof GoalRevisionUnavailableError &&
        !error.message.includes('PRIVATE'));
  });

  test('deadline is content-free and a late native result cannot turn it into success or cause retry', async () => {
    let complete!: (result: { goal: typeof goal; revision: typeof revision }) => void;
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionGet: () => {
      calls++;
      return new Promise<{ goal: typeof goal; revision: typeof revision }>((resolve) => {
        complete = resolve;
      });
    } } as unknown as CodexClient;
    const read = new CodexService(client).getThreadGoalWithRevision(threadId, 10);
    await assert.rejects(read, { category: 'read_unavailable' });
    complete({ goal, revision });
    await Promise.resolve();
    assert.equal(calls, 1);
    await assert.rejects(new CodexService(client).getThreadGoalWithRevision(threadId, 0),
      { category: 'read_unavailable' });
    assert.equal(calls, 1);
  });
});
