import type { BuiltinServerDefinition } from '../../builtinTools';
import { remotionGetStateTool } from './remotionGetStateTool';
import { remotionPlayTool } from './remotionPlayTool';
import { remotionPauseTool } from './remotionPauseTool';
import { remotionSeekTool } from './remotionSeekTool';
import { remotionExecJsTool } from './remotionExecJsTool';

export {
  remotionGetStateTool,
  remotionPlayTool,
  remotionPauseTool,
  remotionSeekTool,
  remotionExecJsTool,
};

export const remotionServerDefinition: BuiltinServerDefinition = {
  id: 'builtin-remotion',
  name: 'Remotion',
  description: 'Control Remotion Studio video editors: play, pause, seek, execute JS, and get playback state.',
  isBuiltin: true,
  tools: [
    remotionGetStateTool,
    remotionPlayTool,
    remotionPauseTool,
    remotionSeekTool,
    remotionExecJsTool,
  ],
  resources: [],
  prompts: [],
};
