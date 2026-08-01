import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';
import { normalizeBrowserId } from './index';

export const goForwardTool: BuiltinToolDefinition = {
  name: 'browser_go_forward',
  description: 'Navigate a browser tab forward in history.',
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

      if (!state.canGoForward) {
        return {
          content: [{
            type: 'text',
            text: `Cannot go forward: no next page in history for tab ${tabId}`
          }],
          isError: false
        };
      }

      browserService.goForward(tabId);

      return {
        content: [{
          type: 'text',
          text: `Navigated tab ${tabId} forward in history`
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to go forward: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
