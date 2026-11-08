import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import { createGoalDocumentForCaller, readGoalDocumentForCaller,
  goalDocumentCreateTool, goalDocumentReadTool, goalDocumentUpdateTool,
  updateGoalDocumentForCaller } from './goalDocumentTool';

const longMission = `# Full mission\n${'Keep the exact task and revision.\n'.repeat(160)}`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const decode = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

describe('same-thread managed Goal document caller', () => {
  test('five independent absent missions create once and read back full >4,000-character content', async () => {
    expect(longMission.length).toBeGreaterThan(4_000);
    for (let n = 1; n <= 5; n++) {
      const threadId = id(n);
      const context: BuiltinToolContext = { threadId, verifiedCallerThreadId: threadId };
      let current: any = { goal: null, document: null, content: null };
      let writes = 0;
      const read = async () => current;
      const create = async (owner: string, document: string) => {
        writes++;
        expect(owner).toBe(threadId);
        expect(document).toBe(longMission);
        current = { goal: { threadId, status: 'active' },
          document: { sha256: 'digest', missionRevision: 1 }, content: document };
        return current;
      };
      const presence = async () => ({ goal: current.goal });
      expect(decode(await createGoalDocumentForCaller(context, longMission, presence, read, create)).created)
        .toBe(true);
      expect(decode(await readGoalDocumentForCaller(context, read)).content).toBe(longMission);
      expect(decode(await createGoalDocumentForCaller(context, longMission, presence, read, create)))
        .toEqual({ created: false, category: 'goal_exists' });
      expect(writes).toBe(1);
    }
    expect(goalDocumentCreateTool.mainAgentOnly).toBe(true);
    expect(goalDocumentReadTool.mainAgentOnly).toBe(true);
  });

  test('unrelated blocked Goal cannot be replaced or resumed by a document creator', async () => {
    const threadId = id(6);
    let writes = 0;
    const result = await createGoalDocumentForCaller({ threadId, verifiedCallerThreadId: threadId },
      longMission, async () => ({ goal: { threadId, status: 'blocked' } }),
      async () => { throw Error('A Goal without a document cannot be read as absence'); },
      async () => { writes++; throw Error('must not write'); });
    expect(decode(result)).toEqual({ created: false, category: 'goal_exists' });
    expect(writes).toBe(0);
  });

  test('wrong caller, unavailable read and ambiguous write fail without replacement or leak', async () => {
    let reads = 0, writes = 0;
    const threadId = id(1);
    const read = async () => { reads++; return { goal: null, document: null, content: null }; };
    const create = async () => { writes++; throw Error('PRIVATE transport details'); };
    const denied = await createGoalDocumentForCaller({ threadId, verifiedCallerThreadId: id(2) },
      longMission, async () => ({ goal: null }), read, create);
    expect(decode(denied).category).toBe('caller_unavailable');
    expect(reads).toBe(0);
    const uncertain = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, longMission, async () => ({ goal: null }), read, create);
    expect(decode(uncertain)).toEqual({ created: false, category: 'mutation_unconfirmed' });
    expect(JSON.stringify(uncertain)).not.toContain('PRIVATE');
    expect(writes).toBe(1);
    const unavailable = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, longMission,
      async () => { throw Error('PRIVATE read'); }, read, create);
    expect(decode(unavailable).category).toBe('read_unavailable');
    expect(writes).toBe(1);
  });

  test('a competing native Goal insertion after absent read is not overwritten or retried', async () => {
    const threadId = id(7);
    let writes = 0;
    const result = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, longMission,
    async () => ({ goal: null }),
    async () => { throw Error('must not attempt readback'); },
    async () => { writes++; throw Error('native unique insert refused competing Goal'); });
    expect(decode(result)).toEqual({ created: false, category: 'mutation_unconfirmed' });
    expect(writes).toBe(1);
  });

  test('contradictory native absence and revision cannot authorize a new Goal', async () => {
    const threadId = id(8);
    let writes = 0;
    const result = await createGoalDocumentForCaller({ threadId,
      verifiedCallerThreadId: threadId }, longMission,
    async () => ({ goal: null, revision: { goalId: 'older-owner' } }),
    async () => { throw Error('must not read'); },
    async () => { writes++; throw Error('must not write'); });
    expect(decode(result)).toEqual({ created: false, category: 'read_unavailable' });
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
});
