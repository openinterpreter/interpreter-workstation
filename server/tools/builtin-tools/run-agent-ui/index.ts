// Run Agent UI Server Definition
import type { BuiltinServerDefinition } from '../../builtinTools';
import { runAgentUiTool } from './runAgentUiTool';

export const runAgentUiServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-run-agent-ui',
  name: 'Run Agent UI',
  description: 'Create visible agent tabs in the UI for user monitoring',
  isBuiltin: true,
  tools: [runAgentUiTool],
  resources: [],
  prompts: []
};
