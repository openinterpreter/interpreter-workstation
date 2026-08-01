import { describe, expect, test } from 'bun:test';
import {
  executeBlock,
  executeWorkflow,
  resolveReferences,
} from './automationEngine';
import {
  automationReducer,
  createEmptyWorkflow,
  parseAutomationWorkflow,
  type AutomationAction,
  type AutomationBlock,
  type AutomationState,
  type BlockOutput,
} from '../types/automation';

function makeBlock(overrides: Partial<AutomationBlock> = {}): AutomationBlock {
  return {
    id: 'block_aaaa1111',
    serverId: 'builtin-filesystem',
    toolName: 'read_file',
    label: 'Read File',
    inputs: {},
    position: 0,
    ...overrides,
  };
}

function makeState(blocks: AutomationBlock[], blockOutputs: Record<string, BlockOutput> = {}): AutomationState {
  return {
    workflow: {
      version: 1,
      name: 'Test Automation',
      blocks,
    },
    blockOutputs,
    runningBlockId: null,
    runningAll: false,
  };
}

describe('automationReducer', () => {
  test('moves blocks downward using insertion semantics and clears downstream outputs', () => {
    const blockA = makeBlock({ id: 'block_aaaa1111', position: 0, label: 'A' });
    const blockB = makeBlock({ id: 'block_bbbb2222', position: 1, label: 'B' });
    const blockC = makeBlock({ id: 'block_cccc3333', position: 2, label: 'C' });
    const state = makeState(
      [blockA, blockB, blockC],
      {
        [blockA.id]: { result: 'A', timestamp: 1 },
        [blockB.id]: { result: 'B', timestamp: 1 },
        [blockC.id]: { result: 'C', timestamp: 1 },
      },
    );

    const next = automationReducer(state, {
      type: 'MOVE_BLOCK',
      blockId: blockB.id,
      toPosition: 3,
    });

    expect(next.workflow.blocks.map(block => block.id)).toEqual([
      blockA.id,
      blockC.id,
      blockB.id,
    ]);
    expect(next.blockOutputs).toEqual({
      [blockA.id]: { result: 'A', timestamp: 1 },
    });
  });

  test('removing a block strips the full stale reference token including path suffixes', () => {
    const blockA = makeBlock({ id: 'block_aaaa1111', position: 0, label: 'A' });
    const blockB = makeBlock({ id: 'block_bbbb2222', position: 1, label: 'B' });
    const blockC = makeBlock({
      id: 'block_cccc3333',
      position: 2,
      label: 'C',
      inputs: {
        prompt: 'before @block_aaaa1111.value after',
      },
    });
    const state = makeState([blockA, blockB, blockC], {
      [blockB.id]: { result: 'B', timestamp: 1 },
      [blockC.id]: { result: 'C', timestamp: 1 },
    });

    const next = automationReducer(state, {
      type: 'REMOVE_BLOCK',
      blockId: blockA.id,
    });

    expect(next.workflow.blocks).toHaveLength(2);
    expect(next.workflow.blocks[1].inputs.prompt).toBe('before  after');
    expect(next.blockOutputs).toEqual({});
  });

  test('editing a block input clears outputs for that block and everything after it', () => {
    const blockA = makeBlock({ id: 'block_aaaa1111', position: 0 });
    const blockB = makeBlock({ id: 'block_bbbb2222', position: 1 });
    const blockC = makeBlock({ id: 'block_cccc3333', position: 2 });
    const state = makeState(
      [blockA, blockB, blockC],
      {
        [blockA.id]: { result: 'A', timestamp: 1 },
        [blockB.id]: { result: 'B', timestamp: 1 },
        [blockC.id]: { result: 'C', timestamp: 1 },
      },
    );

    const next = automationReducer(state, {
      type: 'UPDATE_BLOCK_INPUT',
      blockId: blockB.id,
      key: 'path',
      value: '/tmp/file.txt',
    });

    expect(next.workflow.blocks[1].inputs.path).toBe('/tmp/file.txt');
    expect(next.blockOutputs).toEqual({
      [blockA.id]: { result: 'A', timestamp: 1 },
    });
  });
});

