import type { BuiltinToolDefinition } from '../../builtinTools';
import { executeInStudio, resolveStudioOrError } from './studioControl';

const PAUSE_SCRIPT = `(function() {
  var playBtn = document.querySelector('button[aria-label="Play"]');
  if (playBtn) return 'Already paused';
  var pauseBtn = document.querySelector('button[aria-label="Pause"]');
  if (pauseBtn) { pauseBtn.click(); return 'Paused playback'; }
  return 'Pause button not found';
})()`;

export const remotionPauseTool: BuiltinToolDefinition = {
  name: 'remotion_pause',
  description: 'Pause playback in a Remotion Studio viewer. If already paused, does nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      viewer_id: {
        type: 'string',
        description: 'The manifest file path (.remotion) identifying the viewer. Optional if only one studio is running.',
      },
    },
  },
  handler: async (args: Record<string, any>) => {
    try {
      const resolved = resolveStudioOrError(args);
      if ('error' in resolved) return resolved.error;

      const result = await executeInStudio<string>(resolved.viewerId, PAUSE_SCRIPT);
      return { content: [{ type: 'text', text: result }], isError: false };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Failed to pause: ${error.message}` }], isError: true };
    }
  },
};
