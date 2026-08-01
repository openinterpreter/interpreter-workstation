import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';
import { normalizeBrowserId } from './index';

export const getTabStateTool: BuiltinToolDefinition = {
  name: 'browser_get_tab_state',
  description: 'Get the current state of a browser tab including URL, title, loading status, and navigation capabilities.',
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description: 'The unique identifier of the browser tab (can include browser:// prefix from mentions)'
      }
    },
    required: ['tab_id']
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args: Record<string, any>) => {
    try {
      const tabId = normalizeBrowserId(args.tab_id as string);
      const state = browserService.getState(tabId);

      if (!state) {
        return {
          content: [{
            type: 'text',
            text: `Browser tab not found: ${tabId}`
          }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(state, null, 2)
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to get tab state: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
