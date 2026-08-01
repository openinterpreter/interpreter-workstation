import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { taskStore } from './taskStore';

export const updateTaskTool: BuiltinToolDefinition = {
  name: 'update_task',
  description:
    'Update the status of a task in your task list. Mark tasks as "in_progress" when you start them and "done" when complete.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'number',
        description: 'The ID of the task to update',
      },
      status: {
        type: 'string',
        enum: ['in_progress', 'done'],
        description: 'New status for the task',
      },
    },
    required: ['task_id', 'status'],
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    const agentId = context?.agentId;
    if (!agentId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No agent context available' }) }],
        isError: true,
      };
    }

    const taskId = args.task_id as number;
    const status = args.status as 'in_progress' | 'done';

    if ((taskId === undefined || taskId === null) || !status) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'task_id and status are required' }) }],
        isError: true,
      };
    }

    const updated = taskStore.update(agentId, taskId, status);
    if (!updated) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Task ${taskId} not found` }) }],
        isError: true,
      };
    }

    const allTasks = taskStore.getAll(agentId);
    const incomplete = taskStore.getIncomplete(agentId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          updated: updated,
          remaining: incomplete.length,
          tasks: allTasks,
        }, null, 2),
      }],
      isError: false,
    };
  },
};
