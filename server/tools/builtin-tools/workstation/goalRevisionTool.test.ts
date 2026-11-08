import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import { goalRevisionTool, goalResumeTool, readGoalRevisionForCaller,
  resumeGoalForCaller } from './goalRevisionTool';

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

describe('exact same-Goal conditional resume', () => {
  const paused = { ...revision, status: 'paused' as const };
  test('calls the native CAS once with the verified owner and returns only its confirmed revision', async () => {
    const calls: unknown[] = [];
    const result = await resumeGoalForCaller({ threadId, verifiedCallerThreadId: threadId }, paused,
      async (owner, expected) => { calls.push([owner, expected]); return {
        revision: { ...expected, status: 'active', lifecycleRevision: 6 },
      }; });
    expect(calls).toEqual([[threadId, paused]]);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ resumed: true,
      revision: { ...paused, status: 'active', lifecycleRevision: 6 } });
    expect(goalResumeTool.mainAgentOnly).toBe(true);
    expect(goalResumeTool.mode).toBe('write');
  });

  test('unbound, cross-thread, malformed, completed or stale input never reaches native', async () => {
    let calls = 0;
    const resume = async () => { calls++; return { revision: paused }; };
    for (const context of [undefined, { threadId },
      { threadId, verifiedCallerThreadId: otherThread },
      { threadId, verifiedCallerThreadId: threadId, isSubagent: true }]) {
      const result = await resumeGoalForCaller(context, paused, resume);
      expect(JSON.parse(result.content[0]!.text).category).toBe('caller_unavailable');
    }
    for (const input of [undefined, { ...paused, goalId: 'bad' },
      { ...paused, missionRevision: 0 }, { ...paused, status: 'complete' }]) {
      const result = await resumeGoalForCaller({ threadId, verifiedCallerThreadId: threadId },
        input, resume);
      expect(JSON.parse(result.content[0]!.text).category).toBe('invalid_revision');
    }
    expect(calls).toBe(0);
  });

  test('an ambiguous native outcome never reissues CAS or leaks its error', async () => {
    let calls = 0;
    const result = await resumeGoalForCaller({ threadId, verifiedCallerThreadId: threadId }, paused,
      async () => { calls++; throw new Error('PRIVATE native text'); });
    expect(calls).toBe(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ resumed: false,
      category: 'mutation_unconfirmed' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
