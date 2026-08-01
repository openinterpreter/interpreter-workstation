import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';
import { normalizeBrowserId } from './index';

export const navigateTool: BuiltinToolDefinition = {
  name: 'browser_navigate',
  description: 'Navigate a browser tab to a specified URL.',
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description: 'The unique identifier of the browser tab (can include browser:// prefix from mentions)'
      },
      url: {
        type: 'string',
        description: 'The URL to navigate to (e.g., "https://example.com")'
      }
    },
    required: ['tab_id', 'url']
  },
  handler: async (args: Record<string, any>) => {
    try {
      const tabId = normalizeBrowserId(args.tab_id as string);
      const url = args.url as string;

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

      await browserService.navigate(tabId, url);

      return {
        content: [{
          type: 'text',
          text: `Navigated tab ${tabId} to: ${url}`
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to navigate: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
