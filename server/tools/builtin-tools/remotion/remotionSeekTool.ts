import type { BuiltinToolDefinition } from '../../builtinTools';
import { executeInStudio, resolveStudioOrError } from './studioControl';

function buildSeekScript(frame: number): string {
  return `(function() {
  var compositionId = window.remotion_seenCompositionIds && window.remotion_seenCompositionIds[0];
  if (!compositionId) return { success: false, error: 'No Remotion composition found' };
  if (typeof window.remotion_setFrame !== 'function') return { success: false, error: 'window.remotion_setFrame is not available' };
  window.remotion_setFrame(${frame}, compositionId);
  return { success: true, frame: ${frame}, compositionId: compositionId };
})()`;
}

// Extracts FPS from the Composition fiber props
const GET_FPS_SCRIPT = `(function() {
  var rootEl = document.getElementById('__remotion-studio-container');
  if (!rootEl) return null;
  var containerKey = Object.keys(rootEl).find(function(k) { return k.startsWith('__reactContainer'); });
  if (!containerKey) return null;
  var queue = [rootEl[containerKey] && rootEl[containerKey].child].filter(Boolean);
  var seen = new Set();
  while (queue.length) {
    var fiber = queue.shift();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    var props = fiber.memoizedProps;
    if (props && typeof props.fps === 'number' && typeof props.durationInFrames === 'number') return props.fps;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  return null;
})()`;

export const remotionSeekTool: BuiltinToolDefinition = {
  name: 'remotion_seek',
  description: 'Seek to a specific frame or time in a Remotion Studio viewer. Provide either a frame number or time in seconds (requires knowing the FPS — use remotion_get_state first).',
  inputSchema: {
    type: 'object',
    properties: {
      viewer_id: {
        type: 'string',
        description: 'The manifest file path (.remotion) identifying the viewer. Optional if only one studio is running.',
      },
      frame: {
        type: 'number',
        description: 'The frame number to seek to (0-indexed).',
      },
      time_seconds: {
        type: 'number',
        description: 'Time in seconds to seek to. Converted to a frame using the composition FPS. If both frame and time_seconds are given, frame takes priority.',
      },
    },
  },
  handler: async (args: Record<string, any>) => {
    try {
      const resolved = resolveStudioOrError(args);
      if ('error' in resolved) return resolved.error;
      const { viewerId } = resolved;

      let targetFrame: number | null = typeof args.frame === 'number' ? args.frame : null;

      if (targetFrame === null && typeof args.time_seconds === 'number') {
        const fps = await executeInStudio<number | null>(viewerId, GET_FPS_SCRIPT);
        if (!fps) {
          return { content: [{ type: 'text', text: 'Cannot convert time to frame: FPS not available. Use frame parameter instead.' }], isError: true };
        }
        targetFrame = Math.round(args.time_seconds * fps);
      }

      if (targetFrame === null || targetFrame < 0) {
        return { content: [{ type: 'text', text: 'Provide a valid frame number (>= 0) or time_seconds.' }], isError: true };
      }

      const result = await executeInStudio<{ success: boolean; frame?: number; compositionId?: string; error?: string }>(
        viewerId,
        buildSeekScript(targetFrame),
      );

      if (result.success) {
        return { content: [{ type: 'text', text: `Seeked to frame ${result.frame} in "${result.compositionId}"` }], isError: false };
      }
      return { content: [{ type: 'text', text: result.error || 'Seek failed' }], isError: true };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Failed to seek: ${error.message}` }], isError: true };
    }
  },
};
