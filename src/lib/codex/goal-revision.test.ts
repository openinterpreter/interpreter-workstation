import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { CodexService, type CodexClient } from './service';
import { GoalRevisionUnavailableError, verifyThreadGoalRevision } from './goal-revision';

const threadId = '00000000-0000-4000-8000-000000000077';
const goalId = '00000000-0000-4000-8000-000000000088';
const goal = { threadId, objective: 'Mission', status: 'active' as const, tokenBudget: null,
  tokensUsed: 4, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 };
const revision = { goalId, status: 'active' as const, missionRevision: 2, lifecycleRevision: 3 };

describe('exact native Goal revision read', () => {
  test('accepts native identity and revision without exposing mission content', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalGet: async (params: { threadId: string }) => {
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

  test('old runtime and contradictory owner, status, or revisions fail closed', async () => {
    const cases = [undefined, { ...revision, goalId: 'not-an-id' },
      { ...revision, status: 'paused' }, { ...revision, missionRevision: 0 },
      { ...revision, lifecycleRevision: Number.MAX_SAFE_INTEGER + 1 }];
    for (const value of cases) {
      const client = { subscribe: () => () => {}, threadGoalGet: async () =>
        ({ goal, revision: value }) } as unknown as CodexClient;
      await assert.rejects(new CodexService(client).getThreadGoalWithRevision(threadId),
        { category: 'read_unavailable' });
    }
    assert.throws(() => verifyThreadGoalRevision({ ...goal, threadId: goalId }, revision, threadId),
      GoalRevisionUnavailableError);
  });

  test('invalid exact-thread caller is denied before native read', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalGet: async () => {
      calls++;
      return { goal, revision };
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).getThreadGoalWithRevision('wrong-owner'),
      { category: 'read_unavailable' });
    assert.equal(calls, 0);
  });

  test('native errors remain typed and suppress private backend text', async () => {
    const client = { subscribe: () => () => {}, threadGoalGet: async () => {
      throw new Error('PRIVATE native backend text');
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).getThreadGoalWithRevision(threadId),
      (error: unknown) => error instanceof GoalRevisionUnavailableError &&
        !error.message.includes('PRIVATE'));
  });
});
