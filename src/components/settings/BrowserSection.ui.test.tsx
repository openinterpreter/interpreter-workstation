import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { BrowserSectionContent } from './BrowserSection';

const browserControlMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getPolicy: vi.fn(),
  setPolicy: vi.fn(),
  onChanged: vi.fn(() => () => {}),
}));

const ipcMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showSelect: vi.fn(),
}));

const telemetryMocks = vi.hoisted(() => ({
  trackSettingChanged: vi.fn(),
}));

vi.mock('@/ipc', () => ({
  browserControl: browserControlMocks,
  openExternal: ipcMocks.openExternal,
  showSelect: ipcMocks.showSelect,
}));

vi.mock('@/utils/telemetry', () => telemetryMocks);

vi.mock('@/utils/userVisibleErrorLog', () => ({
  logUserVisibleError: vi.fn(),
}));

function browserPolicy(
  mode: 'ask' | 'deny' | 'all' | 'allowList',
  profilePolicies: Array<{
    profileId: string;
    mode: 'ask' | 'deny' | 'all' | 'allowList';
  }> = [],
) {
  return {
    permissions: {
      read: { mode, allowedPatterns: [] },
      write: { mode, allowedPatterns: [] },
      action: { mode, allowedPatterns: [] },
    },
    profilePolicies: profilePolicies.map((profilePolicy) => ({
      profileId: profilePolicy.profileId,
      permissions: {
        read: { mode: profilePolicy.mode, allowedPatterns: [] },
        write: { mode: profilePolicy.mode, allowedPatterns: [] },
        action: { mode: profilePolicy.mode, allowedPatterns: [] },
      },
    })),
  };
}

