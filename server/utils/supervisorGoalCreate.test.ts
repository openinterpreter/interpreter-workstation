import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { createSupervisorGoal, SupervisorGoalCreateError } from './supervisorGoalCreate';

const threadId = '00000000-0000-4000-8000-000000000001';
const mission = '# Mission\n' + 'Do not lose original context.\n'.repeat(200);
const sha256 = createHash('sha256').update(mission).digest('hex');
const goal = { threadId, status: 'active', objective: 'managed mission' };
const revision = { goalId: '00000000-0000-4000-8000-000000000002', status: 'active',
  missionRevision: 1, lifecycleRevision: 1 };
const document = { path: `managed-goals/${threadId}/mission-1-${sha256}.md`,
  sha256, byteLength: Buffer.byteLength(mission), missionRevision: 1 };

describe('exact-thread managed Goal creation', () => {
  it('creates one full >4000-character mission and verifies native document and revision', async () => {
    let present = false;
    let writes = 0;
    const service = {
      getThreadGoalWithRevision: async () => present ? { goal, revision } : { goal: null, revision: null },
      getThreadGoalDocument: async () => ({ goal, document, content: mission }),
      setThreadGoalDocument: async () => { writes++; present = true; return { goal, document }; },
    } as never;
    expect(mission.length).toBeGreaterThan(4_000);
    expect((await createSupervisorGoal(service, threadId, mission)).document?.content).toBe(mission);
    expect(writes).toBe(1);
    await expect(createSupervisorGoal(service, threadId, mission)).rejects.toMatchObject({ category: 'goal_exists' });
    expect(writes).toBe(1);
  });
  it('does not retry an uncertain native insert after timeout or late completion', async () => {
    let finish!: (result: unknown) => void;
    let writes = 0;
    const service = {
      getThreadGoalWithRevision: async () => ({ goal: null, revision: null }),
      getThreadGoalDocument: async () => ({ goal, document, content: mission }),
      setThreadGoalDocument: () => { writes++; return new Promise(resolve => { finish = resolve; }); },
    } as never;
    await expect(createSupervisorGoal(service, threadId, mission, 10))
      .rejects.toMatchObject({ category: 'mutation_unconfirmed' });
    finish({ goal, document });
    await Promise.resolve();
    expect(writes).toBe(1);
  });
  it('preserves one native Goal when two supervisors observe absence concurrently', async () => {
    let created = false;
    let effects = 0;
    const service = {
      getThreadGoalWithRevision: async () => created ? { goal, revision } : { goal: null, revision: null },
      getThreadGoalDocument: async () => ({ goal, document, content: mission }),
      setThreadGoalDocument: async () => {
        if (created) throw Error('Native Goal already exists');
        created = true;
        effects++;
        return { goal, document };
      },
    } as never;
    const [first, second] = await Promise.allSettled([
      createSupervisorGoal(service, threadId, mission),
      createSupervisorGoal(service, threadId, mission),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(effects).toBe(1);
  });
  it('leaves an existing mission intact and rejects invalid input before native write', async () => {
    let writes = 0;
    const service = {
      getThreadGoalWithRevision: async () => ({ goal, revision }),
      setThreadGoalDocument: async () => { writes++; throw Error('should not write'); },
    } as never;
    await expect(createSupervisorGoal(service, threadId, mission))
      .rejects.toMatchObject({ category: 'goal_exists' });
    await expect(createSupervisorGoal(service, threadId, ' '))
      .rejects.toMatchObject({ category: 'invalid_document' });
    expect(writes).toBe(0);
    expect(SupervisorGoalCreateError.name).toBe('SupervisorGoalCreateError');
  });
});
