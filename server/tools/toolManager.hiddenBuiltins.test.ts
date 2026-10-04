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
  getBuiltinServers,
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
  test('exposes only relay-backed browser and thread-scoped schedule tools in a headless sidecar', () => {
    if (process.versions.electron || process.env.INTERPRETER_ENABLE_HEADLESS_BROWSER_TOOLS === '1') return;
    const server = getBuiltinServers().find((entry) => entry.id === 'builtin-interpreter');
    expect(server).toBeDefined();
    expect(server!.tools.map((tool) => tool.name).sort()).toEqual([
      'interpreter_whole_computer_state_get',
      'interpreter_wake_schedule',
      'interpreter_browser_tab_activate',
      'interpreter_browser_page_inspect',
      'interpreter_browser_page_trace',
      'interpreter_browser_page_click',
      'interpreter_browser_page_type',
      'interpreter_browser_page_select',
      'interpreter_browser_page_scroll',
    ].sort());
    expect(server!.tools.some((tool) => tool.name === 'interpreter_layout_set')).toBe(false);
  });

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
