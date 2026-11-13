import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { readStableSupervisorGoal } from './supervisorGoalRead';

const threadId = '00000000-0000-4000-8000-000000000001';
const objective = 'managed-goals pointer';
const content = '# Complete mission\n' + 'Retained requirement.\n'.repeat(300);
const sha256 = createHash('sha256').update(content).digest('hex');
const goal = { threadId, status: 'blocked', objective };
const revision = { goalId: '00000000-0000-4000-8000-000000000002', status: 'blocked',
  missionRevision: 4, lifecycleRevision: 7 };
const managed = { path: `managed-goals/${threadId}/mission-4-${sha256}.md`, sha256,
  byteLength: Buffer.byteLength(content), missionRevision: 4 };
function reader(overrides: Record<string, unknown> = {}) {
  return {
    getThreadGoalWithRevision: async () => ({ goal, revision }),
    getThreadGoalDocument: async () => ({ goal, document: managed, content }),
    ...overrides,
  } as never;
}

describe('stable managed supervisor Goal read', () => {
  it('returns an entire >4000-character mission with its exact native revision', async () => {
    expect(content.length).toBeGreaterThan(4_000);
    const result = await readStableSupervisorGoal(reader(), threadId);
    expect(result).toEqual({ goal, revision, document: {
      content, sha256, byteLength: Buffer.byteLength(content), missionRevision: 4,
    } });
  });
  it('denies revision drift and mismatched document bytes without returning a partial mission', async () => {
    let reads = 0;
    const changed = reader({ getThreadGoalWithRevision: async () => ({ goal,
      revision: { ...revision, lifecycleRevision: ++reads === 1 ? 7 : 8 } }) });
    await expect(readStableSupervisorGoal(changed, threadId)).rejects.toThrow('unavailable');
    await expect(readStableSupervisorGoal(reader({ getThreadGoalDocument: async () => ({ goal,
      document: managed, content: content + 'late mutation' }) }), threadId)).rejects.toThrow();
  });
  it('accepts semantically identical native readbacks with reordered JSON fields', async () => {
    let reads = 0;
    const reorderedGoal = { objective, status: goal.status, threadId };
    const reorderedRevision = { lifecycleRevision: revision.lifecycleRevision,
      missionRevision: revision.missionRevision, status: revision.status,
      goalId: revision.goalId };
    const stable = reader({
      getThreadGoalWithRevision: async () => ++reads === 1
        ? { goal, revision } : { revision: reorderedRevision, goal: reorderedGoal },
      getThreadGoalDocument: async () => ({ goal: reorderedGoal, document: managed, content }),
    });
    expect((await readStableSupervisorGoal(stable, threadId)).revision).toEqual(revision);
    expect(reads).toBe(2);
    await expect(readStableSupervisorGoal(reader({
      getThreadGoalDocument: async () => ({ goal: { ...goal, objective: 'different mission' },
        document: managed, content }),
    }), threadId)).rejects.toThrow('unavailable');
  });
  it('times out without claiming an absent or cancelled native read; late result is not returned', async () => {
    let finish!: (value: unknown) => void;
    let reads = 0;
    const pending = reader({
      getThreadGoalWithRevision: async () => { reads++; return { goal, revision }; },
      getThreadGoalDocument: () => new Promise(resolve => { finish = resolve; }),
    });
    await expect(readStableSupervisorGoal(pending, threadId, 10)).rejects.toThrow('unavailable');
    finish({ goal, document: managed, content });
    await Promise.resolve();
    expect(reads).toBe(1);
  });
});
