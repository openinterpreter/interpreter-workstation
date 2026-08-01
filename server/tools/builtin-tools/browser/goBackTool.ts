import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';
import { normalizeBrowserId } from './index';

export const goBackTool: BuiltinToolDefinition = {
  name: 'browser_go_back',
  description: 'Navigate a browser tab back in history.',
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

      if (!state.canGoBack) {
        return {
          content: [{
            type: 'text',
            text: `Cannot go back: no previous page in history for tab ${tabId}`
          }],
          isError: false
        };
      }

      browserService.goBack(tabId);

      return {
        content: [{
          type: 'text',
          text: `Navigated tab ${tabId} back in history`
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to go back: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
