import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

function createRuntimeServer(name: string, overrides: Record<string, any> = {}) {
  return {
    name,
    tools: {
      do_thing: { name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object' } },
    },
    resources: [],
    resourceTemplates: [],
    authStatus: 'oAuth' as const,
    ...overrides,
  };
}

const runtimeServers = new Map<string, any>();

function resetRuntimeServers() {
  runtimeServers.clear();
  runtimeServers.set('test-mcp', createRuntimeServer('test-mcp'));
}

const mockCreateServer = mock(async (entry: any) => {
  runtimeServers.set(entry.name, createRuntimeServer(entry.name, {
    tools: {},
    authStatus: 'oAuth' as const,
  }));
});
const mockDeleteServer = mock(async (name: string) => {
  runtimeServers.delete(name);
});
const mockUpdateServer = mock(async (entry: any) => {
  const current = runtimeServers.get(entry.name) ?? createRuntimeServer(entry.name, { tools: {} });
  runtimeServers.set(entry.name, { ...current, name: entry.name });
});
const mockEnableServer = mock(async (name: string) => {
  const current = runtimeServers.get(name);
  if (current) {
    runtimeServers.set(name, { ...current });
  }
});
const mockDisableServer = mock(async (name: string) => {
  const current = runtimeServers.get(name);
  if (current) {
    runtimeServers.set(name, { ...current });
  }
});
const mockCallTool = mock(async () => ({
  content: [{ type: 'text', text: 'runtime tool result' }],
  isError: false,
}));
const mockListServers = mock(async () => ({
  data: Array.from(runtimeServers.values()),
  nextCursor: null,
}));
const mockGetServerStatus = mock(async (name: string) => runtimeServers.get(name) ?? null);
const mockListServersForDisplay = mock(async () => ({
  data: Array.from(runtimeServers.values()),
  nextCursor: null,
}));
const mockGetDisplayServerStatus = mock(async (name: string) => runtimeServers.get(name) ?? null);
const mockListAuthStatusesViaCli = mock(async () => new Map<string, any>());
const mockInitiateOAuthLogin = mock(async () => ({ authorizationUrl: 'https://auth.example.com/login' }));
const mockReloadServers = mock(async () => {});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function waitForApproval() {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const [approval] = approvalManager.getApprovals();
    if (approval) {
      return approval;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for approval');
}

function inlineToToolConnectionState(server: any) {
  const toolsObj = server.tools ?? {};
  const toolsArray = Object.values(toolsObj)
    .filter((t: any) => t != null)
    .map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const resources = (server.resources ?? []).map((r: any) => ({
    uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
  }));
  if (server.authStatus === 'notLoggedIn') {
    return { status: 'failed' as const, error: 'OAuth login required', needsAuth: true };
  }
  return { status: 'connected' as const, tools: toolsArray, resources, prompts: [] };
}

mock.module('../utils/mcpServiceBridge', () => ({
  getMcpService: () => ({
    createServer: mockCreateServer,
    deleteServer: mockDeleteServer,
    updateServer: mockUpdateServer,
    enableServer: mockEnableServer,
    disableServer: mockDisableServer,
    callTool: mockCallTool,
    listServers: mockListServers,
    getServerStatus: mockGetServerStatus,
    listServersForDisplay: mockListServersForDisplay,
    getDisplayServerStatus: mockGetDisplayServerStatus,
    listAuthStatusesViaCli: mockListAuthStatusesViaCli,
    initiateOAuthLogin: mockInitiateOAuthLogin,
    reloadServers: mockReloadServers,
  }),
  McpService: {
    toToolServerStatus: (s: any) => ({ id: s.name, name: s.name, state: inlineToToolConnectionState(s) }),
    toToolConnectionState: inlineToToolConnectionState,
  },
}));

import { addMcpServerTool } from './builtin-tools/mcp-management/addMcpServerTool';
import { removeMcpServerTool } from './builtin-tools/mcp-management/removeMcpServerTool';
import { refreshMcpToolsTool } from './builtin-tools/mcp-management/refreshMcpToolsTool';
import { toggleMcpServerTool } from './builtin-tools/mcp-management/toggleMcpServerTool';
import { updateMcpServerTool } from './builtin-tools/mcp-management/updateMcpServerTool';
import { approvalManager } from '../approvalManager';
import { clearConfigCache, getMcpServer, setConfigOverride } from '../configStore';
import { rememberToolCallMetadata } from '../utils/codexMcpBridge';
import { getLatestToolServersChangedEvent } from '../utils/ipcBridge';
import { runWithWindowSessionOverride } from '../utils/windowSessions';
import { runWithWorkspaceOverride } from '../utils/workspace';
import { ToolManager } from './toolManager';
import { setToolManager } from './toolManagerAccessor';

describe('ToolManager MCP integration', () => {
  beforeEach(() => {
    approvalManager.setAutoApprove(false);
    approvalManager.clearAll();
    clearConfigCache();
    setConfigOverride({ agents: {}, mcpServers: {} } as any);
    setToolManager(new ToolManager());
    resetRuntimeServers();
    mockCreateServer.mockClear();
    mockDeleteServer.mockClear();
    mockUpdateServer.mockClear();
    mockEnableServer.mockClear();
    mockDisableServer.mockClear();
    mockCallTool.mockClear();
    mockListServers.mockClear();
    mockGetServerStatus.mockClear();
    mockListServersForDisplay.mockClear();
    mockGetDisplayServerStatus.mockClear();
    mockListServersForDisplay.mockImplementation(async () => ({
      data: Array.from(runtimeServers.values()),
      nextCursor: null,
    }));
    mockGetDisplayServerStatus.mockImplementation(async (name: string) => runtimeServers.get(name) ?? null);
    mockListAuthStatusesViaCli.mockClear();
    mockListAuthStatusesViaCli.mockImplementation(async () => new Map());
    mockInitiateOAuthLogin.mockClear();
  });

  afterEach(() => {
    approvalManager.clearAll();
    setConfigOverride(null);
    clearConfigCache();
  });

  test('addServer calls McpService.createServer with correct entry', async () => {
    const manager = new ToolManager();
    const id = await manager.addServer({
      name: 'My Server',
      transport: 'streamable_http',
      url: 'https://mcp.example.com',
      enabled: true,
    });

    expect(id).toBe('my-server');
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    const entry = mockCreateServer.mock.calls[0][0];
    expect(entry.name).toBe('my-server');
    expect(entry.config.transport).toBe('streamable_http');
    expect(entry.config.url).toBe('https://mcp.example.com');
    expect(entry.config.defaultToolsApprovalMode).toBe('prompt');
  });

  test('addServer does not block on runtime status reads', async () => {
    const manager = new ToolManager();

    await manager.addServer({
      name: 'Fast Add',
      transport: 'streamable_http',
      url: 'https://mcp.example.com',
      enabled: true,
    });

    expect(mockGetServerStatus).not.toHaveBeenCalled();
    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('addServer broadcasts connecting state while waiting for runtime status', async () => {
    const manager = new ToolManager();

    await manager.addServer({
      name: 'Pending Good',
      transport: 'streamable_http',
      url: 'https://mcp.example.com',
      enabled: true,
    });

    const snapshot = getLatestToolServersChangedEvent();
    const status = snapshot?.servers.find((entry) => entry.id === 'pending-good');

    expect(status).toBeDefined();
    expect(status?.state.status).toBe('connecting');
    expect(mockListServersForDisplay).not.toHaveBeenCalled();
  });

  test('addServer generates slug ID from name', async () => {
    const manager = new ToolManager();
    const id = await manager.addServer({
      name: 'GitHub Copilot MCP',
      transport: 'streamable_http',
      url: 'https://api.githubcopilot.com/mcp/',
    });

    expect(id).toBe('github-copilot-mcp');
  });

  test('addServer repairs a persisted server when runtime state is missing', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'github-copilot-mcp': {
          id: 'github-copilot-mcp',
          name: 'Existing GitHub Copilot MCP',
          transport: 'http',
          url: 'https://existing.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();

    const id = await manager.addServer({
      name: 'GitHub Copilot MCP',
      transport: 'streamable_http',
      url: 'https://new.example.com/mcp',
    });

    expect(id).toBe('github-copilot-mcp');
    expect(mockGetServerStatus).toHaveBeenCalledWith('github-copilot-mcp');
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(runtimeServers.has('github-copilot-mcp')).toBe(true);
  });

  test('addServer rejects duplicates when persisted and runtime server already exist', async () => {
    runtimeServers.set('github-copilot-mcp', createRuntimeServer('github-copilot-mcp'));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'github-copilot-mcp': {
          id: 'github-copilot-mcp',
          name: 'Existing GitHub Copilot MCP',
          transport: 'http',
          url: 'https://existing.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();

    await expect(manager.addServer({
      name: 'GitHub Copilot MCP',
      transport: 'streamable_http',
      url: 'https://new.example.com/mcp',
    })).rejects.toThrow(/already exists/i);

    expect(mockGetServerStatus).toHaveBeenCalledWith('github-copilot-mcp');
    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  test('addServer with stdio transport passes command and args', async () => {
    const manager = new ToolManager();
    await manager.addServer({
      name: 'local-tool',
      transport: 'stdio',
      command: '/usr/bin/my-mcp',
      args: ['--port', '3000'],
      env: { API_KEY: 'secret' },
      startupTimeoutSec: 90,
      toolTimeoutSec: 180,
    });

    const entry = mockCreateServer.mock.calls[0][0];
    expect(entry.config.transport).toBe('stdio');
    expect(entry.config.command).toBe('/usr/bin/my-mcp');
    expect(entry.config.args).toEqual(['--port', '3000']);
    expect(entry.config.env).toEqual({ API_KEY: 'secret' });
    expect(entry.config.startupTimeoutSec).toBe(90);
    expect(entry.config.toolTimeoutSec).toBe(180);
    expect(entry.config.defaultToolsApprovalMode).toBe('prompt');
  });

  test('addServer rejects command on non-stdio transport', async () => {
    const manager = new ToolManager();

    await expect(manager.addServer({
      name: 'bad-remote',
      transport: 'streamable_http',
      url: 'https://remote.example.com/mcp',
      command: '/bin/sh',
    })).rejects.toThrow('command is only valid for stdio transport');

    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  test('removeServer calls McpService.deleteServer', async () => {
    const manager = new ToolManager();
    await manager.removeServer('test-mcp');

    expect(mockDeleteServer).toHaveBeenCalledTimes(1);
    expect(mockDeleteServer).toHaveBeenCalledWith('test-mcp');
  });

  test('removeServer does not block on runtime status reads', async () => {
    const manager = new ToolManager();

    await manager.removeServer('test-mcp');

    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('updateServer calls McpService.updateServer with merged entry', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': { id: 'test-mcp', name: 'test-mcp', transport: 'http', url: 'https://old-url.example.com', enabled: true, createdAt: 1 },
      },
    } as any);
    const manager = new ToolManager();
    await manager.updateServer('test-mcp', { url: 'https://new-url.example.com' });

    expect(mockUpdateServer).toHaveBeenCalledTimes(1);
    const entry = mockUpdateServer.mock.calls[0][0];
    expect(entry.name).toBe('test-mcp');
    expect(entry.config.url).toBe('https://new-url.example.com');
    expect(entry.config.defaultToolsApprovalMode).toBe('prompt');
  });

  test('updateServer uses persisted config as the source of truth', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': { id: 'test-mcp', name: 'test-mcp', transport: 'http', url: 'https://old-url.example.com', enabled: true, createdAt: 1 },
      },
    } as any);

    const manager = new ToolManager();
    await manager.updateServer('test-mcp', { url: 'https://new-url.example.com' });

    expect(mockGetServerStatus).not.toHaveBeenCalled();
    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('updateServer rejects command when transport remains remote', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': { id: 'test-mcp', name: 'test-mcp', transport: 'http', url: 'https://old-url.example.com', enabled: true, createdAt: 1 },
      },
    } as any);

    const manager = new ToolManager();

    await expect(manager.updateServer('test-mcp', { command: '/bin/sh' }))
      .rejects.toThrow('command is only valid for stdio transport');

    expect(mockUpdateServer).not.toHaveBeenCalled();
  });

  test('updateServer throws when server not found', async () => {
    const manager = new ToolManager();
    await expect(manager.updateServer('nonexistent', { url: 'x' }))
      .rejects.toThrow('Server nonexistent not found');
  });

  test('startServer calls McpService.enableServer', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: false,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    await manager.startServer('test-mcp');

    expect(mockEnableServer).toHaveBeenCalledTimes(1);
    expect(mockEnableServer).toHaveBeenCalledWith('test-mcp');
  });

  test('startServer does not block on runtime status reads', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: false,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    await manager.startServer('test-mcp');

    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('startOAuthLogin calls McpService.initiateOAuthLogin for configured MCP servers', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const result = await manager.startOAuthLogin('test-mcp');

    expect(result.authorizationUrl).toBe('https://auth.example.com/login');
    expect(mockInitiateOAuthLogin).toHaveBeenCalledTimes(1);
    expect(mockInitiateOAuthLogin).toHaveBeenCalledWith('test-mcp', undefined);
  });

  test('startOAuthLogin does not read runtime status when config exists', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    await manager.startOAuthLogin('test-mcp');

    expect(mockGetServerStatus).not.toHaveBeenCalled();
  });

  test('initialize does not eagerly query Codex MCP runtime status', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    await manager.initialize();

    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('stopServer calls McpService.disableServer', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    await manager.stopServer('test-mcp');

    expect(mockDisableServer).toHaveBeenCalledTimes(1);
    expect(mockDisableServer).toHaveBeenCalledWith('test-mcp');
  });

  test('stopServer does not block on runtime status reads', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    await manager.stopServer('test-mcp');

    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('restartServer disables then enables', async () => {
    const manager = new ToolManager();
    await manager.restartServer('test-mcp');

    expect(mockDisableServer).toHaveBeenCalledTimes(1);
    expect(mockEnableServer).toHaveBeenCalledTimes(1);
  });

  test('restartServer does not block on runtime status reads', async () => {
    const manager = new ToolManager();
    await manager.restartServer('test-mcp');

    expect(mockListServers).not.toHaveBeenCalled();
  });

  test('listAllToolServers includes MCP servers from Codex runtime', async () => {
    const manager = new ToolManager();
    const servers = await manager.listAllToolServers();

    expect(mockListServers).toHaveBeenCalled();
    const mcpServer = servers.find(s => s.id === 'test-mcp');
    expect(mcpServer).toBeDefined();
    expect(mcpServer!.name).toBe('test-mcp');
    expect(mcpServer!.state.status).toBe('connected');
  });

  test('listAllToolServers maps MCP server tools correctly', async () => {
    const manager = new ToolManager();
    const servers = await manager.listAllToolServers();

    const mcpServer = servers.find(s => s.id === 'test-mcp');
    expect(mcpServer!.state.status).toBe('connected');
    if (mcpServer!.state.status === 'connected') {
      expect(mcpServer!.state.tools).toHaveLength(1);
      expect(mcpServer!.state.tools[0].name).toBe('do_thing');
      expect(mcpServer!.state.tools[0].description).toBe('Does a thing');
    }
  });

  test('listAllToolServers preserves persisted MCP config for UI metadata', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'PubMed',
          description: 'Search biomedical literature',
          transport: 'http',
          url: 'https://pubmed.mcp.claude.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listAllToolServers();
    const mcpServer = servers.find(s => s.id === 'test-mcp');

    expect(mcpServer).toBeDefined();
    expect(mcpServer!.description).toBe('Search biomedical literature');
    expect(mcpServer!.config).toEqual({
      id: 'test-mcp',
      name: 'PubMed',
      description: 'Search biomedical literature',
      transport: 'http',
      url: 'https://pubmed.mcp.claude.com/mcp',
      enabled: true,
      createdAt: 1,
    });
  });

  test('getToolServer returns MCP server status via McpService', async () => {
    const manager = new ToolManager();
    const status = await manager.getToolServer('test-mcp');

    expect(mockGetServerStatus).toHaveBeenCalledWith('test-mcp');
    expect(status).toBeDefined();
    expect(status!.id).toBe('test-mcp');
    expect(status!.state.status).toBe('connected');
  });

  test('getToolServer preserves persisted MCP config', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Supabase',
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const status = await manager.getToolServer('test-mcp');

    expect(status).toBeDefined();
    expect(status!.config).toEqual({
      id: 'test-mcp',
      name: 'Supabase',
      transport: 'http',
      url: 'https://mcp.supabase.com/mcp',
      enabled: true,
      createdAt: 1,
    });
  });

  test('getDisplayToolServer maps notLoggedIn auth to needsAuth', async () => {
    runtimeServers.set('test-mcp', createRuntimeServer('test-mcp', {
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'notLoggedIn' as const,
    }));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Supabase',
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const status = await manager.getDisplayToolServer('test-mcp');

    expect(status).toBeDefined();
    expect(status!.state.status).toBe('failed');
    if (status!.state.status === 'failed') {
      expect(status!.state.error).toBe('OAuth login required');
      expect(status!.state.needsAuth).toBe(true);
    }
  });

  test('listDisplayToolServers preserves persisted MCP config for auth-required servers', async () => {
    runtimeServers.set('test-mcp', createRuntimeServer('test-mcp', {
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'notLoggedIn' as const,
    }));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Supabase',
          description: 'Database tools',
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listDisplayToolServers();
    const status = servers.find((entry) => entry.id === 'test-mcp');

    expect(status).toBeDefined();
    expect(status?.name).toBe('Supabase');
    expect(status?.description).toBe('Database tools');
    expect(status?.config?.url).toBe('https://mcp.supabase.com/mcp');
    expect(status?.state.status).toBe('failed');
    if (status?.state.status === 'failed') {
      expect(status.state.error).toBe('OAuth login required');
      expect(status.state.needsAuth).toBe(true);
    }
  });

  test('listDisplayToolServers uses CLI auth status without runtime display reads for OAuth-required servers', async () => {
    mockListServersForDisplay.mockImplementation(async () => {
      throw new Error('runtime display status path should not be used');
    });
    mockListAuthStatusesViaCli.mockImplementation(async () => new Map([
      ['test-mcp', 'notLoggedIn'],
    ]));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Supabase',
          description: 'Database tools',
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listDisplayToolServers();
    const status = servers.find((entry) => entry.id === 'test-mcp');

    expect(status).toBeDefined();
    expect(status?.state.status).toBe('failed');
    if (status?.state.status === 'failed') {
      expect(status.state.error).toBe('OAuth login required');
      expect(status.state.needsAuth).toBe(true);
    }
    expect(mockListAuthStatusesViaCli).toHaveBeenCalledTimes(1);
    expect(mockListServersForDisplay).not.toHaveBeenCalled();
  });

  test('getDisplayToolServer uses CLI auth status without runtime display reads for OAuth-required servers', async () => {
    mockGetDisplayServerStatus.mockImplementation(async () => {
      throw new Error('runtime display status path should not be used');
    });
    mockListAuthStatusesViaCli.mockImplementation(async () => new Map([
      ['test-mcp', 'notLoggedIn'],
    ]));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Ramp',
          description: 'Corporate spend',
          transport: 'http',
          url: 'https://ramp.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const status = await manager.getDisplayToolServer('test-mcp');

    expect(status).toBeDefined();
    expect(status?.state.status).toBe('failed');
    if (status?.state.status === 'failed') {
      expect(status.state.error).toBe('OAuth login required');
      expect(status.state.needsAuth).toBe(true);
    }
    expect(mockListAuthStatusesViaCli).toHaveBeenCalledTimes(1);
    expect(mockGetDisplayServerStatus).not.toHaveBeenCalled();
  });

  test('listToolServerSnapshot uses CLI auth status for OAuth-required servers', async () => {
    mockListAuthStatusesViaCli.mockImplementation(async () => new Map([
      ['test-mcp', 'notLoggedIn'],
    ]));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Supabase',
          description: 'Database tools',
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listToolServerSnapshot();
    const status = servers.find((entry) => entry.id === 'test-mcp');

    expect(status).toBeDefined();
    expect(status?.state.status).toBe('failed');
    if (status?.state.status === 'failed') {
      expect(status.state.error).toBe('OAuth login required');
      expect(status.state.needsAuth).toBe(true);
    }
    expect(mockListAuthStatusesViaCli).toHaveBeenCalledTimes(1);
    expect(mockListServers).not.toHaveBeenCalled();
    expect(mockListServersForDisplay).not.toHaveBeenCalled();
  });

  test('addServer broadcasts auth-required snapshot immediately for OAuth-required servers', async () => {
    mockListAuthStatusesViaCli.mockImplementation(async () => new Map([
      ['ramp', 'notLoggedIn'],
    ]));

    const manager = new ToolManager();
    await manager.addServer({
      name: 'Ramp',
      transport: 'streamable_http',
      url: 'https://ramp.example.com/mcp',
      enabled: true,
    });

    const snapshot = getLatestToolServersChangedEvent();
    const status = snapshot?.servers.find((entry) => entry.id === 'ramp');

    expect(status).toBeDefined();
    expect(status?.state.status).toBe('failed');
    if (status?.state.status === 'failed') {
      expect(status.state.error).toBe('OAuth login required');
      expect(status.state.needsAuth).toBe(true);
    }
    expect(mockListAuthStatusesViaCli).toHaveBeenCalledTimes(1);
    expect(mockListServers).not.toHaveBeenCalled();
    expect(mockListServersForDisplay).not.toHaveBeenCalled();
  });

  test('addServer follow-up broadcast keeps connected runtime status', async () => {
    const manager = new ToolManager();
    await manager.addServer({
      name: 'Realtime Good',
      transport: 'streamable_http',
      url: 'https://mcp.example.com',
      enabled: true,
    });

    await waitFor(() => {
      const snapshot = getLatestToolServersChangedEvent();
      const status = snapshot?.servers.find((entry) => entry.id === 'realtime-good');
      return status?.state.status === 'connected';
    });

    const snapshot = getLatestToolServersChangedEvent();
    const status = snapshot?.servers.find((entry) => entry.id === 'realtime-good');

    expect(status).toBeDefined();
    expect(status?.state.status).toBe('connected');
    expect(mockListServersForDisplay).not.toHaveBeenCalled();
  });

  test('getToolServer returns undefined for unknown MCP server', async () => {
    const manager = new ToolManager();
    const status = await manager.getToolServer('nonexistent');

    expect(status).toBeUndefined();
  });

  test('callTool routes MCP server IDs through Codex runtime when tool call metadata provides a thread', async () => {
    const manager = new ToolManager();
    approvalManager.setAutoApprove(true);
    rememberToolCallMetadata('item_mcp_1', { threadId: 'thr-mcp-1' });

    const result = await manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 42 },
      undefined,
      undefined,
      undefined,
      'item_mcp_1',
    );

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith(
      'thr-mcp-1',
      'test-mcp',
      'do_thing',
      { answer: 42 },
      { model: undefined, cwd: undefined },
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'runtime tool result' }],
      isError: false,
    });
  });

  test('callTool routes MCP server IDs through Codex runtime when toolContext provides a thread', async () => {
    const manager = new ToolManager();
    approvalManager.setAutoApprove(true);

    const result = await manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 7 },
      undefined,
      undefined,
      {
        threadId: 'thr-mcp-context-1',
        workspace: '/workspace/current',
        modelConfig: { modelId: 'interpreter-smart' } as any,
      },
    );

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith(
      'thr-mcp-context-1',
      'test-mcp',
      'do_thing',
      { answer: 7 },
      { model: 'interpreter-smart', cwd: '/workspace/current' },
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'runtime tool result' }],
      isError: false,
    });
  });

  test('callTool rejects MCP server IDs when no thread context is available', async () => {
    const manager = new ToolManager();

    await expect(manager.callTool('test-mcp', 'do_thing', {}))
      .rejects.toThrow('MCP tool calls require a Codex thread context');
  });

  test('callTool gates MCP runtime calls through approval manager at the shared CLI and chat convergence point', async () => {
    const manager = new ToolManager();
    rememberToolCallMetadata('item_mcp_approval_1', { threadId: 'thr-mcp-approval-1' });

    const callPromise = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 42 },
      undefined,
      'agent-mcp-approval',
      undefined,
      'item_mcp_approval_1',
    );

    const approval = await waitForApproval();
    expect(approval.serverId).toBe('test-mcp');
    expect(approval.toolName).toBe('test-mcp__do_thing');
    expect(approval.toolCallId).toBe('item_mcp_approval_1');
    expect(approval.agentId).toBe('agent-mcp-approval');
    expect(approval.context).toMatchObject({
      serverId: 'test-mcp',
      toolName: 'do_thing',
      args: { answer: 42 },
      threadId: 'thr-mcp-approval-1',
    });
    expect(mockCallTool).not.toHaveBeenCalled();

    const response = approvalManager.respond(approval.id, {
      answers: { '0': 'approve' },
      approvalMode: 'once',
    });
    expect(response).toEqual({ success: true });

    const result = await callPromise;

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'runtime tool result' }],
      isError: false,
    });
  });

  test('callTool honors MCP auto approval mode without prompting', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'test-mcp',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
          defaultToolsApprovalMode: 'auto',
        },
      },
    } as any);
    const manager = new ToolManager();

    const result = await manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 42 },
      undefined,
      'agent-mcp-auto',
      { threadId: 'thr-mcp-auto-1' },
    );

    expect(approvalManager.getApprovals()).toEqual([]);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'runtime tool result' }],
      isError: false,
    });
  });

  test('callTool honors per-tool MCP approval overrides', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'test-mcp',
          transport: 'http',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: 1,
          defaultToolsApprovalMode: 'auto',
          tools: {
            do_thing: { approvalMode: 'prompt' },
          },
        },
      },
    } as any);
    const manager = new ToolManager();

    const callPromise = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 42 },
      undefined,
      'agent-mcp-tool-override',
      { threadId: 'thr-mcp-tool-override-1' },
    );

    const approval = await waitForApproval();
    expect(approval.serverId).toBe('test-mcp');
    expect(approval.toolName).toBe('test-mcp__do_thing');
    expect(approval.context).toMatchObject({
      approvalMode: 'prompt',
      serverId: 'test-mcp',
      toolName: 'do_thing',
    });
    expect(mockCallTool).not.toHaveBeenCalled();

    approvalManager.respond(approval.id, {
      answers: { '0': 'approve' },
      approvalMode: 'once',
    });

    const result = await callPromise;
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'runtime tool result' }],
      isError: false,
    });
  });

  test('callTool creates MCP approvals owned by the current window/workspace scope', async () => {
    const manager = new ToolManager();

    const callPromise = runWithWindowSessionOverride('window-mcp-owner', async () => (
      runWithWorkspaceOverride('/workspace/owner', async () => manager.callTool(
        'test-mcp',
        'do_thing',
        { answer: 42 },
        undefined,
        'agent-mcp-owner',
        {
          threadId: 'thr-mcp-owner-1',
          workspace: '/workspace/owner',
        },
        'item_mcp_owner_1',
      ))
    ));

    await waitFor(() => approvalManager.getApprovals().length === 1);

    const visibleToWrongWindow = await runWithWindowSessionOverride(
      'window-mcp-other',
      async () => approvalManager.getApprovals(),
    );
    expect(visibleToWrongWindow).toEqual([]);

    const visibleToOwnerWindow = await runWithWindowSessionOverride(
      'window-mcp-owner',
      async () => approvalManager.getApprovals(),
    );
    expect(visibleToOwnerWindow).toHaveLength(1);
    expect(visibleToOwnerWindow[0]).toMatchObject({
      agentId: 'agent-mcp-owner',
      toolCallId: 'item_mcp_owner_1',
      context: {
        serverId: 'test-mcp',
        toolName: 'do_thing',
        args: { answer: 42 },
        threadId: 'thr-mcp-owner-1',
      },
    });

    approvalManager.respond(visibleToOwnerWindow[0]!.id, {
      answers: { '0': 'approve' },
      approvalMode: 'once',
    });

    await callPromise;
    expect(mockCallTool).toHaveBeenCalledWith(
      'thr-mcp-owner-1',
      'test-mcp',
      'do_thing',
      { answer: 42 },
      { model: undefined, cwd: '/workspace/owner' },
    );
  });

  test('callTool reports MCP approval waits to CLI callers before blocking', async () => {
    const manager = new ToolManager();
    const progress: string[] = [];

    const callPromise = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 42 },
      undefined,
      'agent-mcp-progress',
      {
        threadId: 'thr-mcp-progress-1',
        progressReporter: (text) => {
          progress.push(text);
        },
      },
    );

    const approval = await waitForApproval();
    expect(progress).toEqual([
      'Waiting for user approval to call MCP tool test-mcp__do_thing. Do not retry; this command will continue after approval.',
    ]);
    expect(mockCallTool).not.toHaveBeenCalled();

    approvalManager.respond(approval.id, {
      answers: { '0': 'approve' },
      approvalMode: 'once',
    });

    await callPromise;
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  test('callTool returns a denial result without calling MCP runtime when MCP approval is denied', async () => {
    const manager = new ToolManager();

    const callPromise = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 99 },
      undefined,
      'agent-mcp-denial',
      {
        threadId: 'thr-mcp-denial-1',
      },
    );

    const approval = await waitForApproval();
    expect(approval.serverId).toBe('test-mcp');
    expect(approval.toolName).toBe('test-mcp__do_thing');
    expect(mockCallTool).not.toHaveBeenCalled();

    const response = approvalManager.respond(approval.id, {
      answers: { '0': 'deny' },
    });
    expect(response).toEqual({ success: true });

    const result = await callPromise;

    expect(mockCallTool).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: 'text', text: 'MCP tool call denied by user: test-mcp__do_thing' }],
      isError: false,
    });
  });

  test('callTool reuses MCP session approval for the same agent and tool', async () => {
    const manager = new ToolManager();
    const progress: string[] = [];

    const firstCall = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 1 },
      undefined,
      'agent-mcp-session',
      { threadId: 'thr-mcp-session-1' },
    );

    const approval = await waitForApproval();
    expect(approval.agentId).toBe('agent-mcp-session');
    expect(approval.toolName).toBe('test-mcp__do_thing');

    const response = approvalManager.respond(approval.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });
    expect(response).toEqual({ success: true });
    await firstCall;

    const secondResult = await manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 2 },
      undefined,
      'agent-mcp-session',
      {
        threadId: 'thr-mcp-session-2',
        progressReporter: (text) => {
          progress.push(text);
        },
      },
    );

    expect(approvalManager.getApprovals()).toEqual([]);
    expect(progress).toEqual([]);
    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(secondResult).toEqual({
      content: [{ type: 'text', text: 'runtime tool result' }],
      isError: false,
    });
  });

  test('callTool keeps MCP session approval scoped to the approving agent', async () => {
    const manager = new ToolManager();

    const firstCall = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 1 },
      undefined,
      'agent-mcp-owner',
      { threadId: 'thr-mcp-owner-1' },
    );

    const firstApproval = await waitForApproval();
    expect(firstApproval.agentId).toBe('agent-mcp-owner');
    approvalManager.respond(firstApproval.id, {
      answers: { '0': 'approve' },
      approvalMode: 'session',
    });
    await firstCall;

    const secondCall = manager.callTool(
      'test-mcp',
      'do_thing',
      { answer: 2 },
      undefined,
      'agent-mcp-other',
      { threadId: 'thr-mcp-other-1' },
    );

    const secondApproval = await waitForApproval();
    expect(secondApproval.agentId).toBe('agent-mcp-other');
    expect(secondApproval.toolName).toBe('test-mcp__do_thing');
    expect(mockCallTool).toHaveBeenCalledTimes(1);

    approvalManager.respond(secondApproval.id, {
      answers: { '0': 'approve' },
      approvalMode: 'once',
    });
    await secondCall;

    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });

  test('getEnabledToolsForAgent includes MCP server tools', async () => {
    const manager = new ToolManager();
    const tools = await manager.getEnabledToolsForAgent();

    const mcpTools = tools.filter(t => t.serverId === 'test-mcp');
    expect(mcpTools).toHaveLength(1);
    expect(mcpTools[0].name).toBe('do_thing');
    expect(mcpTools[0].isBuiltin).toBe(false);
  });

  test('listAllToolServers marks globally disabled MCP servers', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {},
      builtinToolsEnabled: { 'test-mcp': false },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listAllToolServers();
    const mcpServer = servers.find(s => s.id === 'test-mcp');

    expect(mcpServer).toBeDefined();
    expect(mcpServer!.globallyDisabled).toBe(true);
    expect(mcpServer!.state.status).toBe('disconnected');
  });

  test('McpService.toToolServerStatus maps notLoggedIn auth to needsAuth', async () => {
    mockListServers.mockImplementationOnce(async () => ({
      data: [{
        name: 'needs-auth-server',
        tools: {},
        resources: [],
        resourceTemplates: [],
        authStatus: 'notLoggedIn' as const,
      }],
      nextCursor: null,
    }));

    const manager = new ToolManager();
    const servers = await manager.listAllToolServers();
    const server = servers.find(s => s.id === 'needs-auth-server');

    expect(server).toBeDefined();
    expect(server!.state.status).toBe('failed');
    if (server!.state.status === 'failed') {
      expect(server!.state.needsAuth).toBe(true);
    }
  });

  test('listAllToolServers keeps persisted auth-required failure when runtime omits the server', async () => {
    runtimeServers.delete('test-mcp');
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Sentry',
          transport: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          enabled: true,
          createdAt: 1,
          lastConnectionFailure: {
            error: 'OAuth login required',
            needsAuth: true,
            updatedAt: 2,
          },
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listAllToolServers();
    const server = servers.find((entry) => entry.id === 'test-mcp');

    expect(server).toBeDefined();
    expect(server!.state.status).toBe('failed');
    if (server!.state.status === 'failed') {
      expect(server!.state.error).toBe('OAuth login required');
      expect(server!.state.needsAuth).toBe(true);
    }
  });

  test('listDisplayToolServers keeps persisted startup failure when runtime returns an empty MCP snapshot', async () => {
    runtimeServers.set('test-mcp', createRuntimeServer('test-mcp', {
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported' as const,
    }));
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Supabase',
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
          createdAt: 1,
          lastConnectionFailure: {
            error: 'No access token was provided in this request',
            updatedAt: 2,
          },
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listDisplayToolServers();
    const server = servers.find((entry) => entry.id === 'test-mcp');

    expect(server).toBeDefined();
    expect(server!.state.status).toBe('failed');
    if (server!.state.status === 'failed') {
      expect(server!.state.error).toBe('No access token was provided in this request');
      expect(server!.state.needsAuth).toBeUndefined();
    }
  });

  test('listAllToolServers keeps using runtime statuses rather than display auth statuses', async () => {
    mockListServersForDisplay.mockImplementation(async () => {
      throw new Error('display status path should not be used');
    });
    try {
      const manager = new ToolManager();
      const servers = await manager.listAllToolServers();
      const status = servers.find((entry) => entry.id === 'test-mcp');

      expect(status).toBeDefined();
      expect(mockListServers).toHaveBeenCalledTimes(1);
      expect(mockListServersForDisplay).not.toHaveBeenCalled();
    } finally {
      mockListServersForDisplay.mockImplementation(async () => ({
        data: Array.from(runtimeServers.values()),
        nextCursor: null,
      }));
    }
  });

  test('listDisplayToolServers returns usable statuses when listAuthStatusesViaCli throws', async () => {
    mockListAuthStatusesViaCli.mockImplementation(async () => {
      throw new Error('interpreter mcp list --json timed out');
    });
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'GitHub',
          description: 'Search code and issues',
          transport: 'http',
          url: 'https://mcp.github.com',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const servers = await manager.listDisplayToolServers();
    const server = servers.find((entry) => entry.id === 'test-mcp');

    expect(server).toBeDefined();
    expect(server!.name).toBe('GitHub');
    expect(mockListAuthStatusesViaCli).toHaveBeenCalledTimes(1);
    expect(mockListServersForDisplay).toHaveBeenCalledTimes(1);
    expect(mockListServersForDisplay.mock.calls[0][0]).toBeInstanceOf(Map);
    expect(mockListServersForDisplay.mock.calls[0][0].size).toBe(0);
  });

  test('listDisplayToolServers reuses preloaded CLI auth statuses for display refresh', async () => {
    const cliAuthStatuses = new Map<string, any>([['test-mcp', 'oAuth']]);
    mockListAuthStatusesViaCli.mockImplementation(async () => cliAuthStatuses);

    const manager = new ToolManager();
    const servers = await manager.listDisplayToolServers();
    const server = servers.find((entry) => entry.id === 'test-mcp');

    expect(server).toBeDefined();
    expect(mockListAuthStatusesViaCli).toHaveBeenCalledTimes(1);
    expect(mockListServersForDisplay).toHaveBeenCalledTimes(1);
    expect(mockListServersForDisplay.mock.calls[0][0]).toBe(cliAuthStatuses);
  });

  test('listToolServerSnapshot returns persisted configs when listAuthStatusesViaCli throws', async () => {
    mockListAuthStatusesViaCli.mockImplementation(async () => {
      throw new Error('interpreter mcp list --json timed out');
    });
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'GitHub',
          description: 'Search code and issues',
          transport: 'http',
          url: 'https://mcp.github.com',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const manager = new ToolManager();
    const snapshot = await manager.listToolServerSnapshot();
    const server = snapshot.find((entry) => entry.id === 'test-mcp');

    expect(server).toBeDefined();
    expect(server!.name).toBe('GitHub');
  });

  test('mcp_add_server persists config through the shared path', async () => {
    const result = await addMcpServerTool.handler({
      name: 'PubMed',
      transport: 'http',
      url: 'https://pubmed.example.com/mcp',
      oauthResource: 'https://pubmed.example.com/.well-known/oauth-protected-resource/mcp',
    });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text as string);
    expect(payload.mcpRefresh).toMatchObject({
      currentTurnToolsAvailable: true,
      nextTurnRequired: false,
      refreshTool: 'mcp_refresh_tools',
    });
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    const entry = mockCreateServer.mock.calls.at(-1)?.[0];
    expect(entry.config.oauthResource).toBe(
      'https://pubmed.example.com/.well-known/oauth-protected-resource/mcp',
    );

    const persisted = await getMcpServer('pubmed');
    expect(persisted).toMatchObject({
      id: 'pubmed',
      name: 'PubMed',
      transport: 'http',
      url: 'https://pubmed.example.com/mcp',
      oauthResource: 'https://pubmed.example.com/.well-known/oauth-protected-resource/mcp',
      enabled: true,
    });
    expect(typeof persisted?.createdAt).toBe('number');
  });

  test('mcp_add_server does not block local stdio installs on runtime status', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {},
      allowLocalMcpServers: true,
    } as any);
    mockGetDisplayServerStatus.mockClear();

    const result = await addMcpServerTool.handler({
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text as string);
    expect(payload.status).toBe('configured');
    expect(payload.message).toContain('Call mcp_refresh_tools');
    const entry = mockCreateServer.mock.calls[0][0];
    expect(entry.config.startupTimeoutSec).toBe(120);
    expect(mockGetDisplayServerStatus).not.toHaveBeenCalled();
  });

  test('mcp_add_server points agent installs at explicit MCP refresh without approval', async () => {
    const result = await addMcpServerTool.handler({
      name: 'Refreshable Server',
      transport: 'http',
      url: 'https://refresh.example.com/mcp',
    }, {
      agentId: 'agent-mcp-install',
      toolCallId: 'tool-call-mcp-install',
    });

    const request = approvalManager
      .getRequests()
      .find((approval) => approval.toolName === 'mcp_add_server');
    expect(request).toBeUndefined();
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text as string);
    expect(payload.mcpRefresh).toMatchObject({
      currentTurnToolsAvailable: true,
      nextTurnRequired: false,
      refreshTool: 'mcp_refresh_tools',
    });
  });

  test('mcp_refresh_tools reloads MCP servers without approval', async () => {
    mockReloadServers.mockClear();

    const result = await refreshMcpToolsTool.handler({
      reason: 'Use the newly installed server',
    }, {
      agentId: 'agent-mcp-refresh',
      toolCallId: 'tool-call-mcp-refresh',
    });

    const request = approvalManager
      .getRequests()
      .find((approval) => approval.toolName === 'mcp_refresh_tools');
    expect(request).toBeUndefined();
    expect(mockReloadServers).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text as string);
    expect(payload).toMatchObject({
      success: true,
      currentTurnToolsAvailable: true,
      nextTurnRequired: false,
    });
  });

  test('mcp_add_server treats OAuth-required status as a successful add', async () => {
    mockCreateServer.mockImplementationOnce(async (entry: any) => {
      runtimeServers.set(entry.name, createRuntimeServer(entry.name, {
        tools: {},
        resources: [],
        resourceTemplates: [],
        authStatus: 'notLoggedIn' as const,
      }));
    });

    const result = await addMcpServerTool.handler({
      name: 'Supabase',
      transport: 'http',
      url: 'https://mcp.supabase.com/mcp',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('OAuth sign-in is required');
  });

  test('mcp_add_server rejects command on remote transport before runtime creation', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {},
      allowAgentAddTools: true,
      allowLocalMcpServers: false,
    } as any);

    const result = await addMcpServerTool.handler({
      name: 'Bad Remote',
      transport: 'http',
      url: 'https://remote.example.com/mcp',
      command: '/bin/sh',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('command is only valid for stdio transport');
    expect(mockCreateServer).not.toHaveBeenCalled();
    expect(await getMcpServer('bad-remote')).toBeUndefined();
  });

  test('mcp_update_server preserves existing config on partial update', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        pubmed: {
          id: 'pubmed',
          name: 'PubMed',
          description: 'Search biomedical literature',
          transport: 'http',
          url: 'https://pubmed.example.com/mcp',
          oauthResource: 'https://pubmed.example.com/.well-known/oauth-protected-resource/mcp',
          startupTimeoutSec: 45,
          toolTimeoutSec: 90,
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const result = await updateMcpServerTool.handler({
      serverId: 'pubmed',
      headers: { Authorization: 'Bearer token' },
    });

    expect(result.isError).toBe(false);
    const entry = mockUpdateServer.mock.calls.at(-1)?.[0];
    expect(entry.config.url).toBe('https://pubmed.example.com/mcp');
    expect(entry.config.oauthResource).toBe(
      'https://pubmed.example.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(entry.config.httpHeaders).toEqual({ Authorization: 'Bearer token' });
    expect(entry.config.startupTimeoutSec).toBe(45);
    expect(entry.config.toolTimeoutSec).toBe(90);

    const persisted = await getMcpServer('pubmed');
    expect(persisted).toMatchObject({
      id: 'pubmed',
      name: 'PubMed',
      description: 'Search biomedical literature',
      transport: 'http',
      url: 'https://pubmed.example.com/mcp',
      oauthResource: 'https://pubmed.example.com/.well-known/oauth-protected-resource/mcp',
      headers: { Authorization: 'Bearer token' },
      startupTimeoutSec: 45,
      toolTimeoutSec: 90,
      enabled: true,
      createdAt: 1,
    });
  });

  test('mcp_update_server maps timeout fields to runtime config', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        pubmed: {
          id: 'pubmed',
          name: 'PubMed',
          transport: 'http',
          url: 'https://pubmed.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const result = await updateMcpServerTool.handler({
      serverId: 'pubmed',
      startup_timeout_sec: 75,
      tool_timeout_sec: 150,
    });

    expect(result.isError).toBe(false);
    const entry = mockUpdateServer.mock.calls.at(-1)?.[0];
    expect(entry.config.startupTimeoutSec).toBe(75);
    expect(entry.config.toolTimeoutSec).toBe(150);

    const persisted = await getMcpServer('pubmed');
    expect(persisted).toMatchObject({
      startupTimeoutSec: 75,
      toolTimeoutSec: 150,
    });
  });

  test('mcp_update_server treats OAuth-required status as a successful update', async () => {
    runtimeServers.set('pubmed', createRuntimeServer('pubmed', {
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: 'notLoggedIn' as const,
    }));
    setConfigOverride({
      agents: {},
      mcpServers: {
        pubmed: {
          id: 'pubmed',
          name: 'PubMed',
          transport: 'http',
          url: 'https://pubmed.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const result = await updateMcpServerTool.handler({
      serverId: 'pubmed',
      headers: { Authorization: 'Bearer token' },
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('OAuth sign-in is required');
  });

  test('mcp_update_server rejects switching to stdio when local integrations are disabled', async () => {
    setConfigOverride({
      agents: {},
      allowLocalMcpServers: false,
      mcpServers: {
        pubmed: {
          id: 'pubmed',
          name: 'PubMed',
          transport: 'http',
          url: 'https://pubmed.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const result = await updateMcpServerTool.handler({
      serverId: 'pubmed',
      transport: 'stdio',
      command: '/usr/bin/env',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Install local integrations');
    expect(mockUpdateServer).not.toHaveBeenCalled();
  });

  test('mcp_toggle_server persists disabled state through the shared path', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const result = await toggleMcpServerTool.handler({
      serverId: 'test-mcp',
      enabled: false,
    });

    expect(result.isError).toBe(false);
    expect(mockDisableServer).toHaveBeenCalledWith('test-mcp');
    expect(await getMcpServer('test-mcp')).toMatchObject({ enabled: false });
  });

  test('mcp_remove_server removes persisted config through the shared path', async () => {
    setConfigOverride({
      agents: {},
      mcpServers: {
        'test-mcp': {
          id: 'test-mcp',
          name: 'Test MCP',
          transport: 'http',
          url: 'https://test.example.com/mcp',
          enabled: true,
          createdAt: 1,
        },
      },
    } as any);

    const result = await removeMcpServerTool.handler({
      serverId: 'test-mcp',
    });

    expect(result.isError).toBe(false);
    expect(mockDeleteServer).toHaveBeenCalledWith('test-mcp');
    expect(await getMcpServer('test-mcp')).toBeUndefined();
  });
});
