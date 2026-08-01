import type { BuiltinServerDefinition } from '../../builtinTools';
import { jsReplTool } from './jsReplTool';
import { jsReplResetTool } from './jsReplResetTool';

export const jsReplServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-js-repl',
  name: 'JavaScript REPL',
  description: 'Persistent JavaScript (Node) kernel with top-level await; powers browser control through interpreter-browser-control and playwright-core',
  isBuiltin: true,
  tools: [jsReplTool, jsReplResetTool],
  resources: [],
  prompts: [],
};
