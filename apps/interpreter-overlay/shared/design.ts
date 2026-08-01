export type InterpreterOverlayInputDesign =
  | 'progressive-blur'
  | 'pill';

export const INTERPRETER_OVERLAY_DIM_OPACITY = 0.10;
export const INTERPRETER_OVERLAY_FULLSCREEN_DIM_COLOR = `rgba(0, 0, 0, ${INTERPRETER_OVERLAY_DIM_OPACITY})`;

export function getInterpreterOverlayScopeFillColor(isInputActive: boolean): string {
  const channel = isInputActive ? '255, 255, 255' : '0, 0, 0';
  return `rgba(${channel}, ${INTERPRETER_OVERLAY_DIM_OPACITY})`;
}

// We have not decided on a final input-surface design direction yet, so keep both
// implementations available here for direct comparison instead of deleting one.
export const INTERPRETER_OVERLAY_INPUT_DESIGN: InterpreterOverlayInputDesign = 'progressive-blur';

export function usesProgressiveBlurInput(
  design: InterpreterOverlayInputDesign = INTERPRETER_OVERLAY_INPUT_DESIGN,
): boolean {
  return design === 'progressive-blur';
}
