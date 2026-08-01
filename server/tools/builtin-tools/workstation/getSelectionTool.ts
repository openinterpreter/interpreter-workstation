/**
 * Get Selection Tool
 *
 * Retrieves just the current text selection from Interpreter.
 * More lightweight than getContext when you only need the selection.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { workstationService } from '../../../../electron/services/workstation';

export const getSelectionTool: BuiltinToolDefinition = {
  name: 'interpreter_get_selection',
  description:
    'Get the current selection in Interpreter. Returns text, file, or Office document selection details as JSON. Returns null if nothing is selected.',
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
      const selection = await workstationService.getSelection();

      if (!selection) {
        return {
          content: [
            {
              type: 'text',
              text: 'No selection is currently active.',
            },
          ],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(selection, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to get selection: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
