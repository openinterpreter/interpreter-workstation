import type { BrowserControlPageElementInventory } from '../../../../shared/types/browserControl';
import type { BuiltinToolContext, BuiltinToolDefinition } from '../../builtinTools';
import {
  ensureBrowserExtensionRelayRunning,
  getBrowserControlPageElementInventory,
} from '../../../utils/browserExtensionRelay';
import { retryBrowserPageToolAfterPermissionApproval } from './browserPermissionReviewPrompt';
import { buildBrowserPageTargetIdentity } from './browserTargetIdentity';

type BrowserPageInspectInput = {
  tabRef: string;
  maxElementsPerFrame?: number;
};

let browserPageInspectProvider: (input: BrowserPageInspectInput) => Promise<BrowserControlPageElementInventory> = getBrowserControlPageElementInventory;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserPageInspectProviderForTest(
  provider: ((input: BrowserPageInspectInput) => Promise<BrowserControlPageElementInventory>) | null,
): void {
  browserPageInspectProvider = provider ?? getBrowserControlPageElementInventory;
}

export function setBrowserPageInspectRelayEnsureProviderForTest(
  provider: (() => Promise<void>) | null,
): void {
  browserRelayEnsureProvider = provider ?? ensureBrowserExtensionRelayRunning;
}

function positiveIntegerFromArg(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Math.min(value, 100);
}

function renderBrowserPageInspectResult(result: BrowserControlPageElementInventory) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        tab_ref: result.tabRef,
        chrome_tab_id: result.chromeTabId,
        browser_profile_policy_id: result.browserProfilePolicyId,
        origin: result.origin,
        frames: result.frames.map((frame) => ({
          frame_id: frame.frameId,
          chrome_document_id: frame.chromeDocumentId,
          url: frame.url,
          document_revision: frame.documentRevision,
          viewport: frame.viewport,
          total_element_count: frame.totalElementCount,
          returned_element_count: frame.returnedElementCount,
          truncated_element_count: frame.truncatedElementCount,
          elements: frame.elements.map((element) => ({
            ref_id: element.refId,
            tab_ref: result.tabRef,
            chrome_tab_id: result.chromeTabId,
            browser_profile_policy_id: result.browserProfilePolicyId,
            origin: result.origin,
            frame_id: frame.frameId,
            chrome_document_id: frame.chromeDocumentId,
            document_revision: frame.documentRevision,
            ref_lifetime: 'current_document_revision',
            target_identity: buildBrowserPageTargetIdentity({
              tabRef: result.tabRef,
              chromeTabId: result.chromeTabId,
              browserWindowId: null,
              browserProfilePolicyId: result.browserProfilePolicyId,
              origin: result.origin,
              frameId: frame.frameId,
              chromeDocumentId: frame.chromeDocumentId,
              documentRevision: frame.documentRevision,
              url: frame.url,
            }),
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
      }),
    }],
    isError: false,
  };
}

export const browserPageInspectTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_page_inspect',
  description:
    'Inspect one observed Chrome tab and return bounded browser page frame and element refs. Use tab_ref from interpreter_whole_computer_state_get browser_control.tabs[].tab_ref. This is read-only and does not claim Playwright control.',
  inputSchema: {
    type: 'object',
    properties: {
      tab_ref: {
        type: 'string',
        description: 'Stable browser tab ref from interpreter_whole_computer_state_get browser_control.tabs[].tab_ref.',
      },
      max_elements_per_frame: {
        type: 'number',
        description: 'Maximum number of element refs to return per frame. Defaults to the relay limit and is capped at 100.',
      },
    },
    required: ['tab_ref'],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args, context?: BuiltinToolContext) => {
    let tabRef = '';
    let attemptedAction = 'Inspect browser page elements.';
    try {
      tabRef = typeof args.tab_ref === 'string' ? args.tab_ref.trim() : '';
      if (!tabRef) {
        throw new Error('tab_ref must be a non-empty string.');
      }
      const maxElementsPerFrame = positiveIntegerFromArg(args.max_elements_per_frame, 'max_elements_per_frame');
      attemptedAction = maxElementsPerFrame
        ? `Inspect page elements with max_elements_per_frame=${maxElementsPerFrame}.`
        : 'Inspect page elements.';

      await browserRelayEnsureProvider();
      const result = await browserPageInspectProvider({
        tabRef,
        maxElementsPerFrame,
      });

      return renderBrowserPageInspectResult(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryResult = await retryBrowserPageToolAfterPermissionApproval({
        toolName: 'interpreter_browser_page_inspect',
        tabRef,
        message,
        attemptedAction,
        permissionKind: 'read',
        context,
      }, async () => browserPageInspectProvider({
        tabRef,
        maxElementsPerFrame: positiveIntegerFromArg(args.max_elements_per_frame, 'max_elements_per_frame'),
      }));
      if (retryResult) {
        return renderBrowserPageInspectResult(retryResult);
      }
      return {
        content: [{ type: 'text', text: `Failed to inspect browser page: ${message}` }],
        isError: true,
      };
    }
  },
};
