import { existsSync } from 'node:fs';

import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import { IPC_CHANNELS } from '../../../../electron/ipc/registry';
import { resolvePathWithWorkspace } from '../../../utils/permissions';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { emitEvent } from '../../../utils/ipcBridge';

export const refreshFileTool: BuiltinToolDefinition = {
  name: 'interpreter_refresh_file',
  description:
    'Notify Interpreter that a file changed on disk so any open viewer tab reloads it. Use this after shell/Python edits that bypass native file-edit tools.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file that changed (absolute or workspace-relative).',
      },
    },
    required: ['path'],
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'path',
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
          content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
          isError: true,
        };
      }

      await emitEvent(IPC_CHANNELS.FILE_REFRESHED, { filePath: resolvedPath });
      return {
        content: [{ type: 'text', text: `Refreshed file viewer for: ${resolvedPath}` }],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to refresh file viewer: ${message}` }],
        isError: true,
      };
    }
  },
};
