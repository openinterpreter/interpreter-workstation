import { prefixToolName } from '../../../shared/utils/mcpToolName';
import {
  INTERPRETER_OVERLAY_TOOL_SERVER_ID,
  INTERPRETER_OVERLAY_TOOL_NAMES,
  OVERLAY_AGENT_ALLOWED_TOOL_NAMES as SHARED_OVERLAY_AGENT_ALLOWED_TOOL_NAMES,
} from '../../../shared/types/overlayToolCatalog';

export const OVERLAY_AGENT_TOOL_SERVER_ID = INTERPRETER_OVERLAY_TOOL_SERVER_ID;
export const OVERLAY_AGENT_TOOL_NAMES = INTERPRETER_OVERLAY_TOOL_NAMES;

export const OVERLAY_AGENT_ALLOWED_TOOL_NAMES = SHARED_OVERLAY_AGENT_ALLOWED_TOOL_NAMES;

export const FORM_TESTS_ADVANCED_VOICE_AGENT_ALLOWED_TOOL_NAMES = [
  prefixToolName('builtin-test-approval', 'test_approval'),
];

export const DESKTOP_CUA_TOOL_NAMES = [
  'get_app_state',
  'click',
  'press_key',
  'scroll',
  'select_option',
  'set_value',
] as const;

export const DESKTOP_CUA_ALLOWED_TOOL_NAMES = DESKTOP_CUA_TOOL_NAMES.map((toolName) =>
  prefixToolName('builtin-cua-driver', toolName),
);
