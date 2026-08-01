import type { BuiltinToolDefinition } from '../../builtinTools';
import * as configStore from '../../../configStore';

export const customInstructionsGetTool: BuiltinToolDefinition = {
  name: 'interpreter_custom_instructions_get',
  description: 'Read the saved Interpreter custom instructions.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async () => {
    try {
      const customInstructions = await configStore.getCustomInstructions();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ customInstructions }, null, 2),
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to read Interpreter custom instructions: ${message}` }],
        isError: true,
      };
    }
  },
};

export const customInstructionsSetTool: BuiltinToolDefinition = {
  name: 'interpreter_custom_instructions_set',
  description: 'Replace the saved Interpreter custom instructions. Pass an empty string to clear them.',
  inputSchema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description: 'The full custom instructions text to save. Empty or whitespace-only text clears the saved instructions.',
      },
    },
    required: ['instructions'],
  },
  handler: async (args) => {
    const instructions = args.instructions;
    if (typeof instructions !== 'string') {
      return {
        content: [{ type: 'text', text: 'instructions must be a string' }],
        isError: true,
      };
    }

    try {
      const customInstructions = await configStore.setCustomInstructions(instructions);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, customInstructions }, null, 2),
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to save Interpreter custom instructions: ${message}` }],
        isError: true,
      };
    }
  },
};
