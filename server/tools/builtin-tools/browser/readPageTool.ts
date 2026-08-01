import type { BuiltinToolDefinition } from '../../builtinTools';
import { browserService, type AXNode } from '../../../../electron/services/browser';

function formatNode(node: AXNode): string {
  const parts: string[] = [];

  if (node.ref) {
    parts.push(`[${node.ref}]`);
  }

  const role = node.role?.value;
  if (role) {
    parts.push(role);
  }

  const name = node.name?.value;
  if (name) {
    parts.push(`"${name}"`);
  }

  const properties = node.properties || [];
  const typeProperty = properties.find(p => p.name === 'type');
  if (typeProperty) {
    parts.push(`type="${typeProperty.value.value}"`);
  }

  const placeholderProperty = properties.find(p => p.name === 'placeholder');
  if (placeholderProperty) {
    parts.push(`placeholder="${placeholderProperty.value.value}"`);
  }

  const valueProperty = properties.find(p => p.name === 'value');
  if (valueProperty && valueProperty.value.value) {
    parts.push(`value="${valueProperty.value.value}"`);
  }

  const checkedProperty = properties.find(p => p.name === 'checked');
  if (checkedProperty) {
    parts.push(`checked=${checkedProperty.value.value}`);
  }

  const disabledProperty = properties.find(p => p.name === 'disabled');
  if (disabledProperty && disabledProperty.value.value) {
    parts.push('(disabled)');
  }

  return parts.join(' ');
}

export const readPageTool: BuiltinToolDefinition = {
  name: 'browser_read_page',
  description: `Read the accessibility tree of a browser tab. Returns element references (ref_1, ref_2, etc.) that can be used with browser_click and browser_form_input tools.

Use filter="interactive" to only return clickable/editable elements (buttons, links, inputs, etc.).`,
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'string',
        description: 'The ID of the browser tab to read'
      },
      filter: {
        type: 'string',
        enum: ['interactive'],
        description: 'Optional filter. Use "interactive" to only return clickable and editable elements.'
      }
    },
    required: ['tab_id']
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args) => {
    try {
      const { tab_id, filter } = args as { tab_id: string; filter?: 'interactive' };

      const options = filter ? { filter } : undefined;
      const tree = await browserService.getAccessibilityTree(tab_id, options);

      const refMapping = new Map<string, number>();
      let refCounter = 1;
      const formattedLines: string[] = [];

      if (tree.nodes) {
        for (const node of tree.nodes) {
          if (node.role?.value === 'RootWebArea') {
            continue;
          }

          const refId = `ref_${refCounter++}`;
          node.ref = refId;

          if (node.backendDOMNodeId) {
            refMapping.set(refId, node.backendDOMNodeId);
          }

          const formatted = formatNode(node);
          if (formatted.trim()) {
            formattedLines.push(formatted);
          }
        }
      }

      browserService.setRefMapping(tab_id, refMapping);

      const filterNote = filter === 'interactive'
        ? ' (filtered for interactive elements)'
        : '';

      const output = [
        `Page structure for tab "${tab_id}"${filterNote}:`,
        `Total elements: ${formattedLines.length}`,
        '',
        ...formattedLines
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
          text: `Failed to read page: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
