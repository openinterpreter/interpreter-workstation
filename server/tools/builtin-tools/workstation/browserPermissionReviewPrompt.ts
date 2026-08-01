import type { ToolName } from '../../../../shared/toolMetadata';
import {
  getBrowserAccessProfilePolicy,
  normalizeBrowserAccessPolicy,
  type BrowserAccessPermissionKind,
  type BrowserAccessPolicyMode,
} from '../../../../shared/browserAccessPolicy';
import { approvalManager } from '../../../approvalManager';
import { getBrowserAccessPolicy } from '../../../configStore';
import {
  addBrowserAccessSessionGrant,
  withTemporaryBrowserAccessGrant,
  type BrowserAccessGrant,
} from '../../../utils/browserAccessGrants';
import { getBrowserControlStatus } from '../../../utils/browserExtensionRelay';
import type { BuiltinToolContext } from '../../builtinTools';

const BROWSER_POLICY_DENIAL_PREFIX = 'Interpreter browser settings blocked this request.';

type BrowserPermissionReviewPromptInput = {
  toolName: ToolName;
  tabRef: string;
  message: string;
  attemptedAction: string;
  permissionKind: BrowserAccessPermissionKind;
  context?: BuiltinToolContext;
};

type BrowserPermissionReviewPromptResult =
  | { approved: true; grant: BrowserAccessGrant }
  | { approved: false };

type BrowserPermissionReviewPromptProvider = (input: BrowserPermissionReviewPromptInput) => Promise<BrowserPermissionReviewPromptResult>;

let browserPermissionReviewPromptProvider: BrowserPermissionReviewPromptProvider = requestBrowserPermissionReviewPrompt;

export function setBrowserPermissionReviewPromptProviderForTest(
  provider: BrowserPermissionReviewPromptProvider | null,
): void {
  browserPermissionReviewPromptProvider = provider ?? requestBrowserPermissionReviewPrompt;
}

export function isBrowserPolicyDenialMessage(message: string): boolean {
  return message.includes(BROWSER_POLICY_DENIAL_PREFIX);
}

export async function requestBrowserPermissionReviewForDeniedTool(
  input: BrowserPermissionReviewPromptInput,
): Promise<BrowserPermissionReviewPromptResult> {
  if (!input.tabRef || !isBrowserPolicyDenialMessage(input.message)) {
    return { approved: false };
  }

  return await browserPermissionReviewPromptProvider(input);
}

function browserAccessPolicyModeForProfile(
  policy: Awaited<ReturnType<typeof getBrowserAccessPolicy>>,
  profileId: string,
  permissionKind: BrowserAccessPermissionKind,
): BrowserAccessPolicyMode {
  const normalizedPolicy = normalizeBrowserAccessPolicy(policy);
  const profilePolicy = getBrowserAccessProfilePolicy(normalizedPolicy, profileId);
  return (profilePolicy?.permissions ?? normalizedPolicy.permissions)[permissionKind].mode;
}

async function findBrowserTab(tabRef: string): Promise<{
  title?: string;
  url?: string;
  profileId: string;
  origin: string | null;
} | null> {
  const status = await getBrowserControlStatus();
  for (const connection of status.connections) {
    for (const browserWindow of connection.browserWindows) {
      const tab = browserWindow.tabs.find((candidate) => candidate.tabRef === tabRef);
      if (tab) {
        return {
          title: tab.title || undefined,
          url: tab.url || undefined,
          profileId: connection.profileId,
          origin: originFromUrl(tab.url),
        };
      }
    }
  }
  return null;
}

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function requestBrowserPermissionReviewPrompt(
  input: BrowserPermissionReviewPromptInput,
): Promise<BrowserPermissionReviewPromptResult> {
  const tab = await findBrowserTab(input.tabRef);
  if (!tab?.origin) {
    return { approved: false };
  }

  const policy = await getBrowserAccessPolicy();
  if (browserAccessPolicyModeForProfile(policy, tab.profileId, input.permissionKind) !== 'ask') {
    return { approved: false };
  }

  const grant = {
    profileId: tab.profileId,
    origin: tab.origin,
    permissionKind: input.permissionKind,
  };
  const approval = await approvalManager.createSessionAwareApproval(
    input.toolName,
    'builtin-interpreter',
    {
      message: 'Browser permission needed',
      description: input.message,
      permissionCard: {
        version: 1,
        intent: 'browser-permission',
        risk: 'medium',
        blocks: [
          {
            type: 'text',
            text: 'Interpreter needs approval before using this browser tab.',
          },
          {
            type: 'list',
            items: [
              {
                label: 'Attempted action',
                description: input.attemptedAction,
              },
              {
                label: 'Scope',
                description: `${input.permissionKind} access for ${tab.origin} in this browser profile.`,
              },
            ],
          },
          {
            type: 'browser-tab',
            title: tab?.title || 'Browser tab',
            url: tab?.url,
            tabRef: input.tabRef,
            description: 'Show the tab to review it before approving.',
          },
        ],
      },
    },
    'Browser settings require approval before this page can be used.',
    0,
    input.context?.toolCallId,
    input.context?.agentId,
  );

  if (!approval.approved) {
    return { approved: false };
  }

  if (approval.mode === 'session') {
    addBrowserAccessSessionGrant(grant);
  }

  return {
    approved: true,
    grant,
  };
}

export async function retryBrowserPageToolAfterPermissionApproval<T>(
  input: BrowserPermissionReviewPromptInput,
  retry: () => Promise<T>,
): Promise<T | null> {
  const approval = await requestBrowserPermissionReviewForDeniedTool(input);
  if (!approval.approved) {
    return null;
  }
  return await withTemporaryBrowserAccessGrant(
    approval.grant,
    retry,
  );
}
