import type { BuiltinServerDefinition } from '../../builtinTools';
import { callHiddenAgentTool } from './hiddenAgentTool';
import {
  overlayComputerBatchTool,
  overlayClearDrawingsTool,
  overlayCompleteTool,
  overlayDetachTool,
  overlayReadContextTool,
  overlayScreenshotTool,
  overlayShowDrawingsTool,
} from './overlayTools';

export const interpreterOverlayServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-interpreter-overlay',
  name: 'Interpreter Overlay',
  description: 'Scoped live access to a user-approved square on the operating system desktop.',
  isBuiltin: true,
  tools: [
    overlayReadContextTool,
    overlayScreenshotTool,
    overlayComputerBatchTool,
    overlayShowDrawingsTool,
    overlayClearDrawingsTool,
    callHiddenAgentTool,
    overlayDetachTool,
    overlayCompleteTool,
  ],
  resources: [],
  prompts: [],
};
