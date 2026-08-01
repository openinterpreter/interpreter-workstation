import type { BrowserControlPageClickResult } from '../../../../shared/types/browserControl';
import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  browserPageTargetIdentityInputSchema,
  parseBrowserPageTargetIdentityArg,
} from './browserTargetIdentity';
import {
  clickBrowserControlPageElement,
  ensureBrowserExtensionRelayRunning,
} from '../../../utils/browserExtensionRelay';
import type { BuiltinToolContext } from '../../builtinTools';
import { retryBrowserPageToolAfterPermissionApproval } from './browserPermissionReviewPrompt';

type BrowserPageClickInput = {
  tabRef: string;
  frameId?: number;
  refId: string;
  durationMs?: number;
};

let browserPageClickProvider: (input: BrowserPageClickInput) => Promise<BrowserControlPageClickResult> = clickBrowserControlPageElement;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserPageClickProviderForTest(
  provider: ((input: BrowserPageClickInput) => Promise<BrowserControlPageClickResult>) | null,
): void {
  browserPageClickProvider = provider ?? clickBrowserControlPageElement;
}

export function setBrowserPageClickRelayEnsureProviderForTest(
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
  return value;
}

export const browserPageClickTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_page_click',
  description:
    'Click one current browser page element ref inside an observed Chrome tab. Use target_identity and ref_id from interpreter_whole_computer_state_get page_elements or interpreter_browser_page_inspect output. The ref must still match the current page state.',
  inputSchema: {
    type: 'object',
    properties: {
      target_identity: browserPageTargetIdentityInputSchema,
      ref_id: {
        type: 'string',
        description: 'Element ref from browser_control.tabs[].page_elements.frames[].elements[].ref_id.',
      },
      duration_ms: {
        type: 'number',
        description: 'Visual click feedback duration in milliseconds, from 100 to 10000.',
      },
    },
    required: ['target_identity', 'ref_id'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args, context?: BuiltinToolContext) => {
    let tabRef = '';
    let attemptedAction = 'Click browser page element.';
    try {
      const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
      tabRef = targetIdentity.tabRef;
      const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
      if (!refId) {
        throw new Error('ref_id must be a non-empty string.');
      }
      attemptedAction = `Click ref ${refId} in frame ${targetIdentity.frameId}.`;

      await browserRelayEnsureProvider();
      const result = await browserPageClickProvider({
        tabRef,
        frameId: targetIdentity.frameId,
        refId,
        durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
      });

      return {
        content: [{
          type: 'text',
          text: `Clicked browser page element ${result.refId} in ${result.tabRef} frame=${result.frameId}`,
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryResult = await retryBrowserPageToolAfterPermissionApproval({
        toolName: 'interpreter_browser_page_click',
        tabRef,
        message,
        attemptedAction,
        permissionKind: 'action',
        context,
      }, async () => {
        const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
        const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
        if (!refId) throw new Error('ref_id must be a non-empty string.');
        return await browserPageClickProvider({
          tabRef,
          frameId: targetIdentity.frameId,
          refId,
          durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
        });
      });
      if (retryResult) {
        return {
          content: [{
            type: 'text',
            text: `Clicked browser page element ${retryResult.refId} in ${retryResult.tabRef} frame=${retryResult.frameId}`,
          }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text', text: `Failed to click browser page element: ${message}` }],
        isError: true,
      };
    }
  },
};
