/**
 * Get Layout Tool
 *
 * Reads the Interpreter layout (or a sub-path of it) as an agent-friendly JSON object.
 * Replaces getContextTool and listTabsTool with a single, path-addressable tool.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { workstationService } from '../../../../electron/services/workstation';

export const getLayoutTool: BuiltinToolDefinition = {
  name: 'interpreter_get',
  description:
    'Read the Interpreter layout. Returns the full layout tree with panes, tabs, sidebars, and workspace path. ' +
    'Use the `path` parameter with lodash-style syntax to read a specific part (e.g. "tree", "tree.children[0].tabs", "sidebars.left", "active_pane_id"). ' +
    'Empty path returns the entire layout object. The response includes a `you_are` field with your own tab_id so you can identify yourself in the tree.\n\n' +
    'Spatial layout of the tree:\n' +
    '- direction="horizontal" → children are side by side: children[0] is LEFT, children[1] is RIGHT\n' +
    '- direction="vertical" → children are stacked: children[0] is TOP, children[1] is BOTTOM\n' +
    '- "side by side" = horizontal. "stacked" or "top/bottom" = vertical.\n' +
    '- ratio controls the divider position (0.5 = equal halves, 0.3 = 30%/70%).\n' +
    '- Splits can nest: a horizontal split with a vertical split as children[1] gives a left pane + top-right/bottom-right layout.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Lodash-style path into the layout object. Examples: "" (whole layout), "tree", "tree.children[0].tabs", "sidebars.left.is_open", "active_pane_id".',
      },
    },
    required: [],
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args, context) => {
    try {
      const path = args.path as string | undefined;
      // Terminal agents pass callerTabId via MCP URL path (/mcp/:profileId/:tabId)
      // Agent tabs pass agentId via AI SDK experimental_context (which is the layout tab.id)
      const callerTabId = context?.callerTabId || context?.agentId;
      const result = await workstationService.getLayout(path || undefined);

      if (result === null || result === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: path
                ? `No value found at path "${path}". The layout or window may not be ready.`
                : 'Interpreter layout is not available. The window may not be ready.',
            },
          ],
          isError: true,
        };
      }

      // Include caller identity so the agent knows which tab it is
      if (!path && typeof result === 'object' && result !== null && callerTabId) {
        (result as any).you_are = callerTabId;
      }

      const content: Array<{ type: string; text: string }> = [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ];

      if (callerTabId) {
        content.push({
          type: 'text',
          text: `Your tab ID is: ${callerTabId}`,
        });
      }

      return {
        content,
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to get Interpreter layout: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
