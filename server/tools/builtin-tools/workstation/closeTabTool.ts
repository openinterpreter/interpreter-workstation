/**
 * Close Tab Tool
 *
 * Closes a tab in Interpreter by its ID.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { workstationService } from '../../../../electron/services/workstation';

export const closeTabTool: BuiltinToolDefinition = {
  name: 'interpreter_close_tab',
  description:
    'Close a tab in Interpreter. Works for any tab type (file, browser, email). Use interpreter_get to find tab IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description:
          'The tab identifier to close. Use interpreter_get to find tab IDs (tab_id field on each tab).',
      },
    },
    required: ['tab_id'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const tabId = args.tab_id as string;

      if (!tabId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Missing required parameter: tab_id',
            },
          ],
          isError: true,
        };
      }

      workstationService.closeTab(tabId);

      return {
        content: [
          {
            type: 'text',
            text: `Closed tab: ${tabId}`,
          },
        ],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to close tab: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
