import type { BuiltinToolDefinition } from '../../builtinTools';
import { executeInStudio, resolveStudioOrError } from './studioControl';

const PLAY_SCRIPT = `(function() {
  var pauseBtn = document.querySelector('button[aria-label="Pause"]');
  if (pauseBtn) return 'Already playing';
  var playBtn = document.querySelector('button[aria-label="Play"]');
  if (playBtn) { playBtn.click(); return 'Started playback'; }
  return 'Play button not found';
})()`;

export const remotionPlayTool: BuiltinToolDefinition = {
  name: 'remotion_play',
  description: 'Start playback in a Remotion Studio viewer. If already playing, does nothing.',
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

      const result = await executeInStudio<string>(resolved.viewerId, PLAY_SCRIPT);
      return { content: [{ type: 'text', text: result }], isError: false };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Failed to play: ${error.message}` }], isError: true };
    }
  },
};
