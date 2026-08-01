/**
 * Set Layout Tool
 *
 * Mutates the Interpreter layout at a given path using reconciliation.
 * The reconciler handles tab reuse, creation, movement, and auto-collapse.
 */

import type { BuiltinToolDefinition } from '../../builtinTools';
import { workstationService } from '../../../../electron/services/workstation';
import { existsSync } from 'fs';

/**
 * Recursively collect all file paths from tab entries in a layout value.
 * Handles tree nodes (split/pane), arrays of tab entries, and single tab entries.
 */
function collectFilePaths(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  const paths: string[] = [];

  // Single tab entry with a path field
  if (typeof value.path === 'string' && !value.kind && !value.children && !value.tabs) {
    paths.push(value.path);
    return paths;
  }

  // Pane node with tabs array
  if (value.kind === 'pane' && Array.isArray(value.tabs)) {
    for (const tab of value.tabs) {
      if (tab && typeof tab.path === 'string') {
        paths.push(tab.path);
      }
    }
    return paths;
  }

  // Split node with children
  if (value.kind === 'split' && Array.isArray(value.children)) {
    for (const child of value.children) {
      paths.push(...collectFilePaths(child));
    }
    return paths;
  }

  // Array of tab entries (e.g. when setting path="tree.children[0].tabs")
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item.path === 'string') {
        paths.push(item.path);
      }
    }
    return paths;
  }

  // Object with sidebar_tabs or tree (full layout object)
  if (value.tree) paths.push(...collectFilePaths(value.tree));
  if (Array.isArray(value.sidebar_tabs)) {
    for (const tab of value.sidebar_tabs) {
      if (tab && typeof tab.path === 'string') {
        paths.push(tab.path);
      }
    }
  }

  return paths;
}

