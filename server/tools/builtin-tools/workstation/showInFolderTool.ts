import { existsSync } from 'node:fs';

import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';

export const showInFolderTool: BuiltinToolDefinition = {
  name: 'interpreter_show_in_folder',
  description:
    'Reveal a file or folder in the system file manager. Use this instead of shell commands like open, open -R, explorer, or osascript when the user asks to show something in Finder, File Explorer, or the file manager.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to reveal (absolute or workspace-relative).',
      },
    },
    required: ['path'],
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'path',
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  handler: async (args: Record<string, unknown>, context?: BuiltinToolContext) => {
    const rawPath = typeof args.path === 'string' ? args.path : '';
    if (!rawPath) {
      return {
        content: [{ type: 'text', text: 'Missing required parameter: path' }],
        isError: true,
      };
    }

    try {
      const workspace = context?.workspace ?? getCurrentWorkspace();
      const resolvedPath = resolvePathWithWorkspace(rawPath, workspace);
      if (!existsSync(resolvedPath)) {
        return {
          content: [{ type: 'text', text: `Path not found: ${resolvedPath}` }],
          isError: true,
        };
      }

      const { shell } = await import('electron');
      shell.showItemInFolder(resolvedPath);
      return {
        content: [{ type: 'text', text: `Revealed in file manager: ${resolvedPath}` }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to reveal path in file manager: ${message}` }],
        isError: true,
      };
    }
  },
};
