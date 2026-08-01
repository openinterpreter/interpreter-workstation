import type { BuiltinServerDefinition } from '../../builtinTools';
import { waitTool } from './waitTool';
import { calculatorTool } from './calculatorTool';
import { speakTextTool } from './speakTextTool';

export const utilityServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-utility',
  name: 'Utility Tools',
  description: 'General utility tools like wait/sleep and calculator',
  isBuiltin: true,
  tools: [waitTool, calculatorTool, speakTextTool],
  resources: [],
  prompts: [],
};
