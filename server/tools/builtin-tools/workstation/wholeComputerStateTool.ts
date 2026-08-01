import { agentTabManager } from '../../../agentTabManager';
import {
  getBrowserControlPageElementInventory,
  getBrowserControlStatus,
} from '../../../utils/browserExtensionRelay';
import { getBrowserAccessPolicy } from '../../../configStore';
import { getBrowserAccessPolicyWithGrants } from '../../../utils/browserAccessGrants';
import { getWindowSessionByKey, listWindowSessions } from '../../../utils/windowSessions';
import type { BuiltinToolDefinition } from '../../builtinTools';
import type { BrowserControlPageElementInventory, BrowserControlStatus } from '../../../../shared/types/browserControl';
import {
  BROWSER_ACCESS_PERMISSION_KINDS,
  doesBrowserAccessPolicyAllowUrl,
  type BrowserAccessPolicy,
} from '../../../../shared/browserAccessPolicy';
import { buildBrowserPageTargetIdentity } from './browserTargetIdentity';

let browserStatusProvider: () => Promise<BrowserControlStatus> = getBrowserControlStatus;
let browserAccessPolicyProvider: () => Promise<BrowserAccessPolicy> = getBrowserAccessPolicy;
let browserPageElementProvider: (input: {
  tabRef: string;
  maxElementsPerFrame?: number;
}) => Promise<BrowserControlPageElementInventory> = getBrowserControlPageElementInventory;

export function setWholeComputerStateBrowserStatusProviderForTest(
  provider: (() => Promise<BrowserControlStatus>) | null,
): void {
  browserStatusProvider = provider ?? getBrowserControlStatus;
}

export function setWholeComputerStateBrowserAccessPolicyProviderForTest(
  provider: (() => Promise<BrowserAccessPolicy>) | null,
): void {
  browserAccessPolicyProvider = provider ?? getBrowserAccessPolicy;
}