describe('parseAutomationWorkflow', () => {
  test('reindexes parsed blocks and rejects invalid content', () => {
    const parsed = parseAutomationWorkflow(JSON.stringify({
      version: 1,
      name: 'Workflow',
      blocks: [
        {
          id: 'block_aaaa1111',
          serverId: 'builtin-filesystem',
          toolName: 'read_file',
          label: 'Read',
          inputs: {},
          position: 4,
        },
      ],
    }));

    expect(parsed.blocks[0].position).toBe(0);
    expect(() => parseAutomationWorkflow('{')).toThrow('Invalid automation JSON');
    expect(() => parseAutomationWorkflow(JSON.stringify({ version: 2, name: 'Bad', blocks: [] }))).toThrow(
      'Invalid automation workflow: expected version 1',
    );
  });
});

describe('resolveReferences', () => {
  test('preserves non-reference whitespace while still resolving exact references', () => {
    expect(resolveReferences('  keep me  ', {})).toBe('  keep me  ');
    expect(resolveReferences('  @block_aaaa1111.value  ', {
      block_aaaa1111: {
        result: { value: 42 },
        timestamp: 1,
      },
    })).toBe(42);
  });
});

describe('executeBlock', () => {
  test('fails fast on unresolved references before calling the tool', async () => {
    let callCount = 0;
    const output = await executeBlock(
      makeBlock({
        inputs: { prompt: 'hello @block_missing999.value' },
      }),
      {},
      [],
      {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
        },
      },
      async () => {
        callCount += 1;
        return { ok: true };
      },
    );

    expect(callCount).toBe(0);
    expect(output.error).toContain('Unresolved reference');
  });

  test('validates required inputs and required profile context', async () => {
    const missingInput = await executeBlock(
      makeBlock({
        serverId: 'builtin-run-agent',
        toolName: 'run_agent',
      }),
      {},
      [],
      {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
        },
      },
      async () => ({ ok: true }),
    );

    expect(missingInput.error).toContain('prompt is required');
    expect(missingInput.error).toContain('requires a model/profile selection');
  });
});

describe('executeWorkflow', () => {
  test('stops on the first validation error and does not execute later blocks', async () => {
    const blockA = makeBlock({
      id: 'block_aaaa1111',
      position: 0,
      inputs: { path: '/tmp/file-a.txt' },
    });
    const blockB = makeBlock({
      id: 'block_bbbb2222',
      position: 1,
      inputs: {},
    });
    const blockC = makeBlock({
      id: 'block_cccc3333',
      position: 2,
      inputs: { path: '/tmp/file-c.txt' },
    });

    const actions: AutomationAction[] = [];
    const executedBlocks: string[] = [];

    await executeWorkflow(
      [blockA, blockB, blockC],
      action => actions.push(action),
      {},
      [],
      block => ({
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
        },
      }),
      async (_serverId, _toolName, args) => {
        executedBlocks.push(String(args.path));
        return { ok: true };
      },
    );

    expect(executedBlocks).toEqual(['/tmp/file-a.txt']);

    const outputActions = actions.filter(
      (action): action is Extract<AutomationAction, { type: 'SET_BLOCK_OUTPUT' }> =>
        action.type === 'SET_BLOCK_OUTPUT',
    );
    expect(outputActions).toHaveLength(2);
    expect(outputActions[0].blockId).toBe(blockA.id);
    expect(outputActions[0].output.error).toBeUndefined();
    expect(outputActions[1].blockId).toBe(blockB.id);
    expect(outputActions[1].output.error).toContain('path is required');
    expect(actions.some(action => action.type === 'SET_RUNNING_ALL' && action.running === false)).toBe(true);
  });
});
