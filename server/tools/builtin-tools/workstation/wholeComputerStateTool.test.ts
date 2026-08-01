import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { agentTabManager } from '../../../agentTabManager';
import {
  registerWindowSession,
  unregisterWindowSession,
} from '../../../utils/windowSessions';
import { interpreterServerDefinition } from './index';
import {
  setWholeComputerStateBrowserAccessPolicyProviderForTest,
  setWholeComputerStateBrowserPageElementProviderForTest,
  setWholeComputerStateBrowserStatusProviderForTest,
  wholeComputerStateGetTool,
} from './wholeComputerStateTool';
import { buildBrowserPageTargetIdentity } from './browserTargetIdentity';
import type { BrowserControlStatus } from '../../../../shared/types/browserControl';

const registeredWindowIds = new Set<number>();

function emptyBrowserControlStatus(): BrowserControlStatus {
  return {
    relay: {
      phase: 'ready',
      version: null,
      runtimeDir: null,
      relayLogPath: null,
      relayCdpLogPath: null,
      ownsRelayProcess: false,
      lastError: null,
      reachable: true,
      endpoint: 'http://127.0.0.1:19988',
    },
    connections: [],
    profiles: [],
    connectedBrowsers: 0,
    activeSessions: 0,
  };
}

function registerTestWindow(input: {
  sessionKey: string;
  windowId: number;
  workspacePath: string | null;
}) {
  registeredWindowIds.add(input.windowId);
  return registerWindowSession(input);
}

function textFromResult(result: Awaited<ReturnType<typeof wholeComputerStateGetTool.handler>>): string {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  return String(first?.text ?? '');
}

