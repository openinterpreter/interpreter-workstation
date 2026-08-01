import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { taskStore } from './taskStore';

export const createTasksTool: BuiltinToolDefinition = {
  name: 'create_tasks',
  description:
    'Create a task list for multi-step work. Use this to plan out a sequence of tasks before starting. ' +
    'You MUST complete all tasks before finishing. The system will automatically remind you if you stop with incomplete tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of task descriptions, e.g. ["Fill pages 1-5", "Fill pages 6-10", "Review all fields"]',
      },
    },
    required: ['tasks'],
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    const agentId = context?.agentId;
    if (!agentId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No agent context available' }) }],
        isError: true,
      };
    }

    const descriptions = args.tasks as string[];
    if (!descriptions || !Array.isArray(descriptions) || descriptions.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'tasks must be a non-empty array of strings' }) }],
        isError: true,
      };
    }

    const allTasks = taskStore.create(agentId, descriptions);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          message: `Created ${descriptions.length} task(s). Complete all tasks before finishing.`,
          tasks: allTasks,
        }, null, 2),
      }],
      isError: false,
    };
  },
};