export const setLayoutTool: BuiltinToolDefinition = {
  name: 'interpreter_set',
  description:
    'Set a value in the Interpreter layout at the given path. Uses reconciliation to handle tab creation, movement, and pane management. ' +
    'Tab entries with `tab_id` reuse existing tabs. Entries with `path`, `url`, `email_id`, `agent_tab_id`, or `settings_section` look up or create tabs — type is inferred automatically, you do NOT need to specify it. ' +
    'Tabs not mentioned in the new layout are appended to the first pane (never silently deleted — use interpreter_close_tab for that). ' +
    'Empty panes are auto-collapsed. Returns the resulting layout after reconciliation.\n\n' +
    'CREATING TABS — type is inferred from fields, do NOT specify type:\n' +
    '- {"path": "/path/to/file.pdf"} → opens a file tab (works for PDFs, images, code, any file)\n' +
    '- {"path": "/path/to/file.pdf", "page": 5} → opens a PDF and navigates to page 5 (use this to visually show work before filling form fields)\n' +
    '- {"url": "https://example.com"} → opens a browser tab\n' +
    '- {"email_id": "abc"} → opens an email tab\n' +
    '- {"agent_tab_id": "xyz"} → opens a terminal tab\n' +
    '- {"settings_section": "runtimePermissions"} → opens the Settings tab and focuses that section\n' +
    '- {"tab_id": "existing-id"} → reuses an existing tab by ID\n' +
    '- Existing Settings tabs update to the requested `settings_section` when reused\n' +
    '- You can create tabs AND arrange layout in a single interpreter_set call. No need to open files separately first.\n\n' +
    'SIDEBAR RULES — CRITICAL:\n' +
    '- sidebar_tabs ONLY accepts agent and terminal tabs. You CANNOT move files, PDFs, browsers, emails, or any other content tabs into sidebar_tabs. ' +
    'Attempting to do so will be rejected with a warning. The sidebar is exclusively for agents/terminals.\n' +
    '- The user\'s document tabs must ALWAYS stay in the main tree. Never move them to the sidebar.\n\n' +
    'IMPORTANT — when the user asks to "show", "open", "look at", or "display" content (files, PDFs, URLs, etc.):\n' +
    'The user wants to SEE the content prominently. Do this in a SINGLE interpreter_set call:\n' +
    '1. Close the left sidebar (file explorer) so content gets maximum screen space: set sidebars.left.is_open=false\n' +
    '2. Move yourself to sidebar_tabs if you are not already there — the sidebar is your natural home while the user views content.\n' +
    '3. Preserve the user\'s existing tabs — never close or discard them.\n' +
    '4. Open the requested content in the tree layout. Strategy:\n' +
    '   - If user has N existing items and asks to see N new items → keep existing tabs in the first pane, add new content panes to the right.\n' +
    '   - If user has 1 pane and asks for multiple items side by side → keep existing tabs in the leftmost pane, create new panes for the requested items.\n' +
    '   - If the user has a complex layout → consolidate existing tabs into the first pane, build the requested layout in the remaining space.\n' +
    '   - Never close or discard the user\'s existing tabs.\n' +
    '5. Ensure the right sidebar is open so you remain accessible: set sidebars.right.is_open=true\n\n' +
    'SPATIAL RULES — read these carefully:\n' +
    '- direction="horizontal" → children are SIDE BY SIDE: children[0] is LEFT, children[1] is RIGHT\n' +
    '- direction="vertical" → children are STACKED: children[0] is TOP, children[1] is BOTTOM\n' +
    '- "side by side" always means horizontal. "stacked" or "above/below" always means vertical.\n' +
    '- ratio is children[0]\'s share (0.5 = equal, 0.3 = children[0] gets 30%, children[1] gets 70%)\n' +
    '- For a 2x2 grid: horizontal split at root, each child is a vertical split\n' +
    '- For left + stacked right: horizontal split at root, children[1] is a vertical split\n\n' +
    'Examples:\n' +
    '- Toggle sidebar: path="sidebars.left.is_open", value=false\n' +
    '- Focus pane: path="active_pane_id", value="<pane_id>"\n' +
    '- Focus tab within pane: set {"tab_id":"t1","active":true} on one tab in the pane\'s tabs array (the others stay without active). If no tab has active:true, the first tab is active.\n' +
    '- Open Settings > Permissions > Runtime Permissions: path="tree.children[0].tabs", value=[{"settings_section":"runtimePermissions","active":true}]\n' +
    '- Side by side: path="tree", value={"kind":"split","direction":"horizontal","ratio":0.5,"children":[{"kind":"pane","tabs":[...]},{"kind":"pane","tabs":[...]}]}\n' +
    '- Stacked: path="tree", value={"kind":"split","direction":"vertical","ratio":0.5,"children":[{"kind":"pane","tabs":[...]},{"kind":"pane","tabs":[...]}]}\n' +
    '- Move tabs: path="tree.children[1].tabs", value=[{"tab_id":"t3"},{"tab_id":"t1"}]\n' +
    '- Open file in pane: path="tree.children[0].tabs", value=[{"tab_id":"t1"},{"path":"/src/new.ts"}]\n' +
    '- 3 panes equal thirds: use ratio=0.33 at root, ratio=0.5 for the remaining 67%. path="tree", value={"kind":"split","direction":"horizontal","ratio":0.33,"children":[{"kind":"pane","tabs":[{"path":"/a.pdf"}]},{"kind":"split","direction":"horizontal","ratio":0.5,"children":[{"kind":"pane","tabs":[{"path":"/b.pdf"}]},{"kind":"pane","tabs":[{"path":"/c.pdf"}]}]}]}\n' +
    '- N equal columns: first split ratio=1/N, then nested splits each use ratio=1/(remaining). Do NOT use 0.5 at every level — that produces unequal sizes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Lodash-style path into the layout object. Examples: "tree", "tree.children[0].tabs", "sidebars.left.is_open", "active_pane_id".',
      },
      value: {
        description: 'The value to set at the given path. Can be any JSON value.',
      },
    },
    required: ['path', 'value'],
  },
  handler: async (args) => {
    try {
      const path = args.path as string;
      let value = args.value;

      // Defend against double-encoded JSON from LLM tool calls
      if (typeof value === 'string' && (path === 'tree' || path === 'sidebar_tabs' || path.endsWith('.tabs'))) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object') {
            value = parsed;
          }
        } catch {
          // Not valid JSON string, use as-is
        }
      }

      if (!path) {
        return {
          content: [
              {
                type: 'text',
              text: 'The "path" parameter is required. Use interpreter_get to read the current layout first.',
              },
          ],
          isError: true,
        };
      }

      // Validate that all file paths in tab entries actually exist on disk.
      // Reject the entire call if any paths are missing — prevents the UI from
      // showing broken "file does not exist" panes.
      const filePaths = collectFilePaths(value);
      const missingPaths = filePaths.filter(p => !existsSync(p));
      if (missingPaths.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Cannot set layout: the following file paths do not exist:\n${missingPaths.map(p => `- ${p}`).join('\n')}\n\nUse list_directory to check which files exist before opening them.`,
            },
          ],
          isError: true,
        };
      }

      const result = await workstationService.setLayout(path, value);

      if (result === null || result === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Failed to set layout. The window may not be ready.',
            },
          ],
          isError: true,
        };
      }

      // Extract warnings from reconciliation (e.g. rejected sidebar tabs)
      const warnings: string[] = result?._warnings || [];
      if (warnings.length > 0) {
        delete result._warnings;
      }

      const content: Array<{ type: string; text: string }> = [];

      if (warnings.length > 0) {
        content.push({
          type: 'text',
          text: '⚠️ WARNINGS:\n' + warnings.map((w: string) => `- ${w}`).join('\n') +
            '\n\nRemember: sidebar_tabs only accepts agent and terminal tabs. All other tabs must stay in the main tree. ' +
            'To create tabs, just provide the identifying field (path, url, email_id, agent_tab_id) — type is inferred automatically.',
        });
      }

      content.push({
        type: 'text',
        text: JSON.stringify(result, null, 2),
      });

      return {
        content,
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to set Interpreter layout: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
