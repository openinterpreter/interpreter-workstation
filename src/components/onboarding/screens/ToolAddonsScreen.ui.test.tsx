import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createDefaultOnboardingState } from '../../../../shared/types/onboardingState';
import { ToolAddonsScreen } from './ToolAddonsScreen';

type ToolServersChangedEvent = { servers: unknown[] };

const apiMocks = vi.hoisted(() => ({
  addToolServer: vi.fn(),
  deleteToolServer: vi.fn(),
  getOnboardingState: vi.fn(),
  setOnboardingState: vi.fn(),
  startToolServerOAuth: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  browserControl: {
    getStatus: vi.fn(),
    getPolicy: vi.fn(),
    setPolicy: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  },
  mcpDiscovery: {
    importedSetup: vi.fn(async () => ({
      generatedAt: '2026-06-22T12:00:00.000Z',
      candidates: [],
      summary: {
        generatedAt: null,
        sources: [],
        summary: '',
      },
    })),
    installImportedCandidate: vi.fn(async () => ({ serverId: 'server-id' })),
    discover: vi.fn(async () => ({
      discovered: [],
      sources: {
        claudeCode: { found: false, path: '' },
        cursor: { found: false, path: '' },
      },
    })),
    deepScan: vi.fn(async () => ({ discovered: [] })),
  },
  providers: {
    addGitHubMcpServerFromCliAuth: vi.fn(async () => ({
      success: false,
      installed: false,
      loggedIn: false,
      error: 'GitHub CLI is not installed or not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.',
    })),
  },
  servers: {
    list: vi.fn(async () => ({ servers: [] })),
  },
  toolServers: {
    onChanged: vi.fn<(callback: (event: ToolServersChangedEvent) => void) => () => void>(() => () => {}),
    getSnapshot: vi.fn(async () => ({ servers: [] })),
  },
  openExternal: vi.fn(async () => undefined),
}));

const telemetryMocks = vi.hoisted(() => ({
  trackOnboardingError: vi.fn(),
  trackSkillInstalled: vi.fn(),
  trackSkillInstallFailed: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      variants: _variants,
      custom: _custom,
      ...props
    }: HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      variants?: unknown;
      custom?: unknown;
    }) => <div {...props}>{children}</div>,
  },
}));

vi.mock('../../../api', () => ({
  addToolServer: apiMocks.addToolServer,
  deleteToolServer: apiMocks.deleteToolServer,
  getOnboardingState: apiMocks.getOnboardingState,
  setOnboardingState: apiMocks.setOnboardingState,
  startToolServerOAuth: apiMocks.startToolServerOAuth,
}));

vi.mock('../../../ipc', () => ipcMocks);

vi.mock('../../../utils/telemetry', () => telemetryMocks);

