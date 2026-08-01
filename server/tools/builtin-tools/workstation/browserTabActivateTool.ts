import type { BuiltinToolDefinition } from '../../builtinTools';
import {
  activateBrowserControlTab,
  ensureBrowserExtensionRelayRunning,
} from '../../../utils/browserExtensionRelay';

let browserTabActivationProvider: (input: { tabRef: string }) => Promise<{ success: true }> = activateBrowserControlTab;
let browserRelayEnsureProvider: () => Promise<void> = ensureBrowserExtensionRelayRunning;

export function setBrowserTabActivationProviderForTest(
  provider: ((input: { tabRef: string }) => Promise<{ success: true }>) | null,
): void {
  browserTabActivationProvider = provider ?? activateBrowserControlTab;
}

export function setBrowserRelayEnsureProviderForTest(
  provider: (() => Promise<void>) | null,
): void {
  browserRelayEnsureProvider = provider ?? ensureBrowserExtensionRelayRunning;
}

export const browserTabActivateTool: BuiltinToolDefinition = {
  name: 'interpreter_browser_tab_activate',
  description:
    'Activate and focus an observed Chrome browser tab by tab_ref from interpreter_whole_computer_state_get. This does not inspect page content or grant page-control permission.',
  inputSchema: {
    type: 'object',
    properties: {
      tab_ref: {
        type: 'string',
        description: 'Stable browser tab ref from interpreter_whole_computer_state_get browser_control.tabs[].tab_ref.',
      },
    },
    required: ['tab_ref'],
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
  handler: async (args) => {
    try {
      const tabRef = typeof args.tab_ref === 'string' ? args.tab_ref.trim() : '';
      if (!tabRef) {
        throw new Error('tab_ref must be a non-empty string.');
      }

      await browserRelayEnsureProvider();
      await browserTabActivationProvider({ tabRef });

      return {
        content: [{ type: 'text', text: `Activated browser tab ${tabRef}` }],
        isError: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to activate browser tab: ${message}` }],
        isError: true,
      };
    }
  },
};
