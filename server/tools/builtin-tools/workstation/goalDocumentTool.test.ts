import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { ManagedGoalDocumentError } from '../../../../src/lib/codex/goal-document';
import type { BuiltinToolContext } from '../../builtinTools';
import { createGoalDocumentForCaller, readGoalDocumentForCaller,
  goalDocumentCreateTool, goalDocumentReadTool, goalDocumentUpdateTool,
  updateGoalDocumentForCaller } from './goalDocumentTool';

const longMission = `# Full mission\n${'Keep the exact task and revision.\n'.repeat(160)}`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const decode = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);
const digest = createHash('sha256').update(longMission).digest('hex');
const createInput = { creationId: 'distinct-mission-01', objective: 'New mission pointer',
  document: longMission, precondition: { kind: 'completed' as const,
    expectedGoalId: id(20), expectedStatus: 'complete' as const,
    expectedMissionRevision: 5, expectedLifecycleRevision: 9 } };
const previousRevision = { goalId: id(20), status: 'complete',
  missionRevision: 5, lifecycleRevision: 9 };
const newRevision = { goalId: id(21), status: 'active',
  missionRevision: 1, lifecycleRevision: 1 };
const nativeDocument = (threadId: string) => ({
  path: `managed-goals/${threadId}/mission-1-${digest}.md`, sha256: digest,
  byteLength: Buffer.byteLength(longMission), missionRevision: 1,
});
const successfulService = (threadId: string, creation: (input: unknown) => void = () => {}) => {
  const goal = { threadId, status: 'active', objective: createInput.objective };
  const document = nativeDocument(threadId);
  return {
    createThreadGoalDocument: async (input: unknown) => {
      creation(input);
      return { creationId: createInput.creationId, goal, document,
        revision: newRevision, previousRevision, replayed: false };
    },
    getThreadGoalWithRevision: async () => ({ goal, revision: newRevision }),
    getThreadGoalDocument: async () => ({ goal, document, content: longMission }),
  } as never;
};