describe('whole computer state tool', () => {
  beforeEach(() => {
    setWholeComputerStateBrowserAccessPolicyProviderForTest(async () => ({
      permissions: {
        read: { mode: 'all', allowedPatterns: [] },
        write: { mode: 'all', allowedPatterns: [] },
        action: { mode: 'all', allowedPatterns: [] },
      },
      profilePolicies: [],
    }));
    setWholeComputerStateBrowserStatusProviderForTest(async () => emptyBrowserControlStatus());
    setWholeComputerStateBrowserPageElementProviderForTest(async () => {
      throw new Error('Unexpected browser page element inventory request');
    });
  });

  afterEach(() => {
    agentTabManager.clearAll();
    for (const windowId of registeredWindowIds) {
      unregisterWindowSession(windowId);
    }
    registeredWindowIds.clear();
    setWholeComputerStateBrowserStatusProviderForTest(null);
    setWholeComputerStateBrowserAccessPolicyProviderForTest(null);
    setWholeComputerStateBrowserPageElementProviderForTest(null);
  });

  test('is exposed through the Interpreter builtin server', () => {
    expect(interpreterServerDefinition.tools.map((tool) => tool.name)).toContain('interpreter_whole_computer_state_get');
  });

  test('lists bounded Interpreter and agent-window state without internal secrets', async () => {
    registerTestWindow({
      sessionKey: 'window-main',
      windowId: 101,
      workspacePath: '/workspace/main',
    });
    agentTabManager.bindThread({
      agentId: 'agent-main',
      callerToken: 'agtok_whole_state_secret',
      threadId: 'thread-main',
      windowSessionKey: 'window-main',
      workspacePath: '/workspace/main',
      toolProfileId: 'profile-tools',
      allowedToolNames: [
        'builtin-agent-windows/send_agent_window_message',
        'builtin-agent-windows/reveal_agent_window',
        'builtin-agent-windows/await_agent_window',
      ],
      modelConfig: {
        provider: 'api',
        modelId: 'fast-model',
        profileId: 'profile-model',
        apiKey: 'secret-api-key',
      },
    });
    agentTabManager.reportAgentWindowActivity('agent-main', {
      label: 'Filling selected fields',
      isRunning: true,
      messageCount: 3,
      unreadCount: 1,
      lastMessagePreview: 'I found the submit button.',
      updatedAt: '2026-06-21T12:00:00.000Z',
    });

    const result = await wholeComputerStateGetTool.handler({});
    const text = textFromResult(result);
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.total_window_count).toBe(2);
    expect(payload.returned_window_count).toBe(2);
    expect(payload.truncated_window_count).toBe(0);
    expect(payload.windows).toEqual([
      {
        kind: 'interpreter_window',
        window_session_key: 'window-main',
        window_id: 101,
        workspace_path: '/workspace/main',
        created_at: expect.any(Number),
      },
      {
        kind: 'agent_window',
        agent_id: 'agent-main',
        thread_id: 'thread-main',
        window_session_key: 'window-main',
        workspace_path: '/workspace/main',
        tool_profile_id: 'profile-tools',
        allowed_tool_names: [
          'builtin-agent-windows/send_agent_window_message',
          'builtin-agent-windows/reveal_agent_window',
          'builtin-agent-windows/await_agent_window',
        ],
        model: {
          provider: 'api',
          modelId: 'fast-model',
          profileId: 'profile-model',
        },
        activity: {
          label: 'Filling selected fields',
          is_running: true,
          message_count: 3,
          unread_count: 1,
          last_message_preview: 'I found the submit button.',
          updated_at: '2026-06-21T12:00:00.000Z',
        },
        window: {
          window_id: 101,
          workspace_path: '/workspace/main',
          created_at: expect.any(Number),
        },
      },
    ]);
    expect(payload.browser_control).toEqual({
      relay: {
        phase: 'ready',
        reachable: true,
        version: null,
        owns_relay_process: false,
      },
      connected_browser_count: 0,
      active_session_count: 0,
      profiles: [],
      total_tab_count: 0,
      returned_tab_count: 0,
      truncated_tab_count: 0,
      tabs: [],
    });
    expect(text).not.toContain('agtok_whole_state_secret');
    expect(text).not.toContain('secret-api-key');
  });

  test('includes bounded browser-control profile and tab inventory', async () => {
    setWholeComputerStateBrowserAccessPolicyProviderForTest(async () => ({
      permissions: {
        read: { mode: 'all', allowedPatterns: [] },
        write: { mode: 'deny', allowedPatterns: [] },
        action: { mode: 'allowList', allowedPatterns: ['example.com/*'] },
      },
      profilePolicies: [],
    }));
    setWholeComputerStateBrowserStatusProviderForTest(async () => ({
      relay: {
        phase: 'ready',
        version: '2.0.0',
        runtimeDir: '/private/relay',
        relayLogPath: '/private/relay.log',
        relayCdpLogPath: '/private/relay-cdp.log',
        ownsRelayProcess: true,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:19988',
      },
      profiles: [
        {
          profileId: 'local:work',
          policyProfileId: 'install:work',
          browserName: 'Chrome',
          browserChannel: 'stable',
          profileName: 'Work',
          profilePath: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
          userDataDir: '/Users/test/Library/Application Support/Google/Chrome',
          extensionId: 'extension-work',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 1,
          windowCount: 1,
          tabCount: 2,
        },
      ],
      connections: [
        {
          extensionId: 'extension-work',
          stableKey: 'install:work',
          profileId: 'install:work',
          browserName: 'Chrome',
          version: '2.0.0',
          activeSessions: 1,
          targets: [],
          focusedWindowId: 10,
          activeTabRef: 'install:work:chrome-tab:20',
          focusedWindow: null,
          activeTab: null,
          browserWindows: [
            {
              windowId: 10,
              focused: true,
              type: 'normal',
              state: 'normal',
              tabs: [
                {
                  tabRef: 'install:work:chrome-tab:20',
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
                {
                  tabRef: 'install:work:chrome-tab:21',
                  chromeTabId: 21,
                  windowId: 10,
                  index: 1,
                  active: false,
                  highlighted: false,
                  pinned: false,
                  title: 'App',
                  url: 'https://app.example.test/',
                  status: 'complete',
                  controlState: 'controllable',
                  targetId: 'target-app',
                },
              ],
            },
          ],
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 1,
    }));

    const result = await wholeComputerStateGetTool.handler({ max_browser_tabs: 1 });
    const payload = JSON.parse(textFromResult(result));

    expect(result.isError).toBe(false);
    expect(payload.browser_control).toEqual({
      relay: {
        phase: 'ready',
        reachable: true,
        version: '2.0.0',
        owns_relay_process: true,
      },
      connected_browser_count: 1,
      active_session_count: 1,
      profiles: [
        {
          browser_profile_id: 'local:work',
          browser_profile_policy_id: 'install:work',
          browser_name: 'Chrome',
          browser_channel: 'stable',
          profile_name: 'Work',
          profile_path: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
          extension_stable_key: 'install:work',
          extension_install_state: 'connected',
          active_session_count: 1,
          window_count: 1,
          tab_count: 2,
        },
      ],
      total_tab_count: 2,
      returned_tab_count: 1,
      truncated_tab_count: 1,
      tabs: [
        {
          kind: 'browser_tab',
          tab_ref: 'install:work:chrome-tab:20',
          chrome_tab_id: 20,
          browser_window_id: 10,
          browser_window_focused: true,
          browser_window_state: 'normal',
          browser_window_type: 'normal',
          browser_profile_id: 'local:work',
          browser_profile_policy_id: 'install:work',
          browser_profile_name: 'Work',
          browser_profile_path: '/Users/test/Library/Application Support/Google/Chrome/Profile 1',
          browser_name: 'Chrome',
          browser_channel: 'stable',
          extension_stable_key: 'install:work',
          extension_install_state: 'connected',
          index: 0,
          active: true,
          highlighted: true,
          pinned: false,
          title: 'Docs',
          url: 'https://example.com/docs',
          origin: 'https://example.com',
          status: 'complete',
          control_state: 'observable',
          target_id: null,
          permission_scope: {
            browser_profile_policy_id: 'install:work',
            origin: 'https://example.com',
            effective_permissions: {
              read: true,
              write: false,
              action: true,
            },
          },
          page_elements: null,
        },
      ],
    });
    expect(textFromResult(result)).not.toContain('/private/relay');
  });

  test('includes bounded browser page element inventory for a requested tab ref', async () => {
    setWholeComputerStateBrowserStatusProviderForTest(async () => ({
      relay: {
        phase: 'ready',
        version: '2.0.0',
        runtimeDir: '/private/relay',
        relayLogPath: '/private/relay.log',
        relayCdpLogPath: '/private/relay-cdp.log',
        ownsRelayProcess: true,
        lastError: null,
        reachable: true,
        endpoint: 'http://127.0.0.1:19988',
      },
      profiles: [
        {
          profileId: 'local:work',
          policyProfileId: 'install:work',
          browserName: 'Chrome',
          browserChannel: 'stable',
          profileName: 'Work',
          profilePath: '/Users/test/Profile 1',
          userDataDir: '/Users/test',
          extensionId: 'extension-work',
          stableKey: 'install:work',
          connectionState: 'connected',
          activeSessions: 1,
          windowCount: 1,
          tabCount: 1,
        },
      ],
      connections: [
        {
          extensionId: 'extension-work',
          stableKey: 'install:work',
          profileId: 'install:work',
          browserName: 'Chrome',
          version: '2.0.0',
          activeSessions: 1,
          targets: [],
          focusedWindowId: 10,
          activeTabRef: 'install:work:chrome-tab:20',
          focusedWindow: null,
          activeTab: null,
          browserWindows: [
            {
              windowId: 10,
              focused: true,
              type: 'normal',
              state: 'normal',
              tabs: [
                {
                  tabRef: 'install:work:chrome-tab:20',
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
        },
      ],
      connectedBrowsers: 1,
      activeSessions: 1,
    }));
    setWholeComputerStateBrowserPageElementProviderForTest(async (input) => {
      expect(input).toEqual({
        tabRef: 'install:work:chrome-tab:20',
        maxElementsPerFrame: 2,
      });
      return {
        tabRef: input.tabRef,
        chromeTabId: 20,
        browserProfilePolicyId: 'install:work',
        origin: 'https://example.com',
        frames: [
          {
            frameId: 0,
            chromeDocumentId: 'document-1',
            url: 'https://example.com/docs',
            documentRevision: 'rev-1',
            viewport: {
              width: 1280,
              height: 720,
              scrollX: 0,
              scrollY: 50,
              devicePixelRatio: 2,
              screenBounds: null,
            },
            selectionText: 'Selected browser text',
            totalElementCount: 3,
            returnedElementCount: 2,
            truncatedElementCount: 1,
            elements: [
              {
                refId: 'browser-element:rev-1:0',
                index: 0,
                tagName: 'button',
                role: 'button',
                name: 'Save',
                text: 'Save',
                value: null,
                inputType: null,
                checked: null,
                disabled: false,
                editable: false,
                clickable: true,
                bounds: { x: 10, y: 20, width: 80, height: 32 },
              },
              {
                refId: 'browser-element:rev-1:1',
                index: 1,
                tagName: 'input',
                role: 'textbox',
                name: 'Email',
                text: '',
                value: 'person@example.com',
                inputType: 'email',
                checked: null,
                disabled: false,
                editable: true,
                clickable: true,
                bounds: { x: 20, y: 80, width: 240, height: 28 },
              },
            ],
          },
        ],
      };
    });

    const result = await wholeComputerStateGetTool.handler({
      browser_tab_ref_for_elements: 'install:work:chrome-tab:20',
      max_browser_elements: 2,
    });
    const text = textFromResult(result);
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.browser_control.tabs[0].permission_scope).toEqual({
      browser_profile_policy_id: 'install:work',
      origin: 'https://example.com',
      effective_permissions: {
        read: true,
        write: true,
        action: true,
      },
    });
    expect(payload.browser_control.tabs[0].page_elements).toEqual({
      browser_profile_policy_id: 'install:work',
      origin: 'https://example.com',
      frames: [
        {
          frame_id: 0,
          chrome_document_id: 'document-1',
          url: 'https://example.com/docs',
          document_revision: 'rev-1',
          viewport: {
            width: 1280,
            height: 720,
            scrollX: 0,
            scrollY: 50,
            devicePixelRatio: 2,
            screenBounds: null,
          },
          selection_text: 'Selected browser text',
          total_element_count: 3,
          returned_element_count: 2,
          truncated_element_count: 1,
          elements: [
            {
              ref_id: 'browser-element:rev-1:0',
              tab_ref: 'install:work:chrome-tab:20',
              chrome_tab_id: 20,
              browser_window_id: 10,
              browser_profile_policy_id: 'install:work',
              origin: 'https://example.com',
              frame_id: 0,
              chrome_document_id: 'document-1',
              document_revision: 'rev-1',
              ref_lifetime: 'current_document_revision',
              target_identity: buildBrowserPageTargetIdentity({
                tabRef: 'install:work:chrome-tab:20',
                chromeTabId: 20,
                browserWindowId: 10,
                browserProfilePolicyId: 'install:work',
                origin: 'https://example.com',
                frameId: 0,
                chromeDocumentId: 'document-1',
                documentRevision: 'rev-1',
                url: 'https://example.com/docs',
              }),
              viewport_scroll_x: 0,
              viewport_scroll_y: 50,
              index: 0,
              tag_name: 'button',
              role: 'button',
              name: 'Save',
              text: 'Save',
              value: null,
              input_type: null,
              checked: null,
              disabled: false,
              editable: false,
              clickable: true,
              bounds: { x: 10, y: 20, width: 80, height: 32 },
            },
            {
              ref_id: 'browser-element:rev-1:1',
              tab_ref: 'install:work:chrome-tab:20',
              chrome_tab_id: 20,
              browser_window_id: 10,
              browser_profile_policy_id: 'install:work',
              origin: 'https://example.com',
              frame_id: 0,
              chrome_document_id: 'document-1',
              document_revision: 'rev-1',
              ref_lifetime: 'current_document_revision',
              target_identity: buildBrowserPageTargetIdentity({
                tabRef: 'install:work:chrome-tab:20',
                chromeTabId: 20,
                browserWindowId: 10,
                browserProfilePolicyId: 'install:work',
                origin: 'https://example.com',
                frameId: 0,
                chromeDocumentId: 'document-1',
                documentRevision: 'rev-1',
                url: 'https://example.com/docs',
              }),
              viewport_scroll_x: 0,
              viewport_scroll_y: 50,
              index: 1,
              tag_name: 'input',
              role: 'textbox',
              name: 'Email',
              text: '',
              value: 'person@example.com',
              input_type: 'email',
              checked: null,
              disabled: false,
              editable: true,
              clickable: true,
              bounds: { x: 20, y: 80, width: 240, height: 28 },
            },
          ],
        },
      ],
    });
    expect(text).not.toContain('/private/relay');
  });

  test('filters by workspace and window session key', async () => {
    registerTestWindow({
      sessionKey: 'window-one',
      windowId: 101,
      workspacePath: '/workspace/one',
    });
    registerTestWindow({
      sessionKey: 'window-two',
      windowId: 202,
      workspacePath: '/workspace/two',
    });
    agentTabManager.bindThread({
      agentId: 'agent-one',
      callerToken: 'agtok_one',
      threadId: 'thread-one',
      windowSessionKey: 'window-one',
      workspacePath: '/workspace/one',
    });
    agentTabManager.bindThread({
      agentId: 'agent-two',
      callerToken: 'agtok_two',
      threadId: 'thread-two',
      windowSessionKey: 'window-two',
      workspacePath: '/workspace/two',
    });

    const result = await wholeComputerStateGetTool.handler({
      workspace_path: '/workspace/two',
      window_session_key: 'window-two',
    });
    const payload = JSON.parse(textFromResult(result));

    expect(result.isError).toBe(false);
    expect(payload.windows.map((windowState: any) => windowState.window_session_key)).toEqual([
      'window-two',
      'window-two',
    ]);
    expect(payload.windows.map((windowState: any) => windowState.workspace_path)).toEqual([
      '/workspace/two',
      '/workspace/two',
    ]);
  });

  test('caps returned window state and reports truncation', async () => {
    for (let index = 0; index < 5; index += 1) {
      registerTestWindow({
        sessionKey: `window-${index}`,
        windowId: 100 + index,
        workspacePath: '/workspace/main',
      });
    }

    const result = await wholeComputerStateGetTool.handler({ max_windows: 3 });
    const payload = JSON.parse(textFromResult(result));

    expect(result.isError).toBe(false);
    expect(payload.total_window_count).toBe(5);
    expect(payload.returned_window_count).toBe(3);
    expect(payload.truncated_window_count).toBe(2);
    expect(payload.windows.map((windowState: any) => windowState.window_session_key)).toEqual([
      'window-0',
      'window-1',
      'window-2',
    ]);
  });

  test('fails loudly when optional arguments are malformed', async () => {
    const result = await wholeComputerStateGetTool.handler({ max_windows: 0 });

    expect(result.isError).toBe(true);
    expect(textFromResult(result)).toBe(
      'Failed to read Interpreter whole-computer state: max_windows must be a positive integer.',
    );
  });
});
