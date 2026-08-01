import type { BrowserControlPageElementBounds, BrowserControlPageTraceResult } from '../../../../shared/types/browserControl';
import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  browserPageTargetIdentityInputSchema,
  parseBrowserPageTargetIdentityArg,
} from './browserTargetIdentity';
import {
  drawBrowserControlPageTrace,
  ensureBrowserExtensionRelayRunning,
} from '../../../utils/browserExtensionRelay';
import type { BuiltinToolContext } from '../../builtinTools';
import { retryBrowserPageToolAfterPermissionApproval } from './browserPermissionReviewPrompt';

type BrowserPageTraceInput = {
  tabRef: string;
  frameId?: number;
  refId?: string;
  bounds?: BrowserControlPageElementBounds;
  durationMs?: number;
};

let browserPageTraceProvider: (input: BrowserPageTraceInput) => Promise<BrowserControlPageTraceResult> = drawBrowserControlPageTrace;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserPageTraceProviderForTest(
  provider: ((input: BrowserPageTraceInput) => Promise<BrowserControlPageTraceResult>) | null,
): void {
  browserPageTraceProvider = provider ?? drawBrowserControlPageTrace;
}

export function setBrowserPageTraceRelayEnsureProviderForTest(
  provider: (() => Promise<void>) | null,
): void {
  browserRelayEnsureProvider = provider ?? ensureBrowserExtensionRelayRunning;
}

function numberFromArg(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
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

function boundsFromArg(value: unknown): BrowserControlPageElementBounds | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    throw new Error('bounds must be an object.');
  }
  const record = value as Record<string, unknown>;
  const x = numberFromArg(record.x, 'bounds.x');
  const y = numberFromArg(record.y, 'bounds.y');
  const width = numberFromArg(record.width, 'bounds.width');
  const height = numberFromArg(record.height, 'bounds.height');
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error('bounds must include x, y, width, and height.');
  }
  if (width <= 0 || height <= 0) {
    throw new Error('bounds.width and bounds.height must be positive.');
  }
  return { x, y, width, height };
}

export const browserPageTraceTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_page_trace',
  description:
    'Draw a short-lived visual trace inside an observed Chrome tab. Use target_identity plus ref_id from interpreter_whole_computer_state_get page_elements or interpreter_browser_page_inspect output, or pass explicit bounds from the same browser page target.',
  inputSchema: {
    type: 'object',
    properties: {
      target_identity: browserPageTargetIdentityInputSchema,
      ref_id: {
        type: 'string',
        description: 'Element ref from browser_control.tabs[].page_elements.frames[].elements[].ref_id.',
      },
      bounds: {
        type: 'object',
        description: 'Viewport-relative bounds from the same browser tab context when no ref_id is available.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      duration_ms: {
        type: 'number',
        description: 'Trace duration in milliseconds, from 100 to 10000.',
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
    let attemptedAction = 'Draw browser page trace.';
    try {
      const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
      tabRef = targetIdentity.tabRef;
      const refId = typeof args.ref_id === 'string' && args.ref_id.trim().length > 0
        ? args.ref_id.trim()
        : undefined;
      const bounds = boundsFromArg(args.bounds);
      if (!refId && !bounds) {
        throw new Error('ref_id or bounds is required.');
      }
      attemptedAction = refId
        ? `Draw trace around ref ${refId} in frame ${targetIdentity.frameId}.`
        : `Draw trace around bounds x=${bounds!.x} y=${bounds!.y} width=${bounds!.width} height=${bounds!.height}.`;

      await browserRelayEnsureProvider();
      const result = await browserPageTraceProvider({
        tabRef,
        frameId: targetIdentity.frameId,
        refId,
        bounds,
        durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
      });

      return {
        content: [{
          type: 'text',
          text: `Drew browser page trace for ${result.tabRef} frame=${result.frameId} ref=${result.refId ?? 'bounds'}`,
        }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const retryResult = await retryBrowserPageToolAfterPermissionApproval({
        toolName: 'interpreter_browser_page_trace',
        tabRef,
        message,
        attemptedAction,
        permissionKind: 'action',
        context,
      }, async () => {
        const targetIdentity = parseBrowserPageTargetIdentityArg(args.target_identity);
        const refId = typeof args.ref_id === 'string' && args.ref_id.trim().length > 0
          ? args.ref_id.trim()
          : undefined;
        const bounds = boundsFromArg(args.bounds);
        if (!refId && !bounds) {
          throw new Error('ref_id or bounds is required.');
        }
        return await browserPageTraceProvider({
          tabRef,
          frameId: targetIdentity.frameId,
          refId,
          bounds,
          durationMs: positiveIntegerFromArg(args.duration_ms, 'duration_ms'),
        });
      });
      if (retryResult) {
        return {
          content: [{
            type: 'text',
            text: `Drew browser page trace for ${retryResult.tabRef} frame=${retryResult.frameId} ref=${retryResult.refId ?? 'bounds'}`,
          }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text', text: `Failed to draw browser page trace: ${message}` }],
        isError: true,
      };
    }
  },
};
