// Web Search Server
// Provides access to a cloud agent with web search, code interpreter, and website visiting

import type { BuiltinServerDefinition } from '../../builtinTools';
import { googleQueryTool } from './query';

export const googleServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-google',
  name: 'Web Search',
  description: 'Search the web, run Python code, and visit websites using our cloud-based Web Agent',
  isBuiltin: true,
  tools: [googleQueryTool],
  resources: [],
  prompts: []
};
