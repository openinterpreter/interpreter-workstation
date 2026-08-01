/**
 * Ask User Server Definition
 *
 * Built-in server for asking users clarifying questions during agent execution.
 */

import type { BuiltinServerDefinition } from '../../builtinTools';
import { askUserQuestionTool } from './askUserTool';

export const askUserServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-ask-user',
  name: 'Ask User',
  description: 'Ask the user structured multiple-choice questions during agent execution',
  isBuiltin: true,
  tools: [askUserQuestionTool],
  resources: [],
  prompts: [],
};
