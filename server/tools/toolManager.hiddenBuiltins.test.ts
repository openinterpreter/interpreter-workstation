import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('../utils/mcpServiceBridge', () => ({
  getMcpService: () => ({
    listServers: async () => ({ data: [], nextCursor: null }),
    listServersForDisplay: async () => ({ data: [], nextCursor: null }),
    listAuthStatusesViaCli: async () => new Map(),
    getServerStatus: async () => null,
    getDisplayServerStatus: async () => null,
  }),
  McpService: {
    toToolServerStatus: (s: any) => ({ id: s.name, name: s.name, state: { status: 'connected', tools: [], resources: [], prompts: [] } }),
    toToolConnectionState: (s: any) => ({ status: 'connected', tools: [], resources: [], prompts: [] }),
  },
}));

import { clearConfigCache, setConfigOverride } from '../configStore';
import {
  AGENT_FACING_HIDDEN_SERVER_IDS,
  getBuiltinServersIncludingHidden,
  isHiddenBuiltinServerId,
} from './builtinTools';
import { isCuaDriverSupportedPlatform } from './builtin-tools/cua-driver';
import { ToolManager } from './toolManager';

afterEach(() => {
  setConfigOverride(null);
  clearConfigCache();
});

describe('ToolManager hidden builtin discovery', () => {
  test('keeps every built-in server on the builtin-id convention', () => {
    for (const server of getBuiltinServersIncludingHidden()) {
      expect(server.id.startsWith('builtin-')).toBe(true);
    }
  });

  test('registers Cua Driver only on supported native desktop platforms', () => {
    expect(isCuaDriverSupportedPlatform('darwin')).toBe(true);
    expect(isCuaDriverSupportedPlatform('win32')).toBe(true);
    expect(isCuaDriverSupportedPlatform('linux')).toBe(false);

    const serverIds = getBuiltinServersIncludingHidden().map((server) => server.id);
    if (isCuaDriverSupportedPlatform(process.platform)) {
      expect(serverIds).toContain('builtin-cua-driver');
    } else {
      expect(serverIds).not.toContain('builtin-cua-driver');
    }
  });

  test('re-adds only the internal hidden builtins for agent tool discovery', async () => {
    setConfigOverride({
      agents: {},
      globalDisabledTools: [],
      mcpServers: {},
    } as any);

    const toolManager = new ToolManager();
    const tools = await toolManager.getEnabledToolsForAgent();
    const hiddenServerIds = Array.from(
      new Set(
        tools
          .map((tool) => tool.serverId)
          .filter((serverId) => isHiddenBuiltinServerId(serverId)),
      ),
    ).sort();

    expect(hiddenServerIds).toEqual([...AGENT_FACING_HIDDEN_SERVER_IDS].sort());
    expect(hiddenServerIds).not.toContain('builtin-test-approval');
    expect(hiddenServerIds).not.toContain('builtin-echo-secret');
  });
});
