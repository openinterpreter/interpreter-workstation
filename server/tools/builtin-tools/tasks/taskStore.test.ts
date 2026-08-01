import { describe, test, expect, beforeEach } from 'bun:test';
import { taskStore } from './taskStore';
import { createTasksTool } from './createTasksTool';
import { updateTaskTool } from './updateTaskTool';

const AGENT = 'test-agent-1';
const AGENT2 = 'test-agent-2';

describe('TaskStore', () => {
  beforeEach(() => {
    taskStore.clear(AGENT);
    taskStore.clear(AGENT2);
  });

  test('create tasks and retrieve them', () => {
    const tasks = taskStore.create(AGENT, ['Task A', 'Task B', 'Task C']);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toEqual({ id: 1, description: 'Task A', status: 'pending' });
    expect(tasks[1]).toEqual({ id: 2, description: 'Task B', status: 'pending' });
    expect(tasks[2]).toEqual({ id: 3, description: 'Task C', status: 'pending' });
  });

  test('create appends to existing tasks with correct IDs', () => {
    taskStore.create(AGENT, ['First']);
    const all = taskStore.create(AGENT, ['Second', 'Third']);
    expect(all).toHaveLength(3);
    expect(all[1].id).toBe(2);
    expect(all[2].id).toBe(3);
  });

  test('update task status', () => {
    taskStore.create(AGENT, ['Do something']);
    const updated = taskStore.update(AGENT, 1, 'in_progress');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in_progress');

    const done = taskStore.update(AGENT, 1, 'done');
    expect(done!.status).toBe('done');
  });

  test('update returns null for nonexistent task', () => {
    taskStore.create(AGENT, ['Only one']);
    expect(taskStore.update(AGENT, 99, 'done')).toBeNull();
  });

  test('update returns null for nonexistent agent', () => {
    expect(taskStore.update('no-such-agent', 1, 'done')).toBeNull();
  });

  test('getIncomplete filters correctly', () => {
    taskStore.create(AGENT, ['A', 'B', 'C']);
    taskStore.update(AGENT, 1, 'done');
    taskStore.update(AGENT, 2, 'in_progress');

    const incomplete = taskStore.getIncomplete(AGENT);
    expect(incomplete).toHaveLength(2);
    expect(incomplete.map(t => t.id)).toEqual([2, 3]);
  });

  test('getIncomplete returns empty when all done', () => {
    taskStore.create(AGENT, ['A', 'B']);
    taskStore.update(AGENT, 1, 'done');
    taskStore.update(AGENT, 2, 'done');
    expect(taskStore.getIncomplete(AGENT)).toHaveLength(0);
  });

  test('agents have isolated task lists', () => {
    taskStore.create(AGENT, ['Agent1 task']);
    taskStore.create(AGENT2, ['Agent2 task']);

    expect(taskStore.getAll(AGENT)).toHaveLength(1);
    expect(taskStore.getAll(AGENT2)).toHaveLength(1);
    expect(taskStore.getAll(AGENT)[0].description).toBe('Agent1 task');
    expect(taskStore.getAll(AGENT2)[0].description).toBe('Agent2 task');
  });

  test('clear removes all tasks for agent', () => {
    taskStore.create(AGENT, ['A', 'B']);
    taskStore.clear(AGENT);
    expect(taskStore.getAll(AGENT)).toHaveLength(0);
  });

  test('getAll returns empty array for unknown agent', () => {
    expect(taskStore.getAll('unknown')).toEqual([]);
  });
});

describe('createTasksTool handler', () => {
  beforeEach(() => {
    taskStore.clear(AGENT);
  });

  test('creates tasks and returns them', async () => {
    const result = await createTasksTool.handler(
      { tasks: ['Step 1', 'Step 2'] },
      { agentId: AGENT }
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.message).toContain('2 task(s)');
  });

  test('returns error without agentId', async () => {
    const result = await createTasksTool.handler({ tasks: ['A'] });
    expect(result.isError).toBe(true);
  });

  test('returns error with empty array', async () => {
    const result = await createTasksTool.handler(
      { tasks: [] },
      { agentId: AGENT }
    );
    expect(result.isError).toBe(true);
  });

  test('returns error with missing tasks arg', async () => {
    const result = await createTasksTool.handler(
      {},
      { agentId: AGENT }
    );
    expect(result.isError).toBe(true);
  });
});

describe('updateTaskTool handler', () => {
  beforeEach(() => {
    taskStore.clear(AGENT);
    taskStore.create(AGENT, ['Task A', 'Task B']);
  });

  test('updates task and returns full list', async () => {
    const result = await updateTaskTool.handler(
      { task_id: 1, status: 'done' },
      { agentId: AGENT }
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.updated.status).toBe('done');
    expect(parsed.remaining).toBe(1);
    expect(parsed.tasks).toHaveLength(2);
  });

  test('returns error for nonexistent task', async () => {
    const result = await updateTaskTool.handler(
      { task_id: 99, status: 'done' },
      { agentId: AGENT }
    );
    expect(result.isError).toBe(true);
  });

  test('returns error without agentId', async () => {
    const result = await updateTaskTool.handler(
      { task_id: 1, status: 'done' }
    );
    expect(result.isError).toBe(true);
  });
});