export function setWholeComputerStateBrowserPageElementProviderForTest(
  provider: ((input: {
    tabRef: string;
    maxElementsPerFrame?: number;
  }) => Promise<BrowserControlPageElementInventory>) | null,
): void {
  browserPageElementProvider = provider ?? getBrowserControlPageElementInventory;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in args)) {
    return undefined;
  }
  const value = args[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string or null.`);
  }
  return value;
}

function optionalPositiveIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  if (!(key in args)) {
    return defaultValue;
  }
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return Math.min(value, 100);
}

function sessionForBinding(windowSessionKey: string | null | undefined) {
  if (!windowSessionKey) {
    return null;
  }
  const session = getWindowSessionByKey(windowSessionKey);
  if (!session) {
    return null;
  }
  return {
    window_id: session.windowId,
    workspace_path: session.workspacePath,
    created_at: session.createdAt,
  };
}

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function getBoundedBrowserControlState(input: {
  maxBrowserTabs: number;
  browserTabRefForElements?: string | null;
  maxBrowserElements: number;
}) {
  const status = await browserStatusProvider();
  const browserAccessPolicy = getBrowserAccessPolicyWithGrants(await browserAccessPolicyProvider());
  const pageElements = input.browserTabRefForElements
    ? await browserPageElementProvider({
        tabRef: input.browserTabRefForElements,
        maxElementsPerFrame: input.maxBrowserElements,
      })
    : null;
  const profilesByPolicyId = new Map(
    status.profiles
      .filter((profile) => profile.policyProfileId)
      .map((profile) => [profile.policyProfileId!, profile]),
  );

  const browserTabs = status.connections.flatMap((connection) => {
    const profile = profilesByPolicyId.get(connection.profileId)
      ?? status.profiles.find((candidate) => candidate.profileId === connection.profileId)
      ?? null;
    const profilePolicyId = profile?.policyProfileId ?? connection.profileId;

    return connection.browserWindows.flatMap((browserWindow) => browserWindow.tabs.map((tab) => {
      const origin = originFromUrl(tab.url);
      const effectivePermissions = Object.fromEntries(
        BROWSER_ACCESS_PERMISSION_KINDS.map((permissionKind) => [
          permissionKind,
          doesBrowserAccessPolicyAllowUrl(browserAccessPolicy, tab.url, profilePolicyId, permissionKind),
        ]),
      ) as Record<typeof BROWSER_ACCESS_PERMISSION_KINDS[number], boolean>;
      return {
        kind: 'browser_tab',
        tab_ref: tab.tabRef,
        chrome_tab_id: tab.chromeTabId,
        browser_window_id: browserWindow.windowId,
        browser_window_focused: browserWindow.focused,
        browser_window_state: browserWindow.state,
        browser_window_type: browserWindow.type,
        browser_profile_id: profile?.profileId ?? connection.profileId,
        browser_profile_policy_id: profilePolicyId,
        browser_profile_name: profile?.profileName ?? null,
        browser_profile_path: profile?.profilePath || null,
        browser_name: profile?.browserName ?? connection.browserName,
        browser_channel: profile?.browserChannel ?? null,
        extension_stable_key: connection.stableKey,
        extension_install_state: profile?.connectionState ?? 'connected',
        index: tab.index,
        active: tab.active,
        highlighted: tab.highlighted,
        pinned: tab.pinned,
        title: tab.title,
        url: tab.url,
        origin,
        status: tab.status,
        control_state: tab.controlState,
        target_id: tab.targetId ?? null,
        permission_scope: {
          browser_profile_policy_id: profilePolicyId,
          origin,
          effective_permissions: effectivePermissions,
        },
        page_elements: pageElements?.tabRef === tab.tabRef
          ? {
              browser_profile_policy_id: pageElements.browserProfilePolicyId,
              origin: pageElements.origin,
              frames: pageElements.frames.map((frame) => ({
                frame_id: frame.frameId,
                chrome_document_id: frame.chromeDocumentId,
                url: frame.url,
                document_revision: frame.documentRevision,
                selection_text: frame.selectionText,
                viewport: frame.viewport,
                total_element_count: frame.totalElementCount,
                returned_element_count: frame.returnedElementCount,
                truncated_element_count: frame.truncatedElementCount,
                elements: frame.elements.map((element) => ({
                  ref_id: element.refId,
                  tab_ref: tab.tabRef,
                  chrome_tab_id: tab.chromeTabId,
                  browser_window_id: browserWindow.windowId,
                  browser_profile_policy_id: pageElements.browserProfilePolicyId,
                  origin: pageElements.origin,
                  frame_id: frame.frameId,
                  chrome_document_id: frame.chromeDocumentId,
                  document_revision: frame.documentRevision,
                  ref_lifetime: 'current_document_revision',
                  target_identity: buildBrowserPageTargetIdentity({
                    tabRef: tab.tabRef,
                    chromeTabId: tab.chromeTabId,
                    browserWindowId: browserWindow.windowId,
                    browserProfilePolicyId: pageElements.browserProfilePolicyId,
                    origin: pageElements.origin,
                    frameId: frame.frameId,
                    chromeDocumentId: frame.chromeDocumentId,
                    documentRevision: frame.documentRevision,
                    url: frame.url,
                  }),
                  viewport_scroll_x: frame.viewport.scrollX,
                  viewport_scroll_y: frame.viewport.scrollY,
                  index: element.index,
                  tag_name: element.tagName,
                  role: element.role,
                  name: element.name,
                  text: element.text,
                  value: element.value,
                  input_type: element.inputType,
                  checked: element.checked,
                  disabled: element.disabled,
                  editable: element.editable,
                  clickable: element.clickable,
                  bounds: element.bounds,
                })),
              })),
            }
          : null,
      };
    }));
  });

  return {
    relay: {
      phase: status.relay.phase,
      reachable: status.relay.reachable,
      version: status.relay.version,
      owns_relay_process: status.relay.ownsRelayProcess,
    },
    connected_browser_count: status.connectedBrowsers,
    active_session_count: status.activeSessions,
    profiles: status.profiles.map((profile) => ({
      browser_profile_id: profile.profileId,
      browser_profile_policy_id: profile.policyProfileId,
      browser_name: profile.browserName,
      browser_channel: profile.browserChannel,
      profile_name: profile.profileName,
      profile_path: profile.profilePath || null,
      extension_stable_key: profile.stableKey,
      extension_install_state: profile.connectionState,
      active_session_count: profile.activeSessions,
      window_count: profile.windowCount,
      tab_count: profile.tabCount,
    })),
    total_tab_count: browserTabs.length,
    returned_tab_count: Math.min(browserTabs.length, input.maxBrowserTabs),
    truncated_tab_count: Math.max(0, browserTabs.length - input.maxBrowserTabs),
    tabs: browserTabs.slice(0, input.maxBrowserTabs),
  };
}

export const wholeComputerStateGetTool: BuiltinToolDefinition = {
  name: 'interpreter_whole_computer_state_get',
  description:
    'Read bounded local Interpreter whole-computer state: known Interpreter windows, registered agent-window metadata, and browser-control profile/window/tab inventory. This read-only tool never returns caller tokens, prompts, full messages, attachments, or API keys.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_path: {
        type: ['string', 'null'],
        description: 'Optional exact workspace path filter.',
      },
      window_session_key: {
        type: ['string', 'null'],
        description: 'Optional exact Interpreter window session key filter.',
      },
      max_windows: {
        type: 'number',
        description: 'Maximum number of Interpreter and agent windows to return, capped at 100.',
      },
      max_browser_tabs: {
        type: 'number',
        description: 'Maximum number of browser-control tabs to return, capped at 100.',
      },
      browser_tab_ref_for_elements: {
        type: ['string', 'null'],
        description: 'Optional browser tab ref to inspect for bounded page element inventory.',
      },
      max_browser_elements: {
        type: 'number',
        description: 'Maximum number of page elements per frame to return for browser_tab_ref_for_elements, capped at 100.',
      },
    },
    required: [],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      const workspacePath = optionalStringArg(args, 'workspace_path');
      const windowSessionKey = optionalStringArg(args, 'window_session_key');
      const maxWindows = optionalPositiveIntegerArg(args, 'max_windows', 40);
      const maxBrowserTabs = optionalPositiveIntegerArg(args, 'max_browser_tabs', 40);
      const browserTabRefForElements = optionalStringArg(args, 'browser_tab_ref_for_elements');
      const maxBrowserElements = optionalPositiveIntegerArg(args, 'max_browser_elements', 80);

      const interpreterWindows = listWindowSessions()
        .filter((session) => {
          if (workspacePath !== undefined && session.workspacePath !== workspacePath) {
            return false;
          }
          if (windowSessionKey !== undefined && session.sessionKey !== windowSessionKey) {
            return false;
          }
          return true;
        })
        .map((session) => ({
          kind: 'interpreter_window',
          window_session_key: session.sessionKey,
          window_id: session.windowId,
          workspace_path: session.workspacePath,
          created_at: session.createdAt,
        }));

      const agentWindows = agentTabManager
        .listAgentWindowBindings({
          ...(workspacePath !== undefined ? { workspacePath } : {}),
          ...(windowSessionKey !== undefined ? { windowSessionKey } : {}),
        })
        .map((binding) => ({
          kind: 'agent_window',
          agent_id: binding.agentId,
          thread_id: binding.threadId ?? null,
          window_session_key: binding.windowSessionKey ?? null,
          workspace_path: binding.workspacePath ?? null,
          tool_profile_id: binding.toolProfileId ?? null,
          allowed_tool_names: binding.allowedToolNames ?? [],
          model: binding.model ?? null,
          activity: binding.activity
            ? {
              label: binding.activity.label,
              is_running: binding.activity.isRunning,
              message_count: binding.activity.messageCount,
              unread_count: binding.activity.unreadCount,
              last_message_preview: binding.activity.lastMessagePreview,
              updated_at: binding.activity.updatedAt,
            }
            : null,
          window: sessionForBinding(binding.windowSessionKey),
        }));

      const combinedWindows = [...interpreterWindows, ...agentWindows];
      const windows = combinedWindows.slice(0, maxWindows);
      const browserControl = await getBoundedBrowserControlState({
        maxBrowserTabs,
        browserTabRefForElements,
        maxBrowserElements,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            workspace_path_filter: workspacePath ?? null,
            window_session_key_filter: windowSessionKey ?? null,
            total_window_count: combinedWindows.length,
            returned_window_count: windows.length,
            truncated_window_count: Math.max(0, combinedWindows.length - windows.length),
            windows,
            browser_control: browserControl,
          }, null, 2),
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to read Interpreter whole-computer state: ${message}` }],
        isError: true,
      };
    }
  },
};
