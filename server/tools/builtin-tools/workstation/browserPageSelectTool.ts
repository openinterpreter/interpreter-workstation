import type { BrowserControlPageSelectResult } from '../../../../shared/types/browserControl';
import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  browserPageTargetIdentityInputSchema,
  parseBrowserPageTargetIdentityArg,
} from './browserTargetIdentity';
import {
  ensureBrowserExtensionRelayRunning,
  selectBrowserControlPageElement,
} from '../../../utils/browserExtensionRelay';
import type { BuiltinToolContext } from '../../builtinTools';
import { retryBrowserPageToolAfterPermissionApproval } from './browserPermissionReviewPrompt';

type BrowserPageSelectInput = {
  tabRef: string;
  frameId?: number;
  refId: string;
  value: string;
  durationMs?: number;
};

let browserPageSelectProvider: (input: BrowserPageSelectInput) => Promise<BrowserControlPageSelectResult> = selectBrowserControlPageElement;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserPageSelectProviderForTest(
  provider: ((input: BrowserPageSelectInput) => Promise<BrowserControlPageSelectResult>) | null,
): void {
  browserPageSelectProvider = provider ?? selectBrowserControlPageElement;
}

export function setBrowserPageSelectRelayEnsureProviderForTest(
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

export const browserPageSelectTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_page_select',
  description:
    'Select one exact option value in a current browser page select element ref inside an observed Chrome tab. Use target_identity and ref_id from interpreter_whole_computer_state_get page_elements or interpreter_browser_page_inspect output. The ref must still match the current page state.',
  inputSchema: {
    type: 'object',
    properties: {
      target_identity: browserPageTargetIdentityInputSchema,
      ref_id: {
        type: 'string',
        description: 'Select element ref from browser_control.tabs[].page_elements.frames[].elements[].ref_id.',
      },
      value: {
        type: 'string',
        description: 'Exact option value to choose on the select element.',
      },
      duration_ms: {
        type: 'number',
        description: 'Visual select feedback duration in milliseconds, from 100 to 10000.',
      },
    },
    required: ['target_identity', 'ref_id', 'value'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args, context?: BuiltinToolContext) => {
    let tabRef = '';
    let attemptedAction = 'Select browser page option.';
    try {
      const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
      tabRef = targetIdentity.tabRef;
      const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
      if (!refId) {
        throw new Error('ref_id must be a non-empty string.');
      }
      if (typeof args.value !== 'string') {
        throw new Error('value must be a string.');
      }
      attemptedAction = `Select value ${JSON.stringify(args.value)} on ref ${refId} in frame ${targetIdentity.frameId}.`;

      await browserRelayEnsureProvider();
      const result = await browserPageSelectProvider({
        tabRef,
        frameId: targetIdentity.frameId,
        refId,
        value: args.value,
        durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
      });

      return {
        content: [{
          type: 'text',
          text: `Selected browser page element ${result.refId} in ${result.tabRef} frame=${result.frameId} value=${JSON.stringify(result.value)}`,
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryResult = await retryBrowserPageToolAfterPermissionApproval({
        toolName: 'interpreter_browser_page_select',
        tabRef,
        message,
        attemptedAction,
        permissionKind: 'write',
        context,
      }, async () => {
        const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
        const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
        if (!refId) throw new Error('ref_id must be a non-empty string.');
        if (typeof args.value !== 'string') throw new Error('value must be a string.');
        return await browserPageSelectProvider({
          tabRef,
          frameId: targetIdentity.frameId,
          refId,
          value: args.value,
          durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
        });
      });
      if (retryResult) {
        return {
          content: [{
            type: 'text',
            text: `Selected browser page element ${retryResult.refId} in ${retryResult.tabRef} frame=${retryResult.frameId} value=${JSON.stringify(retryResult.value)}`,
          }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text', text: `Failed to select browser page element: ${message}` }],
        isError: true,
      };
    }
  },
};
