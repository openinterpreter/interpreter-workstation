import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';

export const clickTool: BuiltinToolDefinition = {
  name: 'browser_click',
  description: `Click on an element in a browser tab using its reference ID.

Reference IDs are obtained from browser_read_page. The click uses real mouse events that websites detect as actual user clicks.

The element will be scrolled into view if needed before clicking.`,
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description: 'The ID of the browser tab (can include browser:// prefix from mentions)'
      },
      ref_id: {
        type: 'string',
        description: 'The reference ID of the element to click (e.g., "ref_1", "ref_5")'
      }
    },
    required: ['tab_id', 'ref_id']
  },
  handler: async (args) => {
    try {
      const { tab_id, ref_id } = args as { tab_id: string; ref_id: string };

      const result = await browserService.clickElement(tab_id, ref_id);

      const output = [
        `Clicked element ${ref_id}`,
        `  Element: ${result.element}`,
        `  Coordinates: (${Math.round(result.x)}, ${Math.round(result.y)})`,
        result.scrolled ? '  (scrolled into view)' : ''
      ].filter(Boolean).join('\n');

      return {
        content: [{
          type: 'text',
          text: output
        }],
        isError: false
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Failed to click element: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
