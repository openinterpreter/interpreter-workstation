/**
 * Get Context Tool
 *
 * Retrieves the full Interpreter context including open tabs,
 * current selection, workspace path, and sidebar states.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { workstationService } from '../../../../electron/services/workstation';

export const getContextTool: BuiltinToolDefinition = {
  name: 'interpreter_get_context',
  description:
    'Get the full Interpreter context including all open tabs (files, browsers, emails), current selection, workspace path, and sidebar states. Use this to understand what the user is currently working on.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async () => {
    try {
      const context = await workstationService.getContext();

      if (!context) {
        return {
          content: [
            {
              type: 'text',
              text: 'Interpreter context is not available. The window may not be ready.',
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(context, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to get Interpreter context: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
