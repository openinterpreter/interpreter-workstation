// Run Agent Server Definition
import type { BuiltinServerDefinition } from '../../builtinTools';
import { runAgentTool } from './runAgentTool';

export const runAgentServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-run-agent',
  name: 'Run Agent',
  description: 'Programmatic agent execution - create agent tabs and send messages',
  isBuiltin: true,
  tools: [runAgentTool],
  resources: [],
  prompts: []
};
