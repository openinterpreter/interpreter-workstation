/**
 * Settings Get Tool
 *
 * Get Interpreter settings using JS-style path syntax.
 * Examples: "theme", "profiles[0].name", "mcpServers.nylas", "" (entire config)
 */

import lodash from 'lodash';
import type { BuiltinToolDefinition } from '../../builtinTools';
import * as configStore from '../../../configStore';
import { INTERPRETER_CLI_COMMAND } from '../../../utils/interpreterCliRuntime';

const { get } = lodash;

export const settingsGetTool: BuiltinToolDefinition = {
  name: 'interpreter_settings_get',
  description:
    `Get Interpreter settings using JS path syntax. Start with \`${INTERPRETER_CLI_COMMAND} config --help\` to see common settings paths. Examples: "theme", "profiles[0].name", "mcpServers.nylas", "" (empty = entire config).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'JS-style path like "theme", "profiles[0].name", or "mcpServers.nylas.enabled". Empty string returns the entire config.',
      },
    },
    required: ['path'],
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args) => {
    const { path } = args as { path: string };
    try {
      // Get the canonical merged config (single source of truth)
      const fullConfig = await configStore.getFullConfig();

      // Get value at path (empty path = entire config)
      const value = path === '' ? fullConfig : get(fullConfig, path);

      // Return null for undefined (path exists but not set), not an error
      return {
        content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get Interpreter settings: ${message}` }],
        isError: true,
      };
    }
  },
};
