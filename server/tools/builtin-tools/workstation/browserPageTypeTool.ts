import type { BrowserControlPageTypeResult } from '../../../../shared/types/browserControl';
import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  browserPageTargetIdentityInputSchema,
  parseBrowserPageTargetIdentityArg,
} from './browserTargetIdentity';
import {
  ensureBrowserExtensionRelayRunning,
  typeBrowserControlPageElement,
} from '../../../utils/browserExtensionRelay';
import type { BuiltinToolContext } from '../../builtinTools';
import { retryBrowserPageToolAfterPermissionApproval } from './browserPermissionReviewPrompt';

type BrowserPageTypeInput = {
  tabRef: string;
  frameId?: number;
  refId: string;
  text: string;
  durationMs?: number;
};

let browserPageTypeProvider: (input: BrowserPageTypeInput) => Promise<BrowserControlPageTypeResult> = typeBrowserControlPageElement;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserPageTypeProviderForTest(
  provider: ((input: BrowserPageTypeInput) => Promise<BrowserControlPageTypeResult>) | null,
): void {
  browserPageTypeProvider = provider ?? typeBrowserControlPageElement;
}

export function setBrowserPageTypeRelayEnsureProviderForTest(
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

export const browserPageTypeTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_page_type',
  description:
    'Replace text in one current editable browser page element ref inside an observed Chrome tab. Use target_identity and ref_id from interpreter_whole_computer_state_get page_elements or interpreter_browser_page_inspect output. The ref must still match the current page state.',
  inputSchema: {
    type: 'object',
    properties: {
      target_identity: browserPageTargetIdentityInputSchema,
      ref_id: {
        type: 'string',
        description: 'Editable element ref from browser_control.tabs[].page_elements.frames[].elements[].ref_id.',
      },
      text: {
        type: 'string',
        description: 'Exact text to set on the editable browser element.',
      },
      duration_ms: {
        type: 'number',
        description: 'Visual input feedback duration in milliseconds, from 100 to 10000.',
      },
    },
    required: ['target_identity', 'ref_id', 'text'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args, context?: BuiltinToolContext) => {
    let tabRef = '';
    let attemptedAction = 'Type into browser page element.';
    try {
      const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
      tabRef = targetIdentity.tabRef;
      const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
      if (!refId) {
        throw new Error('ref_id must be a non-empty string.');
      }
      if (typeof args.text !== 'string') {
        throw new Error('text must be a string.');
      }
      attemptedAction = `Type ${JSON.stringify(args.text)} into ref ${refId} in frame ${targetIdentity.frameId}.`;

      await browserRelayEnsureProvider();
      const result = await browserPageTypeProvider({
        tabRef,
        frameId: targetIdentity.frameId,
        refId,
        text: args.text,
        durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
      });

      return {
        content: [{
          type: 'text',
          text: `Typed browser page element ${result.refId} in ${result.tabRef} frame=${result.frameId}`,
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryResult = await retryBrowserPageToolAfterPermissionApproval({
        toolName: 'interpreter_browser_page_type',
        tabRef,
        message,
        attemptedAction,
        permissionKind: 'write',
        context,
      }, async () => {
        const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
        const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
        if (!refId) throw new Error('ref_id must be a non-empty string.');
        if (typeof args.text !== 'string') throw new Error('text must be a string.');
        return await browserPageTypeProvider({
          tabRef,
          frameId: targetIdentity.frameId,
          refId,
          text: args.text,
          durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
        });
      });
      if (retryResult) {
        return {
          content: [{
            type: 'text',
            text: `Typed browser page element ${retryResult.refId} in ${retryResult.tabRef} frame=${retryResult.frameId}`,
          }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text', text: `Failed to type browser page element: ${message}` }],
        isError: true,
      };
    }
  },
};
