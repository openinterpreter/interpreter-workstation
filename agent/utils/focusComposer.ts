/**
 * Focus Composer Utility
 *
 * Dispatches an event to focus the main agent composer.
 * Uses nested requestAnimationFrame for reliable focus after React re-renders.
 *
 * The BaseTiptapComposer listens for 'focus-agent-input' events when isMainComposer=true.
 */

export interface FocusComposerDetail {
  agentId?: string;
}

interface FocusComposerOptions {
  delay?: number;
  agentId?: string;
}

function dispatchFocusComposer(detail?: FocusComposerDetail): void {
  if (detail?.agentId) {
    window.dispatchEvent(new CustomEvent<FocusComposerDetail>('focus-agent-input', {
      detail,
    }));
    return;
  }

  window.dispatchEvent(new CustomEvent('focus-agent-input'));
}

/**
 * Focus the main agent composer input.
 *
 * `agentId` targets a specific agent tab. Without it, the currently visible
 * main composer handles the focus request.
 */
export function focusComposer(options: FocusComposerOptions = {}): void {
  const { delay = 100, agentId } = options;

  // Use nested RAF pattern for reliable focus after React renders.
  setTimeout(() => {
    requestAnimationFrame(() => {
      dispatchFocusComposer(agentId ? { agentId } : undefined);
      requestAnimationFrame(() => {
        dispatchFocusComposer(agentId ? { agentId } : undefined);
      });
    });
  }, delay);
}
