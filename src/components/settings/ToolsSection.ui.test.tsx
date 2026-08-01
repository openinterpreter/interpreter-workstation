import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ToolServer } from '../../api';
import { ToolsSectionContent } from './ToolsSection';

type ToolServersChangedEvent = { servers: ToolServer[] };
type SetupCompletedEvent = {
  serverId: string;
  configured: boolean;
  error?: string;
};

const toolServersContextMocks = vi.hoisted(() => ({
  servers: [] as ToolServer[],
  loading: false,
  error: null,
  refresh: vi.fn(async () => {}),
  addServer: vi.fn(async () => ''),
  deleteServer: vi.fn(async () => {}),
  toggleServer: vi.fn(async () => {}),
}));

const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  addToolServer: vi.fn(),
  getToolServer: vi.fn(),
  listAllToolServers: vi.fn(async () => ({ servers: [] })),
  startToolServerOAuth: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  globalTools: {
    set: vi.fn(async () => ({ success: true })),
  },
  providers: {
    addGitHubMcpServerFromCliAuth: vi.fn(async () => ({
      success: false,
      serverId: undefined as string | undefined,
      installed: false,
      loggedIn: false,
      source: undefined as 'gh-cli' | 'env' | undefined,
      error: 'GitHub CLI is not authenticated',
    })),
  },
  toolServers: {
    onChanged: vi.fn<(callback: (event: ToolServersChangedEvent) => void) => () => void>(() => () => {}),
  },
  setup: {
    onCompleted: vi.fn<(callback: (event: SetupCompletedEvent) => void) => () => void>(() => () => {}),
  },
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../contexts/ToolServersContext', () => ({
  useToolServers: () => toolServersContextMocks,
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => toastMocks,
}));

vi.mock('../../ipc', () => ipcMocks);

vi.mock('../../api', () => ({
  addToolServer: apiMocks.addToolServer,
  getToolServer: apiMocks.getToolServer,
  listAllToolServers: apiMocks.listAllToolServers,
  startToolServerOAuth: apiMocks.startToolServerOAuth,
  toolServerNeedsAuth: (server: { state: { status: string; needsAuth?: boolean } }) =>
    server.state.status === 'failed' && server.state.needsAuth === true,
}));

