import type { BuiltinToolDefinition } from '../../builtinTools';
import { executeInStudio, resolveStudioOrError } from './studioControl';

export const remotionExecJsTool: BuiltinToolDefinition = {
  name: 'remotion_exec_js',
  description: `Execute arbitrary JavaScript in the Remotion Studio iframe context. You have full access to the DOM, window, and any globals available in the Studio environment. The return value of your script is sent back as the result (must be JSON-serializable).

Confirmed working APIs:
- Set frame: window.remotion_setFrame(frameNumber, compositionId)
- Get composition ID: window.remotion_seenCompositionIds?.[0]
- Read current frame from UI: document.querySelector('button.__remotion_input_dragger span')?.textContent
- Read timecode from UI: Array.from(document.querySelectorAll('div')).find(el => /^\\d\\d:\\d\\d\\.\\d\\d$/.test((el.textContent||'').trim()))?.textContent

You can also click buttons, read DOM state, or run any JS. Wrap complex logic in an IIFE: "(function() { ... })()"
Discover more: Object.keys(window).filter(k => k.includes('remotion'))`,
  inputSchema: {
    type: 'object',
    properties: {
      viewer_id: {
        type: 'string',
        description:
          'The manifest file path (.remotion) identifying the viewer. Optional if only one studio is running.',
      },
      script: {
        type: 'string',
        description:
          'JavaScript code to execute in the Remotion Studio iframe. The return value is sent back as the result.',
      },
    },
    required: ['script'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const resolved = resolveStudioOrError(args);
      if ('error' in resolved) return resolved.error;

      const script = args.script as string;
      const result = await executeInStudio<unknown>(resolved.viewerId, script);

      const text =
        result === undefined ? '(no return value)' : JSON.stringify(result, null, 2);

      return { content: [{ type: 'text', text }], isError: false };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Execution failed: ${error.message}` }],
        isError: true,
      };
    }
  },
};