describe('same-thread managed Goal document caller', () => {
  test('five independent completed predecessors create a distinct full >4,000-character mission with exact CAS', async () => {
    expect(longMission.length).toBeGreaterThan(4_000);
    for (let n = 1; n <= 5; n++) {
      const threadId = id(n);
      const context: BuiltinToolContext = { threadId, verifiedCallerThreadId: threadId };
      const calls: unknown[] = [];
      const service = successfulService(threadId, input => calls.push(input));
      const created = decode(await createGoalDocumentForCaller(context, createInput, service));
      expect(created).toMatchObject({ created: true, creationId: createInput.creationId,
        previousRevision, revision: newRevision });
      expect(created.document.content).toBe(longMission);
      expect(calls).toEqual([{ ...createInput, threadId, status: 'active' }]);
      expect(decode(await readGoalDocumentForCaller(context,
        id => service.getThreadGoalDocument(id))).content).toBe(longMission);
    }
    expect(goalDocumentCreateTool.mainAgentOnly).toBe(true);
    expect(goalDocumentReadTool.mainAgentOnly).toBe(true);
    expect(goalDocumentCreateTool.inputSchema?.required).toContain('precondition');
  });

  test('five absent original Goals require explicit noGoal and return null predecessor', async () => {
    for (let n = 11; n <= 15; n++) {
      const threadId = id(n);
      const context: BuiltinToolContext = { threadId, verifiedCallerThreadId: threadId };
      const input = { ...createInput, creationId: `initial-${n}`,
        precondition: { kind: 'absent' as const, admissionState: 'noGoal' as const } };
      let calls = 0;
      const service = {
        createThreadGoalDocument: async (request: unknown) => {
          calls++;
          expect(request).toEqual({ ...input, threadId, status: 'active' });
          return { creationId: input.creationId, goal: { threadId,
            objective: input.objective, status: 'active' }, document: nativeDocument(threadId),
          revision: newRevision, previousRevision: null, replayed: false };
        },
        getThreadGoalWithRevision: async () => ({ goal: { threadId,
          objective: input.objective, status: 'active' }, revision: newRevision }),
        getThreadGoalDocument: async () => ({ goal: { threadId,
          objective: input.objective, status: 'active' }, document: nativeDocument(threadId),
          content: longMission }),
      } as never;
      const created = decode(await createGoalDocumentForCaller(context, input, service));
      expect(created).toMatchObject({ created: true, creationId: input.creationId });
      expect(created.previousRevision).toBeNull();
      expect(created.document.content).toBe(longMission);
      expect(calls).toBe(1);
    }
  });

  test('unrelated blocked or absent Goal cannot be promoted by a document creator', async () => {
    const threadId = id(6);
    let writes = 0;
    const service = { createThreadGoalDocument: async () => { writes++;
      throw new ManagedGoalDocumentError('stale_predecessor'); } } as never;
    const result = await createGoalDocumentForCaller({ threadId, verifiedCallerThreadId: threadId },
      createInput, service);
    expect(decode(result)).toEqual({ created: false, category: 'stale_predecessor' });
    expect(writes).toBe(1);
  });

  test('wrong caller, unsupported native method and ambiguous write fail without leak or retry', async () => {
    let writes = 0;
    const threadId = id(1);
    const service = { createThreadGoalDocument: async () => { writes++;
      throw Error('PRIVATE transport details'); } } as never;
    const denied = await createGoalDocumentForCaller({ threadId, verifiedCallerThreadId: id(2) },
      createInput, service);
    expect(decode(denied).category).toBe('caller_unavailable');
    expect(writes).toBe(0);
    const uncertain = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, createInput, service);
    expect(decode(uncertain)).toEqual({ created: false, category: 'mutation_unconfirmed' });
    expect(JSON.stringify(uncertain)).not.toContain('PRIVATE');
    expect(writes).toBe(1);
    const unavailable = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, createInput,
    { createThreadGoalDocument: async () => {
      throw new ManagedGoalDocumentError('create_unavailable'); } } as never);
    expect(decode(unavailable).category).toBe('create_unavailable');
    expect(writes).toBe(1);
  });

  test('a competing native Goal transition after predecessor read is not overwritten or retried', async () => {
    const threadId = id(7);
    let writes = 0;
    const result = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, createInput,
    { createThreadGoalDocument: async () => { writes++;
      throw new ManagedGoalDocumentError('stale_predecessor'); } } as never);
    expect(decode(result)).toEqual({ created: false, category: 'stale_predecessor' });
    expect(writes).toBe(1);
  });

  test('missing predecessor fields cannot authorize a new Goal', async () => {
    const threadId = id(8);
    let writes = 0;
    const result = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, { ...createInput,
        precondition: { ...createInput.precondition, expectedLifecycleRevision: undefined } } as never,
    { createThreadGoalDocument: async () => { writes++; throw Error('must not write'); } } as never);
    expect(decode(result)).toEqual({ created: false, category: 'invalid_request' });
    expect(writes).toBe(0);
  });

  test('existing full mission edits only under exact identity/status/revision and verifies readback', async () => {
    const threadId = id(9);
    const expected = { goalId: id(10), status: 'active' as const,
      missionRevision: 1, lifecycleRevision: 3 };
    const edited = `${longMission}\n# Verified edit`;
    let writes = 0;
    const result = await updateGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, edited, expected,
    async (owner, content, revision) => {
      expect([owner, content, revision]).toEqual([threadId, edited, expected]);
      writes++;
      return { goal: { threadId }, document: { sha256: 'updated', missionRevision: 2,
        path: 'native', byteLength: Buffer.byteLength(edited) },
      revision: { ...expected, missionRevision: 2, lifecycleRevision: 4 } };
    }, async () => ({ goal: { threadId } as any, content: edited,
      document: { sha256: 'updated', missionRevision: 2, path: 'native',
        byteLength: Buffer.byteLength(edited) } }));
    expect(decode(result)).toMatchObject({ updated: true,
      revision: { goalId: expected.goalId, missionRevision: 2, lifecycleRevision: 4 } });
    expect(goalDocumentUpdateTool.mainAgentOnly).toBe(true);
    expect(writes).toBe(1);
  });

  test('stale or unverified update fails without replacement, private text, or replay', async () => {
    const threadId = id(11);
    let writes = 0;
    const update = async () => { writes++; throw Error('PRIVATE stale Goal identity'); };
    const read = async () => { throw Error('PRIVATE read'); };
    const bad = await updateGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, longMission,
    { goalId: 'invalid', status: 'blocked', missionRevision: 1, lifecycleRevision: 1 }, update, read);
    expect(decode(bad)).toEqual({ updated: false, category: 'invalid_revision' });
    expect(writes).toBe(0);
    const valid = { goalId: id(12), status: 'blocked' as const,
      missionRevision: 1, lifecycleRevision: 1 };
    const stale = await updateGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, longMission, valid, update, read);
    expect(decode(stale)).toEqual({ updated: false, category: 'mutation_unconfirmed' });
    expect(JSON.stringify(stale)).not.toContain('PRIVATE');
    expect(writes).toBe(1);
  });

  test('stalled native read is bounded without interpreting silence as permission to create', async () => {
    const threadId = id(13);
    let writes = 0;
    const hung = async () => new Promise<never>(() => {});
    const context = { threadId, verifiedCallerThreadId: threadId };
    const read = await readGoalDocumentForCaller(context, hung, 5);
    expect(decode(read)).toEqual({ available: false, category: 'read_unavailable' });
    const create = await createGoalDocumentForCaller(context, createInput,
      { createThreadGoalDocument: async () => { writes++; return hung(); } } as never, 5);
    expect(decode(create)).toEqual({ created: false, category: 'mutation_unconfirmed' });
    expect(writes).toBe(1);
  });

  test('a timed-out create remains uncertain after native later accepts it, without a second write', async () => {
    const threadId = id(14);
    const context = { threadId, verifiedCallerThreadId: threadId };
    let finish!: (value: any) => void;
    let writes = 0;
    let readbacks = 0;
    const pending = createGoalDocumentForCaller(context, createInput,
      { createThreadGoalDocument: () => { writes++; return new Promise(resolve => { finish = resolve; }); },
        getThreadGoalWithRevision: async () => { readbacks++; throw Error('late read'); },
        getThreadGoalDocument: async () => { readbacks++; throw Error('late read'); },
      } as never, 5);
    const result = await pending;
    expect(decode(result)).toEqual({ created: false, category: 'mutation_unconfirmed' });
    expect(writes).toBe(1);
    finish({ goal: { threadId }, document: nativeDocument(threadId) });
    await Promise.resolve();
    expect(writes).toBe(1);
    expect(readbacks).toBe(0);
  });
});
