import type { BuiltinServerDefinition } from '../../builtinTools';
import { createTasksTool } from './createTasksTool';
import { updateTaskTool } from './updateTaskTool';

export const tasksServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-tasks',
  name: 'Task List',
  description: 'Task tracking for multi-step work',
  isBuiltin: true,
  tools: [createTasksTool, updateTaskTool],
  resources: [],
  prompts: [],
};
