import type { BrowserControlPageScrollResult } from '../../../../shared/types/browserControl';
import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  browserPageTargetIdentityInputSchema,
  parseBrowserPageTargetIdentityArg,
} from './browserTargetIdentity';
import {
  ensureBrowserExtensionRelayRunning,
  scrollBrowserControlPage,
} from '../../../utils/browserExtensionRelay';
import type { BuiltinToolContext } from '../../builtinTools';
import { retryBrowserPageToolAfterPermissionApproval } from './browserPermissionReviewPrompt';

type BrowserPageScrollInput = {
  tabRef: string;
  frameId?: number;
  refId?: string;
  deltaX?: number;
  deltaY?: number;
};

let browserPageScrollProvider: (input: BrowserPageScrollInput) => Promise<BrowserControlPageScrollResult> = scrollBrowserControlPage;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserPageScrollProviderForTest(
  provider: ((input: BrowserPageScrollInput) => Promise<BrowserControlPageScrollResult>) | null,
): void {
  browserPageScrollProvider = provider ?? scrollBrowserControlPage;
}

export function setBrowserPageScrollRelayEnsureProviderForTest(
  provider: (() => Promise<void>) | null,
): void {
  browserRelayEnsureProvider = provider ?? ensureBrowserExtensionRelayRunning;
}

function finiteNumberFromArg(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

export const browserPageScrollTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_page_scroll',
  description:
    'Scroll one current browser page frame inside an observed Chrome tab. Use target_identity from interpreter_whole_computer_state_get page_elements or interpreter_browser_page_inspect output. Provide delta_x or delta_y in CSS pixels.',
  inputSchema: {
    type: 'object',
    properties: {
      target_identity: browserPageTargetIdentityInputSchema,
      ref_id: {
        type: 'string',
        description: 'Optional element ref from browser page inventory. When provided, scrolls the nearest scrollable ancestor for that ref.',
      },
      delta_x: {
        type: 'number',
        description: 'Horizontal scroll delta in CSS pixels.',
      },
      delta_y: {
        type: 'number',
        description: 'Vertical scroll delta in CSS pixels.',
      },
    },
    required: ['target_identity'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args, context?: BuiltinToolContext) => {
    let tabRef = '';
    let attemptedAction = 'Scroll browser page.';
    try {
      const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
      tabRef = targetIdentity.tabRef;
      const deltaX = finiteNumberFromArg(args.delta_x, 'delta_x') ?? 0;
      const deltaY = finiteNumberFromArg(args.delta_y, 'delta_y') ?? 0;
      if (deltaX === 0 && deltaY === 0) {
        throw new Error('delta_x or delta_y must be non-zero.');
      }
      const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
      attemptedAction = refId
        ? `Scroll ref ${refId} in frame ${targetIdentity.frameId} by delta_x=${deltaX} delta_y=${deltaY}.`
        : `Scroll frame ${targetIdentity.frameId} by delta_x=${deltaX} delta_y=${deltaY}.`;

      await browserRelayEnsureProvider();
      const result = await browserPageScrollProvider({
        tabRef,
        frameId: targetIdentity.frameId,
        refId: refId || undefined,
        deltaX,
        deltaY,
      });

      return {
        content: [{
          type: 'text',
          text: result.refId
            ? `Scrolled browser page element ${result.refId} in ${result.tabRef} frame=${result.frameId} to x=${result.scrollX} y=${result.scrollY}`
            : `Scrolled browser page ${result.tabRef} frame=${result.frameId} to x=${result.scrollX} y=${result.scrollY}`,
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryResult = await retryBrowserPageToolAfterPermissionApproval({
        toolName: 'interpreter_browser_page_scroll',
        tabRef,
        message,
        attemptedAction,
        permissionKind: 'action',
        context,
      }, async () => {
        const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
        const deltaX = finiteNumberFromArg(args.delta_x, 'delta_x') ?? 0;
        const deltaY = finiteNumberFromArg(args.delta_y, 'delta_y') ?? 0;
        if (deltaX === 0 && deltaY === 0) {
          throw new Error('delta_x or delta_y must be non-zero.');
        }
        const refId = typeof args.ref_id === 'string' ? args.ref_id.trim() : '';
        return await browserPageScrollProvider({
          tabRef,
          frameId: targetIdentity.frameId,
          refId: refId || undefined,
          deltaX,
          deltaY,
        });
      });
      if (retryResult) {
        return {
          content: [{
            type: 'text',
            text: retryResult.refId
              ? `Scrolled browser page element ${retryResult.refId} in ${retryResult.tabRef} frame=${retryResult.frameId} to x=${retryResult.scrollX} y=${retryResult.scrollY}`
              : `Scrolled browser page ${retryResult.tabRef} frame=${retryResult.frameId} to x=${retryResult.scrollX} y=${retryResult.scrollY}`,
          }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text', text: `Failed to scroll browser page: ${message}` }],
        isError: true,
      };
    }
  },
};