describe('BrowserSectionContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    ipcMocks.showSelect.mockResolvedValue('allowList');
    browserControlMocks.getStatus.mockResolvedValue({
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
    browserControlMocks.getPolicy.mockResolvedValue({
      policy: browserPolicy('all'),
    });
  });

  test('shows a save error instead of success UI when the policy write fails', async () => {
    const user = userEvent.setup();
    browserControlMocks.setPolicy.mockResolvedValue({
      success: false,
      policy: browserPolicy('allowList'),
      error: 'Config write failed',
    });

    render(<BrowserSectionContent />);
    expect(await screen.findByText('Ready')).toBeVisible();

    const modeRow = (await screen.findByText('Read browser pages')).closest('[data-help-title="Read browser pages"]');
    expect(modeRow).not.toBeNull();

    const modeSelect = within(modeRow as HTMLElement).getByRole('button', { name: 'All browser pages' });
    expect(modeSelect).toHaveTextContent('All browser pages');

    await user.click(modeSelect);

    await waitFor(() => {
      expect(browserControlMocks.setPolicy).toHaveBeenCalledWith({
        permissions: {
          read: { mode: 'allowList', allowedPatterns: [] },
          write: { mode: 'all', allowedPatterns: [] },
          action: { mode: 'all', allowedPatterns: [] },
        },
        profilePolicies: [],
      });
    });

    expect(screen.queryByText('Changes apply right away. If you just allowed a page that was hidden before, refresh the current browser session if it does not appear yet.')).not.toBeInTheDocument();
    expect(within(modeRow as HTMLElement).getByRole('button', { name: 'All browser pages' })).toBeVisible();
    expect(telemetryMocks.trackSettingChanged).not.toHaveBeenCalled();
  });

  test('renders ask-before-use browser policy mode', async () => {
    browserControlMocks.getPolicy.mockResolvedValue({
      policy: browserPolicy('ask'),
    });

    render(<BrowserSectionContent />);

    expect(await screen.findByText('Installing the extension only connects Chrome to Interpreter. Browser permissions below still decide whether Interpreter asks, denies, or allows read, write, and control actions.')).toBeVisible();
    const modeRow = (await screen.findByText('Read browser pages')).closest('[data-help-title="Read browser pages"]');
    expect(modeRow).not.toBeNull();
    expect(within(modeRow as HTMLElement).getByRole('button', { name: 'Ask before use' })).toBeVisible();
    expect(await screen.findByText('Browser pages will ask before Interpreter uses them.')).toBeVisible();
  });

  test('renders deny browser policy mode', async () => {
    browserControlMocks.getPolicy.mockResolvedValue({
      policy: browserPolicy('deny'),
    });

    render(<BrowserSectionContent />);

    const modeRow = (await screen.findByText('Read browser pages')).closest('[data-help-title="Read browser pages"]');
    expect(modeRow).not.toBeNull();
    expect(within(modeRow as HTMLElement).getByRole('button', { name: 'Never use browser pages' })).toBeVisible();
    expect(await screen.findByText('Browser control is disabled.')).toBeVisible();
  });

  test('lists detected browser profiles and saves a profile-specific rule', async () => {
    const user = userEvent.setup();
    ipcMocks.showSelect.mockResolvedValue('deny');
    browserControlMocks.getStatus.mockResolvedValue({
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
      connections: [
        {
          extensionId: 'extension-1',
          stableKey: 'chrome-profile-work',
          profileId: 'chrome-profile-work',
          browserName: 'chrome',
          version: '1.0.0',
          activeSessions: 0,
          targets: [],
          browserWindows: [
            {
              windowId: 10,
              focused: true,
              type: 'normal',
              state: 'normal',
              tabs: [
                {
                  tabRef: 'chrome-profile-work:chrome-tab:20',
                  chromeTabId: 20,
                  windowId: 10,
                  index: 0,
                  active: true,
                  highlighted: true,
                  pinned: false,
                  title: 'Docs',
                  url: 'https://example.com/docs',
                  status: 'complete',
                  controlState: 'observable',
                },
              ],
            },
          ],
          focusedWindowId: 10,
          activeTabRef: 'chrome-profile-work:chrome-tab:20',
          focusedWindow: {
            windowId: 10,
            focused: true,
            type: 'normal',
            state: 'normal',
            tabs: [
              {
                tabRef: 'chrome-profile-work:chrome-tab:20',
                chromeTabId: 20,
                windowId: 10,
                index: 0,
                active: true,
                highlighted: true,
                pinned: false,
                title: 'Docs',
                url: 'https://example.com/docs',
                status: 'complete',
                controlState: 'observable',
              },
            ],
          },
          activeTab: {
            tabRef: 'chrome-profile-work:chrome-tab:20',
            chromeTabId: 20,
            windowId: 10,
            index: 0,
            active: true,
            highlighted: true,
            pinned: false,
            title: 'Docs',
            url: 'https://example.com/docs',
            status: 'complete',
            controlState: 'observable',
          },
        },
      ],
      profiles: [
        {
          profileId: 'install:work',
          policyProfileId: 'install:work',
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'Work',
          profilePath: '',
          userDataDir: '',
          extensionId: 'extension-1',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 0,
          windowCount: 1,
          tabCount: 1,
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 0,
    });
    browserControlMocks.setPolicy.mockImplementation(async (policy) => ({
      success: true,
      policy,
    }));

    render(<BrowserSectionContent />);

    expect(await screen.findByText('Chrome profiles on this computer')).toBeVisible();
    expect(await screen.findByText('Profiles detected on this computer are listed here. Connected profiles can each have separate page rules.')).toBeVisible();
    expect(await screen.findByText('Chrome Work')).toBeVisible();
    expect(await screen.findByText('1 windows, 1 tabs detected')).toBeVisible();

    const profileModeSelect = screen.getAllByRole('button', { name: 'Use default rule' })[0];

    await user.click(profileModeSelect);

    await waitFor(() => {
      expect(browserControlMocks.setPolicy).toHaveBeenCalledWith({
        permissions: {
          read: { mode: 'all', allowedPatterns: [] },
          write: { mode: 'all', allowedPatterns: [] },
          action: { mode: 'all', allowedPatterns: [] },
        },
        profilePolicies: [
          {
            profileId: 'install:work',
            permissions: {
              read: { mode: 'deny', allowedPatterns: [] },
              write: { mode: 'all', allowedPatterns: [] },
              action: { mode: 'all', allowedPatterns: [] },
            },
          },
        ],
      });
    });
  });

  test('saves separate rules for separate connected Chrome profiles', async () => {
    const user = userEvent.setup();
    ipcMocks.showSelect.mockResolvedValueOnce('all');
    browserControlMocks.getPolicy.mockResolvedValue({
      policy: browserPolicy('all', [{ profileId: 'install:work', mode: 'deny' }]),
    });
    browserControlMocks.getStatus.mockResolvedValue({
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
          profileId: 'install:work',
          policyProfileId: 'install:work',
          browserName: 'chrome',
          browserChannel: null,
          profileName: 'Work',
          profilePath: '',
          userDataDir: '',
          extensionId: 'extension-work',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 0,
          windowCount: 1,
          tabCount: 2,
        },
        {
          profileId: 'install:personal',
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
      connectedBrowsers: 2,
      activeSessions: 0,
    });
    browserControlMocks.setPolicy.mockImplementation(async (policy) => ({
      success: true,
      policy,
    }));

    render(<BrowserSectionContent />);

    expect(await screen.findByText('Chrome Work')).toBeVisible();
    expect(await screen.findByText('Chrome Personal')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Never use browser pages' }).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Use default rule' })[0]);

    await waitFor(() => {
      expect(browserControlMocks.setPolicy).toHaveBeenLastCalledWith({
        permissions: {
          read: { mode: 'all', allowedPatterns: [] },
          write: { mode: 'all', allowedPatterns: [] },
          action: { mode: 'all', allowedPatterns: [] },
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
          {
            profileId: 'install:personal',
            permissions: {
              read: { mode: 'all', allowedPatterns: [] },
              write: { mode: 'all', allowedPatterns: [] },
              action: { mode: 'all', allowedPatterns: [] },
            },
          },
        ],
      });
    });
  });

  test('uses the enforceable install policy key for a joined local Chrome profile', async () => {
    const user = userEvent.setup();
    ipcMocks.showSelect.mockResolvedValue('deny');
    browserControlMocks.getStatus.mockResolvedValue({
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
          browserChannel: 'stable',
          profileName: 'Work',
          profilePath: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
          userDataDir: '/Users/test/Library/Application Support/Google/Chrome',
          extensionId: 'extension-work',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 0,
          windowCount: 1,
          tabCount: 3,
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 0,
    });
    browserControlMocks.setPolicy.mockImplementation(async (policy) => ({
      success: true,
      policy,
    }));

    render(<BrowserSectionContent />);

    expect(await screen.findByText('Chrome Work')).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();
    expect(screen.getByText('Path: /Users/test/Library/Application Support/Google/Chrome/Profile 1')).toBeVisible();

    await user.click(screen.getAllByRole('button', { name: 'Use default rule' })[0]);

    await waitFor(() => {
      expect(browserControlMocks.setPolicy).toHaveBeenCalledWith({
        permissions: {
          read: { mode: 'all', allowedPatterns: [] },
          write: { mode: 'all', allowedPatterns: [] },
          action: { mode: 'all', allowedPatterns: [] },
        },
        profilePolicies: [
          {
            profileId: 'install:work',
            permissions: {
              read: { mode: 'deny', allowedPatterns: [] },
              write: { mode: 'all', allowedPatterns: [] },
              action: { mode: 'all', allowedPatterns: [] },
            },
          },
        ],
      });
    });
  });

  test('lists local browser profiles without writing unenforceable profile rules', async () => {
    browserControlMocks.getStatus.mockResolvedValue({
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
          policyProfileId: null,
          browserName: 'chrome',
          browserChannel: 'stable',
          profileName: 'Personal',
          profilePath: '/Users/test/Library/Application Support/Google/Chrome/Default',
          userDataDir: '/Users/test/Library/Application Support/Google/Chrome',
          extensionId: null,
          stableKey: null,
          connectionState: 'detected',
          activeSessions: 0,
          windowCount: 0,
          tabCount: 0,
        },
      ],
      connectedBrowsers: 0,
      activeSessions: 0,
    });

    render(<BrowserSectionContent />);

    expect(await screen.findByText('Chrome Personal')).toBeVisible();
    expect(await screen.findByText('Detected')).toBeVisible();
    expect(await screen.findByText('Connect extension to set rules')).toBeVisible();
    expect(screen.getByText('Open this profile with the Interpreter extension before setting page permissions for it.')).toBeVisible();
    expect(browserControlMocks.setPolicy).not.toHaveBeenCalled();
  });
});
