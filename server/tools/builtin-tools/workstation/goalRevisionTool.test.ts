import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import { goalRevisionTool, readGoalRevisionForCaller } from './goalRevisionTool';

const threadId = '00000000-0000-4000-8000-000000000077';
const otherThread = '00000000-0000-4000-8000-000000000078';
const revision = { goalId: '00000000-0000-4000-8000-000000000088',
  status: 'active', missionRevision: 2, lifecycleRevision: 5 };

describe('main-agent Goal CAS read', () => {
  test('uses only a server-verified matching thread and returns no mission content', async () => {
    const called: string[] = [];
    const result = await readGoalRevisionForCaller({ threadId, verifiedCallerThreadId: threadId },
      async id => { called.push(id); return { goal: { objective: 'PRIVATE mission' }, revision }; });
    expect(called).toEqual([threadId]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ available: true, goalPresent: true, revision });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(goalRevisionTool.mode).toBe('read');
    expect(goalRevisionTool.mainAgentOnly).toBe(true);
  });

  test('unverified, cross-thread and subagent callers cannot reach native', async () => {
    let reads = 0;
    const read = async () => { reads++; return { goal: null, revision: null }; };
    for (const context of [undefined, { threadId },
      { threadId, verifiedCallerThreadId: otherThread },
      { threadId: otherThread, verifiedCallerThreadId: threadId },
      { threadId, verifiedCallerThreadId: threadId, isSubagent: true },
      { threadId, verifiedCallerThreadId: threadId, toolCallPath: ['subagent'] },
      { threadId: 'invalid', verifiedCallerThreadId: 'invalid' }] as Array<BuiltinToolContext | undefined>) {
      const result = await readGoalRevisionForCaller(context, read);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).category).toBe('caller_unavailable');
    }
    expect(reads).toBe(0);
  });

  test('native errors remain content-free typed unavailable, not a fabricated absence', async () => {
    const result = await readGoalRevisionForCaller({ threadId, verifiedCallerThreadId: threadId },
      async () => { throw new Error('PRIVATE native provider error'); });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ available: false,
      category: 'read_unavailable' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  test('only a native-confirmed absent Goal is represented as absent', async () => {
    const result = await readGoalRevisionForCaller({ threadId, verifiedCallerThreadId: threadId },
      async () => ({ goal: null, revision: null }));
    expect(JSON.parse(result.content[0]!.text)).toEqual({ available: true,
      goalPresent: false, revision: null });
  });
});
