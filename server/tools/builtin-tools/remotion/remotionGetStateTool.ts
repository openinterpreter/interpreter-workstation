import type { BuiltinToolDefinition } from '../../builtinTools';
import { executeInStudio, resolveStudioOrError } from './studioControl';

const GET_STATE_SCRIPT = `(function() {
  var rootEl = document.getElementById('__remotion-studio-container');
  if (!rootEl) return { error: 'Remotion Studio container not found' };

  var containerKey = Object.keys(rootEl).find(function(k) { return k.startsWith('__reactContainer'); });
  if (!containerKey) return { error: 'React root not found on Studio container' };

  var root = rootEl[containerKey];

  function findFiber(predicate) {
    var queue = [root && root.child].filter(Boolean);
    var seen = new Set();
    while (queue.length) {
      var fiber = queue.shift();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      var name = (fiber.type && fiber.type.name) || (fiber.elementType && fiber.elementType.name) || null;
      if (predicate(fiber, name)) return fiber;
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
  }

  // Get playback state from TimelineContextProvider
  var timelineFiber = findFiber(function(_, name) { return name === 'TimelineContextProvider'; });
  var playback = null;
  if (timelineFiber) {
    var hook = timelineFiber.memoizedState;
    while (hook) {
      var ms = hook.memoizedState;
      if (Array.isArray(ms) && ms[0] && typeof ms[0] === 'object' && 'frame' in ms[0] && 'playing' in ms[0]) {
        playback = ms[0];
        break;
      }
      hook = hook.next;
    }
  }

  // Get composition metadata from Composition fiber props
  var compositionFiber = findFiber(function(_, name) { return name === 'Composition' || name === 'InnerComposition'; });
  var composition = compositionFiber ? compositionFiber.memoizedProps : null;
  var compositionId = (window.remotion_seenCompositionIds && window.remotion_seenCompositionIds[0]) || null;

  var frame = (playback && playback.frame && playback.frame[compositionId]) != null ? playback.frame[compositionId] : null;
  var playing = playback ? playback.playing : null;
  var playbackRate = playback ? playback.playbackRate : null;

  var fps = composition ? composition.fps : null;
  var totalFrames = composition ? composition.durationInFrames : null;

  var state = {
    compositionId: compositionId,
    frame: frame,
    totalFrames: totalFrames,
    fps: fps,
    isPlaying: playing,
    playbackRate: playbackRate,
    width: composition ? composition.width : null,
    height: composition ? composition.height : null,
  };

  if (fps && totalFrames) {
    state.durationInSeconds = Math.round((totalFrames / fps) * 1000) / 1000;
  }
  if (fps && frame !== null) {
    state.currentTimeSeconds = Math.round((frame / fps) * 1000) / 1000;
  }

  return state;
})()`;

export const remotionGetStateTool: BuiltinToolDefinition = {
  name: 'remotion_get_state',
  description: 'Get the current playback state of a Remotion Studio viewer, including the current frame, total frames, FPS, playing status, and composition info.',
  inputSchema: {
    type: 'object',
    properties: {
      viewer_id: {
        type: 'string',
        description: 'The manifest file path (.remotion) identifying the viewer. Optional if only one studio is running.',
      },
    },
  },
  annotations: { readOnlyHint: true },
  handler: async (args: Record<string, any>) => {
    try {
      const resolved = resolveStudioOrError(args);
      if ('error' in resolved) return resolved.error;

      const state = await executeInStudio<Record<string, unknown>>(resolved.viewerId, GET_STATE_SCRIPT);
      return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }], isError: false };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Failed to get state: ${error.message}` }], isError: true };
    }
  },
};
