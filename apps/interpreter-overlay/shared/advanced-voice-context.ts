import { buildOverlayContextPacketText } from './context-packet.js';
import type { OverlayContextItem } from './ipc.js';
import { getTargetContextItem } from './text-controller.js';
import type { Bounds } from './types.js';

function formatAdvancedVoiceBounds(bounds: Bounds | null | undefined): string {
  if (!bounds) {
    return 'the full granted display';
  }

  return `x=${Math.round(bounds.x)}, y=${Math.round(bounds.y)}, width=${Math.round(bounds.width)}, height=${Math.round(bounds.height)}`;
}

export function buildAdvancedVoiceOverlayContextInstructions(
  contextItems: OverlayContextItem[],
): string[] {
  const targetContext = getTargetContextItem(contextItems);
  if (!targetContext && contextItems.length === 0) {
    return [
      'Current overlay context: no active app or selected region is attached.',
    ];
  }

  const lines = [
    targetContext
      ? `Current overlay target: ${targetContext.label}, bounds ${formatAdvancedVoiceBounds(targetContext.bounds)}.`
      : 'Current overlay target: none.',
  ];
  const packet = buildOverlayContextPacketText(contextItems).trim();
  if (packet) {
    lines.push(
      'Current overlay context packet follows. It is the same context bundle shown as chips before the prompt and must travel to any agent or tool you call.',
      packet,
    );
  }
  return lines;
}
