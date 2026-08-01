import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService } from '../../../../electron/services/browser';

export const formInputTool: BuiltinToolDefinition = {
  name: 'browser_form_input',
  description: `Fill a form field in a browser tab using its reference ID.

Reference IDs are obtained from browser_read_page.

Supported element types:
- Text inputs (text, email, password, search, tel, url, number)
- Textareas
- Checkboxes (pass true/false)
- Radio buttons (pass true to select)
- Select dropdowns (pass the option value or text)
- Content-editable elements`,
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description: 'The ID of the browser tab (can include browser:// prefix from mentions)'
      },
      ref_id: {
        type: 'string',
        description: 'The reference ID of the form element (e.g., "ref_1", "ref_5")'
      },
      value: {
        oneOf: [
          { type: 'string' },
          { type: 'boolean' },
          { type: 'number' }
        ],
        description: 'The value to set. Use string for text inputs, boolean for checkboxes, etc.'
      }
    },
    required: ['tab_id', 'ref_id', 'value']
  },
  handler: async (args) => {
    try {
      const { tab_id, ref_id, value } = args as { tab_id: string; ref_id: string; value: string | boolean | number };

      const result = await browserService.fillElement(tab_id, ref_id, value);

      const output = [
        `Filled element ${ref_id}`,
        `  Element: ${result.element}`,
        `  Type: ${result.type}`,
        `  Value set: ${JSON.stringify(result.value)}`
      ].join('\n');

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
          text: `Failed to fill form element: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
