import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { ManagedGoalDocumentError } from '../../src/lib/codex/goal-document';
import { createSupervisorGoal, type SupervisorGoalCreateInput } from './supervisorGoalCreate';

const threadId = '00000000-0000-4000-8000-000000000001';
const oldId = '00000000-0000-4000-8000-000000000002';
const newId = '00000000-0000-4000-8000-000000000003';
const old = { threadId, objective: 'completed unrelated mission', status: 'complete' };
const previousRevision = { goalId: oldId, status: 'complete', missionRevision: 6, lifecycleRevision: 9 };
const mission = '# New complete mission\n' + 'A retained requirement.\n'.repeat(300);
const sha256 = createHash('sha256').update(mission).digest('hex');
const goal = { threadId, objective: 'new mission pointer', status: 'active' };
const revision = { goalId: newId, status: 'active', missionRevision: 1, lifecycleRevision: 1 };
const document = { path: `managed-goals/${threadId}/mission-1-${sha256}.md`,
  sha256, byteLength: Buffer.byteLength(mission), missionRevision: 1 };
const request: SupervisorGoalCreateInput = {
  creationId: 'new-job-20261108-unique', objective: goal.objective,
  document: mission, expectedGoalId: oldId, expectedStatus: 'complete',
  expectedMissionRevision: 6, expectedLifecycleRevision: 9,
};

describe('native completed-predecessor managed Goal creation', () => {
  it('submits exactly one CAS, verifies the full >4000-character persisted mission and distinct new Goal', async () => {
    let state = { goal: old, revision: previousRevision, document: null as null | typeof document };
    const requests: unknown[] = [];
    const service = {
      createThreadGoalDocument: async (params: unknown) => {
        requests.push(params);
        state = { goal, revision, document };
        return { goal, document, previousRevision, revision, creationId: request.creationId,
          replayed: false };
      },
      getThreadGoalWithRevision: async () => ({ goal: state.goal, revision: state.revision }),
      getThreadGoalDocument: async () => ({ goal: state.goal, document: state.document,
        content: state.document ? mission : null }),
    } as never;
    expect(mission.length).toBeGreaterThan(4_000);
    const created = await createSupervisorGoal(service, threadId, request);
    expect(requests).toEqual([{ threadId, ...request, status: 'active' }]);
    expect(created.document?.content).toBe(mission);
    expect(created.revision).toEqual(revision);
    expect(created.previousRevision).toEqual(previousRevision);
    expect(created.creationId).toBe(request.creationId);
    expect(created.replayed).toBe(false);
  });

  it('matches the native 4000 Unicode-scalar objective bound after trimming', async () => {
    const objective = '😀'.repeat(4_000);
    const trimmed = ` ${objective} `;
    let calls = 0;
    const newGoal = { ...goal, objective };
    const service = {
      createThreadGoalDocument: async (params: { objective: string }) => {
        calls++;
        expect(params.objective).toBe(objective);
        return { goal: newGoal, document, previousRevision, revision,
          creationId: request.creationId, replayed: false };
      },
      getThreadGoalWithRevision: async () => ({ goal: newGoal, revision }),
      getThreadGoalDocument: async () => ({ goal: newGoal, document, content: mission }),
    } as never;
    expect((await createSupervisorGoal(service, threadId,
      { ...request, objective: trimmed })).goal?.objective).toBe(objective);
    await expect(createSupervisorGoal(service, threadId,
      { ...request, objective: `${objective}😀` }))
      .rejects.toMatchObject({ category: 'invalid_request' });
    expect(calls).toBe(1);
  });

  it('allows an explicit identical creation-ID reconciliation without a second native effect', async () => {
    let effects = 0;
    let calls = 0;
    const native = async (params: { document: string }) => {
        calls++;
        if (params.document !== mission) throw new ManagedGoalDocumentError('stale_predecessor');
        if (calls === 1) effects++;
        return { goal, document, previousRevision, revision, creationId: request.creationId,
          replayed: calls !== 1 };
      };
    const openConsumer = () => ({
      createThreadGoalDocument: native,
      getThreadGoalWithRevision: async () => ({ goal, revision }),
      getThreadGoalDocument: async () => ({ goal, document, content: mission }),
    } as never);
    expect((await createSupervisorGoal(openConsumer(), threadId, request)).replayed).toBe(false);
    // A new consumer instance after restart uses the same durable native receipt.
    expect((await createSupervisorGoal(openConsumer(), threadId, request)).replayed).toBe(true);
    await expect(createSupervisorGoal(openConsumer(), threadId,
      { ...request, document: `${mission}\nChanged bytes` }))
      .rejects.toMatchObject({ category: 'stale_predecessor' });
    expect(effects).toBe(1);
  });

  it('refuses incomplete predecessor, malformed creation ID and empty or oversized mission before native call', async () => {
    let calls = 0;
    const service = { createThreadGoalDocument: async () => { calls++; throw Error('unexpected'); } } as never;
    for (const invalid of [
      { ...request, expectedStatus: 'active' }, { ...request, creationId: '../other' },
      { ...request, document: '' }, { ...request, document: 'x'.repeat(1_048_577) },
      { ...request, expectedGoalId: 'wrong' },
    ]) {
      await expect(createSupervisorGoal(service, threadId, invalid as SupervisorGoalCreateInput))
        .rejects.toMatchObject({ category: 'invalid_request' });
    }
    expect(calls).toBe(0);
  });

  it('keeps native conflict distinct from unavailable and unknown transport without exposing private prose', async () => {
    for (const [error, category] of [
      [new ManagedGoalDocumentError('stale_predecessor'), 'stale_predecessor'],
      [new ManagedGoalDocumentError('create_unavailable'), 'create_unavailable'],
      [Error('private native body'), 'mutation_unconfirmed'],
    ] as const) {
      const service = { createThreadGoalDocument: async () => { throw error; } } as never;
      await expect(createSupervisorGoal(service, threadId, request))
        .rejects.toMatchObject({ category });
    }
  });

  it('does not reissue a timed-out creation when the native response arrives late', async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const service = { createThreadGoalDocument: () => {
      calls++;
      return new Promise(done => { resolve = done; });
    } } as never;
    await expect(createSupervisorGoal(service, threadId, request, 10))
      .rejects.toMatchObject({ category: 'mutation_unconfirmed' });
    resolve({ goal, document, previousRevision, revision, creationId: request.creationId,
      replayed: false });
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('never acknowledges a wrong owner, predecessor, document, or post-create readback', async () => {
    for (const override of [
      { creationId: 'another-id' }, { previousRevision: { ...previousRevision, goalId: newId } },
      { goal: { ...goal, threadId: newId } }, { document: { ...document, sha256: '0'.repeat(64) } },
    ]) {
      const service = { createThreadGoalDocument: async () => ({ goal, document,
        previousRevision, revision, creationId: request.creationId, replayed: false, ...override }),
      } as never;
      await expect(createSupervisorGoal(service, threadId, request))
        .rejects.toMatchObject({ category: 'mutation_unconfirmed' });
    }
    const service = {
      createThreadGoalDocument: async () => ({ goal, document, previousRevision, revision,
        creationId: request.creationId, replayed: false }),
      getThreadGoalWithRevision: async () => ({ goal: old, revision: previousRevision }),
      getThreadGoalDocument: async () => ({ goal: old, document: null, content: null }),
    } as never;
    await expect(createSupervisorGoal(service, threadId, request))
      .rejects.toMatchObject({ category: 'mutation_unconfirmed' });
  });
});
