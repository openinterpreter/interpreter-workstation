import { describe, expect, test } from 'bun:test';
import type { BuiltinToolContext } from '../../builtinTools';
import type { v2 } from '../../../handlers/codex-generated-types/index';
import { currentTaskTool, readCurrentTaskForCaller } from './currentTaskTool';

const threadId = '00000000-0000-4000-8000-000000000077';
const otherThread = '00000000-0000-4000-8000-000000000078';
const owner = { threadId, verifiedCallerThreadId: threadId };
const saved = {
  id: threadId, turns: [
    { id: 'older-turn', status: 'completed', itemsView: 'full', items: [
      { type: 'agentMessage', id: 'old-message', text: 'PRIVATE response' } ] },
    { id: 'current-turn', status: 'inProgress', startedAt: 100, completedAt: null,
      itemsView: 'full', items: [
        { type: 'commandExecution', id: 'command-item', status: 'completed', exitCode: 0,
          processId: 'opaque-process', command: 'PRIVATE command', aggregatedOutput: 'PRIVATE output' } ] },
  ],
} as unknown as v2.Thread;

const parse = (result: Awaited<ReturnType<typeof readCurrentTaskForCaller>>) =>
  JSON.parse(result.content[0]!.text);

describe('same-thread bounded current task tool', () => {
  test('uses a verified original main-agent thread and labels historical messages and saved commands', async () => {
    const calls: string[] = [];
    const result = await readCurrentTaskForCaller(owner, async id => { calls.push(id); return saved; });
    expect(calls).toEqual([threadId]);
    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.available).toBe(true);
    expect(body.threadId).toBe(threadId);
    expect(body.turn).toEqual({ id: 'current-turn', status: 'inProgress',
      startedAt: 100, completedAt: null });
    expect(body.latestMessage).toEqual({ turnId: 'older-turn', relation: 'historical' });
    expect(body.preview.relation).toBe('initial-thread-historical-non-authoritative');
    expect(body.modelPhase).toEqual({ available: false,
      category: 'native_model_phase_unavailable' });
    expect(body.command).toEqual({ itemId: 'command-item', status: 'completed',
      exitCode: 0, processId: 'opaque-process',
      observation: 'saved-command-item-not-os-process-custody' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(currentTaskTool.mainAgentOnly).toBe(true);
    expect(currentTaskTool.mode).toBe('read');
  });

  test('unbound, cross-thread and delegated callers cannot read another saved turn', async () => {
    let reads = 0;
    for (const context of [undefined, { threadId },
      { threadId, verifiedCallerThreadId: otherThread },
      { threadId: otherThread, verifiedCallerThreadId: threadId },
      { threadId, verifiedCallerThreadId: threadId, isSubagent: true },
      { threadId, verifiedCallerThreadId: threadId, toolCallPath: ['delegated'] },
    ] as Array<BuiltinToolContext | undefined>) {
      const result = await readCurrentTaskForCaller(context, async () => { reads++; return saved; });
      expect(parse(result)).toEqual({ available: false, category: 'caller_unavailable' });
    }
    expect(reads).toBe(0);
  });

  test('wrong-thread snapshot, unavailable native view and deadline never imply no work', async () => {
    const wrong = await readCurrentTaskForCaller(owner, async () => ({ ...saved, id: otherThread }));
    expect(parse(wrong)).toEqual({ available: false, category: 'observation_unavailable' });
    const privateError = await readCurrentTaskForCaller(owner,
      async () => { throw new Error('PRIVATE native text'); });
    expect(parse(privateError)).toEqual({ available: false, category: 'observation_unavailable' });
    expect(JSON.stringify(privateError)).not.toContain('PRIVATE');
    let complete!: (value: v2.Thread) => void;
    let reads = 0;
    const timeout = await readCurrentTaskForCaller(owner, () => {
      reads++;
      return new Promise(resolve => { complete = resolve; });
    }, 5);
    expect(parse(timeout)).toEqual({ available: false, category: 'observation_unavailable' });
    complete(saved);
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(parse(timeout).available).toBe(false);
  });

  test('invalid deadline refuses native work; a new verified caller can read after restart', async () => {
    let reads = 0;
    const read = async () => { reads++; return saved; };
    expect(parse(await readCurrentTaskForCaller(owner, read, 3_001)).category)
      .toBe('observation_unavailable');
    expect(reads).toBe(0);
    expect(parse(await readCurrentTaskForCaller({ ...owner }, read)).turn.id).toBe('current-turn');
    expect(reads).toBe(1);
  });
});
