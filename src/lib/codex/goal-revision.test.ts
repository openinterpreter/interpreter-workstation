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

  test('native CAS sends all four preconditions once and accepts only refreshed owner revision', async () => {
    let received: unknown;
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionSet: async (params: unknown) => {
      calls++;
      received = params;
      return { goal: { ...goal, status: 'paused' }, revision: {
        ...revision, status: 'paused', lifecycleRevision: 4,
      } };
    } } as unknown as CodexClient;
    assert.deepEqual(await new CodexService(client).setThreadGoalWithRevision(threadId, revision,
      { status: 'paused' }), { goal: { ...goal, status: 'paused' },
      revision: { ...revision, status: 'paused', lifecycleRevision: 4 } });
    assert.deepEqual(received, { threadId, status: 'paused',
      expectedGoalId: goalId, expectedStatus: 'active',
      expectedMissionRevision: 2, expectedLifecycleRevision: 3 });
    assert.equal(calls, 1);
  });

  test('objective advances mission and lifecycle while a budget-only edit advances lifecycle', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionSet: async () => {
      calls++;
      return { goal: calls === 1 ? { ...goal, objective: 'New mission' } :
        { ...goal, tokenBudget: 100 },
        revision: { ...revision, missionRevision: calls === 1 ? 3 : 2,
        lifecycleRevision: 4 } };
    } } as unknown as CodexClient;
    const service = new CodexService(client);
    assert.equal((await service.setThreadGoalWithRevision(threadId, revision,
      { objective: 'New mission' })).revision.missionRevision, 3);
    assert.equal((await service.setThreadGoalWithRevision(threadId, revision,
      { tokenBudget: 100 })).revision.missionRevision, 2);
    assert.equal(calls, 2);
  });

  test('invalid owner, incomplete preconditions and unsafe changes never reach native', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionSet: async () => {
      calls++;
      return { goal, revision };
    } } as unknown as CodexClient;
    const service = new CodexService(client);
    for (const [owner, expected, change] of [
      ['wrong-owner', revision, { status: 'paused' }],
      [threadId, { ...revision, lifecycleRevision: 0 }, { status: 'paused' }],
      [threadId, revision, {}],
      [threadId, revision, { status: undefined }],
      [threadId, revision, { tokenBudget: -1 }],
      [threadId, revision, { status: 'invalid' }],
    ] as const) {
      await assert.rejects(service.setThreadGoalWithRevision(owner, expected,
        change as { status?: 'paused'; tokenBudget?: number }),
      { category: 'read_unavailable' });
    }
    assert.equal(calls, 0);
  });

  test('ambiguous error or stale result is never replayed and cannot claim confirmed CAS', async () => {
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionSet: async () => {
      calls++;
      throw new Error('PRIVATE native mutation might have committed');
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(client).setThreadGoalWithRevision(threadId, revision,
      { status: 'paused' }), (error: unknown) =>
      (error as { category?: string }).category === 'mutation_unconfirmed' &&
      !(error as Error).message.includes('PRIVATE'));
    assert.equal(calls, 1);
    const stale = { subscribe: () => () => {}, threadGoalRevisionSet: async () => {
      calls++;
      return { goal, revision };
    } } as unknown as CodexClient;
    await assert.rejects(new CodexService(stale).setThreadGoalWithRevision(threadId, revision,
      { status: 'paused' }), { category: 'mutation_unconfirmed' });
    assert.equal(calls, 2);
    stale.threadGoalRevisionSet = async () => {
      calls++;
      return { goal, revision: { ...revision, lifecycleRevision: 5 } };
    };
    await assert.rejects(new CodexService(stale).setThreadGoalWithRevision(threadId, revision,
      { status: 'active' }), { category: 'mutation_unconfirmed' });
    assert.equal(calls, 3);
    stale.threadGoalRevisionSet = async () => {
      calls++;
      return { goal, revision: { ...revision, lifecycleRevision: 4, missionRevision: 2 } };
    };
    await assert.rejects(new CodexService(stale).setThreadGoalWithRevision(threadId, revision,
      { objective: 'Changed mission' }), { category: 'mutation_unconfirmed' });
    assert.equal(calls, 4);
  });

  test('bounded CAS timeout leaves native RPC alive and denies a late success as unconfirmed', async () => {
    let finish!: (result: { goal: typeof goal; revision: typeof revision }) => void;
    let calls = 0;
    const client = { subscribe: () => () => {}, threadGoalRevisionSet: () => {
      calls++;
      return new Promise<{ goal: typeof goal; revision: typeof revision }>(resolve => {
        finish = resolve;
      });
    } } as unknown as CodexClient;
    const service = new CodexService(client);
    await assert.rejects(service.setThreadGoalWithRevision(threadId, revision,
      { status: 'paused' }, 10), { category: 'mutation_unconfirmed' });
    finish({ goal, revision });
    await Promise.resolve();
    assert.equal(calls, 1);
    await assert.rejects(service.setThreadGoalWithRevision(threadId, revision,
      { status: 'paused' }, 0), { category: 'read_unavailable' });
    assert.equal(calls, 1);
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
