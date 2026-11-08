import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import { createGoalDocumentForCaller, readGoalDocumentForCaller,
  goalDocumentCreateTool, goalDocumentReadTool } from './goalDocumentTool';

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
});
