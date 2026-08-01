import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';
import { normalizeBrowserId } from './index';

export const reloadTool: BuiltinToolDefinition = {
  name: 'browser_reload',
  description: 'Reload the current page in a browser tab.',
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

      browserService.reload(tabId);

      return {
        content: [{
          type: 'text',
          text: `Reloaded tab ${tabId}`
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to reload: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
