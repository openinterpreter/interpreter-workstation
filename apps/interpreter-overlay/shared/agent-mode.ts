export type InterpreterOverlayAgentMode = 'ax' | 'vision';

// macOS and Windows use accessibility-tree mode by default. Vision remains
// available for screenshot-driven debugging and targets without useful AX/UIA.
export const DEFAULT_INTERPRETER_OVERLAY_AGENT_MODE =
  (process.platform === 'darwin' || process.platform === 'win32' ? 'ax' : 'vision') as InterpreterOverlayAgentMode;

const rawInterpreterOverlayAgentMode = (process.env.INTERPRETER_OVERLAY_AGENT_MODE ?? '')
  .trim()
  .toLowerCase();

export const INTERPRETER_OVERLAY_AGENT_MODE: InterpreterOverlayAgentMode =
  rawInterpreterOverlayAgentMode === 'vision'
      ? 'vision'
      : DEFAULT_INTERPRETER_OVERLAY_AGENT_MODE;
export const INTERPRETER_OVERLAY_AX_MODE = INTERPRETER_OVERLAY_AGENT_MODE === 'ax';
export const INTERPRETER_OVERLAY_VISION_MODE = INTERPRETER_OVERLAY_AGENT_MODE === 'vision';