describe('ToolAddonsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.addToolServer.mockResolvedValue({ serverId: 'server-id' });
    apiMocks.deleteToolServer.mockResolvedValue(undefined);
    apiMocks.getOnboardingState.mockResolvedValue({ state: createDefaultOnboardingState() });
    apiMocks.setOnboardingState.mockResolvedValue({ success: true, state: createDefaultOnboardingState() });
    apiMocks.startToolServerOAuth.mockResolvedValue({ authorizationUrl: 'https://auth.example.com' });
    ipcMocks.mcpDiscovery.discover.mockResolvedValue({
      discovered: [],
      sources: {
        claudeCode: { found: false, path: '' },
        cursor: { found: false, path: '' },
      },
    });
    ipcMocks.mcpDiscovery.importedSetup.mockResolvedValue({
      generatedAt: '2026-06-22T12:00:00.000Z',
      candidates: [],
      summary: {
        generatedAt: null,
        sources: [],
        summary: '',
      },
    });
    ipcMocks.mcpDiscovery.installImportedCandidate.mockResolvedValue({ serverId: 'server-id' });
    ipcMocks.providers.addGitHubMcpServerFromCliAuth.mockResolvedValue({
      success: false,
      installed: false,
      loggedIn: false,
      error: 'GitHub CLI is not installed or not authenticated. Run "gh auth login" in a terminal, or set GH_TOKEN/GITHUB_TOKEN before starting Interpreter.',
    });
    ipcMocks.servers.list.mockResolvedValue({ servers: [] });
    ipcMocks.toolServers.getSnapshot.mockResolvedValue({ servers: [] });
    ipcMocks.browserControl.getStatus.mockResolvedValue({
      relay: {
        phase: 'ready',
        version: null,
        runtimeDir: null,
        relayLogPath: null,
        relayCdpLogPath: null,
        ownsRelayProcess: false,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:0',
      },
      connections: [],
      profiles: [],
      connectedBrowsers: 0,
      activeSessions: 0,
    });
    ipcMocks.browserControl.getPolicy.mockResolvedValue({
      policy: {
        permissions: {
          read: { mode: 'ask', allowedPatterns: [] },
          write: { mode: 'ask', allowedPatterns: [] },
          action: { mode: 'ask', allowedPatterns: [] },
        },
        profilePolicies: [],
      },
    });
    ipcMocks.browserControl.setPolicy.mockImplementation(async (policy) => ({
      success: true,
      policy,
    }));
  });

  test('offers browser extension setup without granting browser actions', async () => {
    const user = userEvent.setup();

    render(<ToolAddonsScreen bucket="developer" onNext={() => {}} />);

    expect(await screen.findByText('Interpreter Chrome extension')).toBeVisible();
    expect(screen.getByText('No browser profile is connected yet.')).toBeVisible();
    expect(screen.getByText('Installing does not grant actions. Browser permissions still decide whether Interpreter asks, denies, or allows read, write, and control.')).toBeVisible();

    const browserCard = screen.getByText('Interpreter Chrome extension').closest('.relative');
    expect(browserCard).not.toBeNull();
    expect(browserCard).toHaveClass('md:col-span-2');

    const githubCard = (await screen.findByText('GitHub')).closest('.relative');
    expect(githubCard).not.toBeNull();
    expect(githubCard).not.toHaveClass('md:col-span-2');

    await user.click(within(browserCard as HTMLElement).getByRole('button', { name: 'Install' }));

    expect(ipcMocks.openExternal).toHaveBeenCalledWith('https://chromewebstore.google.com/detail/interpreter-chrome-extens/bboaaphdpllilofamfpommlbafpellnb');
  });

  test('shows detected Chrome profiles in browser extension setup', async () => {
    ipcMocks.browserControl.getStatus.mockResolvedValueOnce({
      relay: {
        phase: 'ready',
        version: null,
        runtimeDir: null,
        relayLogPath: null,
        relayCdpLogPath: null,
        ownsRelayProcess: false,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:0',
      },
      connections: [],
      profiles: [
        {
          profileId: 'local:work',
          policyProfileId: 'install:work',
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'Work',
          profilePath: '',
          userDataDir: '',
          extensionId: 'extension-work',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 1,
          windowCount: 1,
          tabCount: 2,
        },
        {
          profileId: 'local:personal',
          policyProfileId: null,
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'Personal',
          profilePath: '',
          userDataDir: '',
          extensionId: null,
          stableKey: null,
          connectionState: 'detected',
          activeSessions: 0,
          windowCount: 0,
          tabCount: 0,
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 1,
    });

    render(<ToolAddonsScreen bucket="developer" onNext={() => {}} />);

    expect(await screen.findByText('Chrome Work')).toBeVisible();
    expect(await screen.findByText('Chrome Personal')).toBeVisible();
    expect(screen.getByText('1 browser profile(s) connected.')).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText('Detected')).toBeVisible();
  });

  test('saves selected connected Chrome profile access as ask or deny policy', async () => {
    const user = userEvent.setup();
    ipcMocks.browserControl.getStatus.mockResolvedValueOnce({
      relay: {
        phase: 'ready',
        version: null,
        runtimeDir: null,
        relayLogPath: null,
        relayCdpLogPath: null,
        ownsRelayProcess: false,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:0',
      },
      connections: [],
      profiles: [
        {
          profileId: 'local:work',
          policyProfileId: 'install:work',
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'Work',
          profilePath: '',
          userDataDir: '',
          extensionId: 'extension-work',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 1,
          windowCount: 1,
          tabCount: 2,
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 1,
    });

    render(<ToolAddonsScreen bucket="developer" onNext={() => {}} />);

    const profileToggle = await screen.findByRole('checkbox', { name: 'Allow Interpreter on Chrome Work' });
    expect(profileToggle).toBeChecked();

    await user.click(profileToggle);

    await waitFor(() => {
      expect(ipcMocks.browserControl.setPolicy).toHaveBeenCalledWith({
        permissions: {
          read: { mode: 'ask', allowedPatterns: [] },
          write: { mode: 'ask', allowedPatterns: [] },
          action: { mode: 'ask', allowedPatterns: [] },
        },
        profilePolicies: [
          {
            profileId: 'install:work',
            permissions: {
              read: { mode: 'deny', allowedPatterns: [] },
              write: { mode: 'deny', allowedPatterns: [] },
              action: { mode: 'deny', allowedPatterns: [] },
            },
          },
        ],
      });
    });
  });

  test('re-enables a denied Chrome profile as ask-first access', async () => {
    const user = userEvent.setup();
    ipcMocks.browserControl.getStatus.mockResolvedValueOnce({
      relay: {
        phase: 'ready',
        version: null,
        runtimeDir: null,
        relayLogPath: null,
        relayCdpLogPath: null,
        ownsRelayProcess: false,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:0',
      },
      connections: [],
      profiles: [
        {
          profileId: 'local:personal',
          policyProfileId: 'install:personal',
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'Personal',
          profilePath: '',
          userDataDir: '',
          extensionId: 'extension-personal',
          stableKey: 'install:personal',
          connectionState: 'connected',
          activeSessions: 0,
          windowCount: 1,
          tabCount: 1,
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 0,
    });
    ipcMocks.browserControl.getPolicy.mockResolvedValueOnce({
      policy: {
        permissions: {
          read: { mode: 'ask', allowedPatterns: [] },
          write: { mode: 'ask', allowedPatterns: [] },
          action: { mode: 'ask', allowedPatterns: [] },
        },
        profilePolicies: [
          {
            profileId: 'install:personal',
            permissions: {
              read: { mode: 'deny', allowedPatterns: [] },
              write: { mode: 'deny', allowedPatterns: [] },
              action: { mode: 'deny', allowedPatterns: [] },
            },
          },
        ],
      },
    });

    render(<ToolAddonsScreen bucket="developer" onNext={() => {}} />);

    const profileToggle = await screen.findByRole('checkbox', { name: 'Allow Interpreter on Chrome Personal' });
    expect(profileToggle).not.toBeChecked();

    await user.click(profileToggle);

    await waitFor(() => {
      expect(ipcMocks.browserControl.setPolicy).toHaveBeenCalledWith({
        permissions: {
          read: { mode: 'ask', allowedPatterns: [] },
          write: { mode: 'ask', allowedPatterns: [] },
          action: { mode: 'ask', allowedPatterns: [] },
        },
        profilePolicies: [
          {
            profileId: 'install:personal',
            permissions: {
              read: { mode: 'ask', allowedPatterns: [] },
              write: { mode: 'ask', allowedPatterns: [] },
              action: { mode: 'ask', allowedPatterns: [] },
            },
          },
        ],
      });
    });
  });

  test('uses GitHub CLI auth instead of generic store add or OAuth when adding GitHub from onboarding', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(<ToolAddonsScreen bucket="developer" onNext={() => {}} />);

      const githubTitle = await screen.findByText('GitHub');
      const githubCard = githubTitle.closest('.relative');
      expect(githubCard).not.toBeNull();

      await user.click(within(githubCard as HTMLElement).getByRole('button', { name: 'Add' }));

      await waitFor(() => {
        expect(ipcMocks.providers.addGitHubMcpServerFromCliAuth).toHaveBeenCalledTimes(1);
      });

      expect(apiMocks.addToolServer).not.toHaveBeenCalled();
      expect(apiMocks.startToolServerOAuth).not.toHaveBeenCalled();
      expect(ipcMocks.openExternal).not.toHaveBeenCalled();
      expect(await within(githubCard as HTMLElement).findByText(/Run "gh auth login"/)).toBeVisible();
    } finally {
      consoleError.mockRestore();
    }
  });

  test('persists redacted startup MCP candidate metadata without config details', async () => {
    ipcMocks.mcpDiscovery.importedSetup.mockResolvedValueOnce({
      generatedAt: '2026-06-22T12:00:00.000Z',
      candidates: [
        {
          id: 'claude-code:github',
          name: 'GitHub',
          source: 'claude-code',
          transport: 'stdio',
        },
        {
          id: 'cursor:linear',
          name: 'Linear',
          source: 'cursor',
          transport: 'http',
        },
      ],
      summary: {
        generatedAt: '2026-06-22T12:00:00.000Z',
        sources: ['discovered-mcp-configs'],
        summary: 'Importable MCP servers: GitHub (Claude Code, stdio), Linear (Cursor, http).',
      },
    } as any);

    render(<ToolAddonsScreen bucket="developer" onNext={() => {}} />);

    await waitFor(() => {
      expect(apiMocks.setOnboardingState).toHaveBeenCalled();
    });

    const persistedState = apiMocks.setOnboardingState.mock.calls[0][0];
    expect(persistedState.importedToolSummary).toEqual({
      generatedAt: expect.any(String),
      sources: ['discovered-mcp-configs'],
      summary: 'Importable MCP servers: GitHub (Claude Code, stdio), Linear (Cursor, http).',
    });
    expect(persistedState.importedToolSummary.summary).not.toContain('secret-token');
    expect(persistedState.importedToolSummary.summary).not.toContain('@modelcontextprotocol/server-github');
    expect(persistedState.importedToolSummary.summary).not.toContain('/Users/example');
  });

  test('installs startup MCP candidates by candidate id without renderer config details', async () => {
    const user = userEvent.setup();
    ipcMocks.mcpDiscovery.importedSetup.mockResolvedValueOnce({
      generatedAt: '2026-06-22T12:00:00.000Z',
      candidates: [
        {
          id: 'cursor:ollama-tools',
          name: 'Ollama Tools',
          source: 'cursor',
          transport: 'stdio',
        },
      ],
      summary: {
        generatedAt: '2026-06-22T12:00:00.000Z',
        sources: ['discovered-mcp-configs'],
        summary: 'Importable MCP servers: Ollama Tools (Cursor, stdio).',
      },
    } as any);

    render(<ToolAddonsScreen bucket="developer-local-ai" onNext={() => {}} />);

    const candidateTitle = await screen.findByText('Ollama Tools');
    const candidateCard = candidateTitle.closest('.relative');
    expect(candidateCard).not.toBeNull();

    await user.click(within(candidateCard as HTMLElement).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(ipcMocks.mcpDiscovery.installImportedCandidate).toHaveBeenCalledWith('cursor:ollama-tools');
    });
    expect(apiMocks.addToolServer).not.toHaveBeenCalled();
  });
});