describe('ToolsSectionContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolServersContextMocks.loading = false;
    toolServersContextMocks.servers = [];
    toolServersContextMocks.refresh.mockResolvedValue(undefined);
    apiMocks.listAllToolServers.mockResolvedValue({ servers: [] });
  });

  test('shows a toast when adding a store MCP fails immediately', async () => {
    const user = userEvent.setup();
    apiMocks.addToolServer.mockRejectedValueOnce(new Error('Bad URL'));

    render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Add Supabase' }));

    await waitFor(() => {
      expect(toastMocks.showToast).toHaveBeenCalledWith(
        'Supabase MCP server is not configured correctly. Bad URL',
        'error',
        8000,
      );
    });
  });

  test('does not fall back to generic store add when GitHub CLI auth is unavailable', async () => {
    const user = userEvent.setup();
    ipcMocks.providers.addGitHubMcpServerFromCliAuth.mockResolvedValueOnce({
      success: false,
      serverId: undefined,
      installed: true,
      loggedIn: false,
      source: undefined,
      error: 'GitHub CLI is installed but not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.',
    });

    render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Add GitHub' }));

    await waitFor(() => {
      expect(ipcMocks.providers.addGitHubMcpServerFromCliAuth).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.addToolServer).not.toHaveBeenCalled();
    expect(apiMocks.startToolServerOAuth).not.toHaveBeenCalled();
    expect(ipcMocks.openExternal).not.toHaveBeenCalled();
    expect(toastMocks.showToast).toHaveBeenCalledWith(
      'GitHub CLI is installed but not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.',
      'error',
      8000,
    );
  });

  test('shows a loading state immediately while adding a store MCP', async () => {
    const user = userEvent.setup();
    let resolveAdd: ((value: { serverId: string }) => void) | undefined;
    apiMocks.addToolServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
    );

    const { rerender } = render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Add Supabase' }));

    await waitFor(() => {
      expect(apiMocks.addToolServer).toHaveBeenCalledWith({
        name: 'Supabase',
        transport: 'http',
        url: 'https://mcp.supabase.com/mcp',
        headers: undefined,
        oauthResource: 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp',
        enabled: true,
      });
    });

    expect(await screen.findByRole('button', { name: 'Loading Supabase' })).toBeDisabled();

    if (!resolveAdd) {
      throw new Error('Expected store add promise resolver to be captured');
    }
    resolveAdd({ serverId: 'supabase' });

    toolServersContextMocks.servers = [
      {
        id: 'supabase',
        name: 'Supabase',
        state: {
          status: 'connected',
          tools: [],
          resources: [],
          prompts: [],
        },
        config: {
          transport: 'http',
          url: 'https://mcp.supabase.com/mcp',
          enabled: true,
        },
      },
    ];
    rerender(<ToolsSectionContent />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Loading Supabase' })).toBeNull();
    });
    expect(toolServersContextMocks.refresh).not.toHaveBeenCalled();
  });

  test('keeps a store MCP pending until the installed server appears in tool state', async () => {
    const user = userEvent.setup();
    let resolveAdd: ((value: { serverId: string }) => void) | undefined;
    apiMocks.addToolServer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const authRequiredServer: ToolServer = {
      id: 'sentry',
      name: 'Sentry',
      state: {
        status: 'failed',
        error: 'OAuth login required',
        needsAuth: true,
      },
      config: {
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        enabled: true,
      },
    };

    const { rerender } = render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Add Sentry' }));

    if (!resolveAdd) {
      throw new Error('Expected store add promise resolver to be captured');
    }
    resolveAdd({ serverId: 'sentry' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Loading Sentry' })).toBeDisabled();
    });
    expect(screen.queryByRole('button', { name: 'Add Sentry' })).toBeNull();
    expect(apiMocks.addToolServer).toHaveBeenCalledTimes(1);

    toolServersContextMocks.servers = [authRequiredServer];
    rerender(<ToolsSectionContent />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Loading Sentry' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Complete auth for Sentry' })).toBeVisible();
  });

  test('saving a custom HTTP MCP submits a remote config without local command fields', async () => {
    const user = userEvent.setup();
    apiMocks.addToolServer.mockResolvedValueOnce({ serverId: 'custom-server' });

    render(<ToolsSectionContent />);

    await user.click(await screen.findByText('Custom MCP server'));
    await user.type(await screen.findByLabelText('Server Name'), 'Custom Server');
    await user.click(screen.getByRole('button', { name: 'HTTP' }));
    await user.type(screen.getByLabelText('URL'), 'https://custom.example.com/mcp');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(apiMocks.addToolServer).toHaveBeenCalledTimes(1);
    });
    const config = apiMocks.addToolServer.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      name: 'Custom Server',
      transport: 'http',
      enabled: true,
      url: 'https://custom.example.com/mcp',
    });
    expect(config).not.toHaveProperty('command');

    expect(apiMocks.listAllToolServers).not.toHaveBeenCalled();
  });

  test('saving a custom WebSocket MCP submits wsUrl without HTTP or stdio fields', async () => {
    const user = userEvent.setup();
    apiMocks.addToolServer.mockResolvedValueOnce({ serverId: 'socket-server' });

    render(<ToolsSectionContent />);

    await user.click(await screen.findByText('Custom MCP server'));
    await user.type(await screen.findByLabelText('Server Name'), 'Socket Server');
    await user.click(screen.getByRole('button', { name: 'WebSocket' }));
    await user.type(screen.getByLabelText('WebSocket URL'), 'wss://socket.example.com/mcp');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(apiMocks.addToolServer).toHaveBeenCalledTimes(1);
    });
    const config = apiMocks.addToolServer.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      name: 'Socket Server',
      transport: 'websocket',
      enabled: true,
      wsUrl: 'wss://socket.example.com/mcp',
    });
    expect(config).not.toHaveProperty('command');
    expect(config).not.toHaveProperty('url');

    expect(apiMocks.listAllToolServers).not.toHaveBeenCalled();
  });

  test('shows a toast when saving a custom MCP fails validation or connection setup', async () => {
    const user = userEvent.setup();
    apiMocks.addToolServer.mockRejectedValueOnce(new Error('Connection refused'));

    render(<ToolsSectionContent />);

    await user.click(await screen.findByText('Custom MCP server'));
    await user.type(await screen.findByLabelText('Server Name'), 'Broken Server');
    await user.click(screen.getByRole('button', { name: 'HTTP' }));
    await user.type(screen.getByLabelText('URL'), 'https://broken.example.com/mcp');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(toastMocks.showToast).toHaveBeenCalledWith(
        'Broken Server MCP server is not configured correctly. Connection refused',
        'error',
        8000,
      );
    });
  });

  test('removes an MCP server from the grid immediately while delete is still pending', async () => {
    const user = userEvent.setup();
    let resolveDelete: (() => void) | undefined;
    toolServersContextMocks.servers = [
      {
        id: 'sentry',
        name: 'Sentry',
        state: {
          status: 'connected',
          tools: [],
          resources: [],
          prompts: [],
        },
        config: {
          transport: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          enabled: true,
        },
      },
    ];
    toolServersContextMocks.deleteServer.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    render(<ToolsSectionContent />);

    expect(screen.getByRole('tab', { name: 'Connected (1)' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(toolServersContextMocks.deleteServer).toHaveBeenCalledWith('sentry');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Connected' })).toBeVisible();
    });

    resolveDelete?.();
  });

  test('shows a re-added MCP server instead of resurfacing its store Add button after delete', async () => {
    const user = userEvent.setup();
    const sentryServer: ToolServer = {
      id: 'sentry',
      name: 'Sentry',
      state: {
        status: 'connected',
        tools: [],
        resources: [],
        prompts: [],
      },
      config: {
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        enabled: true,
      },
    };

    toolServersContextMocks.servers = [sentryServer];

    const { rerender } = render(<ToolsSectionContent />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(toolServersContextMocks.deleteServer).toHaveBeenCalledWith('sentry');
    });

    toolServersContextMocks.servers = [];
    rerender(<ToolsSectionContent />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add Sentry' })).toBeVisible();
    });

    toolServersContextMocks.servers = [sentryServer];
    rerender(<ToolsSectionContent />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Add Sentry' })).toBeNull();
    });
    expect(screen.getByRole('switch', { name: 'Disable Sentry globally' })).toBeVisible();
  });

  test('updates the global toggle immediately while disable is still pending', async () => {
    const user = userEvent.setup();
    let resolveGlobalToggle: (() => void) | undefined;
    toolServersContextMocks.servers = [
      {
        id: 'sentry',
        name: 'Sentry',
        state: {
          status: 'connected',
          tools: [],
          resources: [],
          prompts: [],
        },
        config: {
          transport: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          enabled: true,
        },
      },
    ];
    ipcMocks.globalTools.set.mockImplementationOnce(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveGlobalToggle = () => resolve({ success: true });
        }),
    );

    render(<ToolsSectionContent />);

    await user.click(screen.getByRole('switch', { name: 'Disable Sentry globally' }));

    expect(ipcMocks.globalTools.set).toHaveBeenCalledWith('sentry', false);
    expect(screen.getByRole('switch', { name: 'Enable Sentry globally' })).toBeVisible();

    resolveGlobalToggle?.();
  });

  test('starts MCP OAuth from an auth-required tool card and opens the browser', async () => {
    const user = userEvent.setup();
    toolServersContextMocks.servers = [
      {
        id: 'sentry',
        name: 'Sentry',
        state: {
          status: 'failed',
          error: 'OAuth login required',
          needsAuth: true,
        },
        config: {
          transport: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          enabled: true,
        },
      },
    ];
    apiMocks.startToolServerOAuth.mockResolvedValueOnce({
      authorizationUrl: 'https://auth.example.com/sentry',
    });

    render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Complete auth for Sentry' }));

    expect(apiMocks.startToolServerOAuth).toHaveBeenCalledWith('sentry');
    expect(ipcMocks.openExternal).toHaveBeenCalledWith('https://auth.example.com/sentry');
    expect(await screen.findByRole('button', { name: 'Waiting for sign-in for Sentry' })).toBeDisabled();
  });

  test('uses GitHub CLI auth path instead of browser OAuth for GitHub MCP', async () => {
    const user = userEvent.setup();
    toolServersContextMocks.servers = [
      {
        id: 'github',
        name: 'GitHub',
        state: {
          status: 'failed',
          error: 'OAuth login required',
          needsAuth: true,
        },
        config: {
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          enabled: true,
        },
      },
    ];
    ipcMocks.providers.addGitHubMcpServerFromCliAuth.mockResolvedValueOnce({
      success: true,
      serverId: 'github',
      installed: true,
      loggedIn: true,
      source: 'gh-cli',
      error: '',
    });
    apiMocks.getToolServer.mockResolvedValueOnce({
      id: 'github',
      name: 'GitHub',
      state: {
        status: 'connected',
        tools: [],
        resources: [],
        prompts: [],
      },
      config: {
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
      },
    });

    render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Complete auth for GitHub' }));

    await waitFor(() => {
      expect(ipcMocks.providers.addGitHubMcpServerFromCliAuth).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.startToolServerOAuth).not.toHaveBeenCalled();
    expect(ipcMocks.openExternal).not.toHaveBeenCalled();
  });

  test('keeps waiting for sign-in until OAuth reaches a terminal connected state', async () => {
    const user = userEvent.setup();
    let onChanged: ((event: ToolServersChangedEvent) => void) | undefined;
    const authRequiredServer: ToolServer = {
      id: 'sentry',
      name: 'Sentry',
      state: {
        status: 'failed',
        error: 'OAuth login required',
        needsAuth: true,
      },
      config: {
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        enabled: true,
      },
    };
    const disconnectedServer: ToolServer = {
      ...authRequiredServer,
      state: {
        status: 'disconnected',
      },
    };
    const connectedServer: ToolServer = {
      ...authRequiredServer,
      state: {
        status: 'connected',
        tools: [],
        resources: [],
        prompts: [],
      },
    };

    toolServersContextMocks.servers = [authRequiredServer];
    apiMocks.startToolServerOAuth.mockResolvedValueOnce({
      authorizationUrl: 'https://auth.example.com/sentry',
    });
    apiMocks.getToolServer.mockResolvedValue(authRequiredServer);
    ipcMocks.toolServers.onChanged.mockImplementation((callback: (event: ToolServersChangedEvent) => void) => {
      onChanged = callback;
      return () => {};
    });

    render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Complete auth for Sentry' }));

    toolServersContextMocks.servers = [disconnectedServer];
    onChanged?.({ servers: [disconnectedServer] });

    expect(await screen.findByRole('button', { name: 'Waiting for sign-in for Sentry' })).toBeDisabled();
    expect(toastMocks.showToast).not.toHaveBeenCalled();

    toolServersContextMocks.servers = [connectedServer];
    onChanged?.({ servers: [connectedServer] });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Waiting for sign-in for Sentry' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Complete auth for Sentry' })).not.toBeInTheDocument();
    expect(toastMocks.showToast).not.toHaveBeenCalled();
  });

  test('shows a toast when OAuth completes with a terminal non-auth failure', async () => {
    const user = userEvent.setup();
    let onChanged: ((event: ToolServersChangedEvent) => void) | undefined;
    let onCompleted: ((event: SetupCompletedEvent) => void) | undefined;
    const authRequiredServer: ToolServer = {
      id: 'sentry',
      name: 'Sentry',
      state: {
        status: 'failed',
        error: 'OAuth login required',
        needsAuth: true,
      },
      config: {
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        enabled: true,
      },
    };
    const failedServer: ToolServer = {
      ...authRequiredServer,
      state: {
        status: 'failed',
        error: 'OAuth token rejected',
      },
    };

    toolServersContextMocks.servers = [authRequiredServer];
    apiMocks.startToolServerOAuth.mockResolvedValueOnce({
      authorizationUrl: 'https://auth.example.com/sentry',
    });
    apiMocks.getToolServer.mockResolvedValue(authRequiredServer);
    ipcMocks.toolServers.onChanged.mockImplementation((callback: (event: ToolServersChangedEvent) => void) => {
      onChanged = callback;
      return () => {};
    });
    ipcMocks.setup.onCompleted.mockImplementation(
      (callback: (event: SetupCompletedEvent) => void) => {
        onCompleted = callback;
        return () => {};
      },
    );

    render(<ToolsSectionContent />);

    await user.click(await screen.findByRole('button', { name: 'Complete auth for Sentry' }));

    toolServersContextMocks.servers = [failedServer];
    onChanged?.({ servers: [failedServer] });
    onCompleted?.({ serverId: 'sentry', configured: false, error: 'OAuth token rejected' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Waiting for sign-in for Sentry' })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(toastMocks.showToast).toHaveBeenCalledWith(
        'Sentry MCP server is not configured correctly. OAuth token rejected',
        'error',
        8000,
      );
    });
    expect(screen.queryByRole('button', { name: 'Complete auth for Sentry' })).not.toBeInTheDocument();
  });
});
