// Echo Secret Server - Test server with echo_secret tool
import type { BuiltinServerDefinition } from '../../builtinTools';
import { echoSecretTool } from './echoSecretTool';

export const echoSecretServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-echo-secret',
  name: 'Echo Secret',
  description: 'Test server with echo_secret tool for testing purposes',
  isBuiltin: true,
  tools: [echoSecretTool],
  resources: [],
  prompts: [],
};
