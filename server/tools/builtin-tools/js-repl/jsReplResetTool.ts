import type { BuiltinToolDefinition } from '../../builtinTools';
import { jsReplKernelKey, resetJsReplKernel } from './kernelManager';

export const jsReplResetTool: BuiltinToolDefinition = {
  name: 'js_repl_reset',
  description: 'Restart the js_repl kernel for this thread and clear all persisted top-level bindings and globalThis state.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (_args, context) => {
    const hadKernel = resetJsReplKernel(jsReplKernelKey(context));
    return {
      content: [{
        type: 'text',
        text: hadKernel
          ? 'js_repl kernel reset; all top-level bindings were cleared.'
          : 'No running js_repl kernel for this thread; nothing to reset.',
      }],
      isError: false,
    };
  },
};
