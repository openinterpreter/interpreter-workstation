import { prefixToolName } from '../utils/mcpToolName';

export const INTERPRETER_OVERLAY_TOOL_SERVER_ID = 'builtin-interpreter-overlay';
export const INTERPRETER_OVERLAY_TOOL_NAMES = [
  'overlay_read_context',
  'overlay_screenshot',
  'computer_batch',
  'overlay_show_drawings',
  'overlay_clear_drawings',
  'call_hidden_agent',
  'overlay_detach',
  'overlay_complete',
] as const;

// Hidden agents never own the live overlay session: the dispatching
// controller does. They read context and stage reviewed actions, but the
// terminal session tools (detach/complete) and further delegation stay with
// the owner.
export const HIDDEN_AGENT_OVERLAY_TOOL_NAMES = INTERPRETER_OVERLAY_TOOL_NAMES.filter(
  (toolName) => toolName !== 'call_hidden_agent'
    && toolName !== 'overlay_detach'
    && toolName !== 'overlay_complete',
);

export const ADVANCED_VOICE_OVERLAY_TOOL_NAMES = [
] as const;

export const REALTIME_COMPUTER_BATCH_TOOL_NAME = 'computer_batch';

export const AGENT_WINDOW_TOOL_SERVER_ID = 'builtin-agent-windows';
export const AGENT_WINDOW_TOOL_NAMES = [
  'list_agent_windows',
  'launch_agent_window',
  'send_agent_window_message',
  'reveal_agent_window',
  'stop_agent_window',
  'close_agent_window',
  'await_agent_window',
] as const;

export const CUA_DRIVER_TOOL_SERVER_ID = 'builtin-cua-driver';
export const OVERLAY_CUA_TOOL_NAMES = [
  'list_windows',
  'get_ui_elements',
  'click',
  'drag',
  'press_key',
  'scroll',
  'select_option',
  'set_value',
  'close_window',
  'minimize_window',
  'restore_window',
  'maximize_window',
  'type_text',
  'perform_secondary_action',
  'focus_window',
  'set_window_bounds',
] as const;

export const OVERLAY_VISIBLE_AGENT_CUA_TOOL_NAMES = [
  'list_windows',
  'get_ui_elements',
  'close_window',
  'minimize_window',
  'restore_window',
  'maximize_window',
  'focus_window',
  'set_window_bounds',
] as const;

export const SELECTION_TOOL_SERVER_ID = 'builtin-selection';
export const OVERLAY_SELECTION_TOOL_NAMES = [
  'read_current_selection',
] as const;

export const INTERPRETER_TOOL_SERVER_ID = 'builtin-interpreter';
export const OVERLAY_INTERPRETER_TOOL_NAMES = [
  'interpreter_whole_computer_state_get',
  'interpreter_browser_tab_activate',
  'interpreter_browser_page_inspect',
  'interpreter_browser_page_trace',
  'interpreter_browser_page_click',
  'interpreter_browser_page_type',
  'interpreter_browser_page_select',
  'interpreter_browser_page_scroll',
] as const;

export const OVERLAY_AGENT_ALLOWED_TOOL_NAMES = [
  ...INTERPRETER_OVERLAY_TOOL_NAMES.map((toolName) =>
    prefixToolName(INTERPRETER_OVERLAY_TOOL_SERVER_ID, toolName),
  ),
  ...OVERLAY_VISIBLE_AGENT_CUA_TOOL_NAMES.map((toolName) =>
    prefixToolName(CUA_DRIVER_TOOL_SERVER_ID, toolName),
  ),
  ...OVERLAY_SELECTION_TOOL_NAMES.map((toolName) =>
    prefixToolName(SELECTION_TOOL_SERVER_ID, toolName),
  ),
  ...OVERLAY_INTERPRETER_TOOL_NAMES.map((toolName) =>
    prefixToolName(INTERPRETER_TOOL_SERVER_ID, toolName),
  ),
  ...AGENT_WINDOW_TOOL_NAMES.map((toolName) =>
    prefixToolName(AGENT_WINDOW_TOOL_SERVER_ID, toolName),
  ),
];

export const OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS = [
  {
    serverId: INTERPRETER_OVERLAY_TOOL_SERVER_ID,
    toolNames: [
      'overlay_read_context',
      'overlay_screenshot',
      'overlay_show_drawings',
      'overlay_clear_drawings',
    ],
  },
  {
    serverId: CUA_DRIVER_TOOL_SERVER_ID,
    toolNames: OVERLAY_CUA_TOOL_NAMES,
  },
  {
    serverId: SELECTION_TOOL_SERVER_ID,
    toolNames: OVERLAY_SELECTION_TOOL_NAMES,
  },
  {
    serverId: INTERPRETER_TOOL_SERVER_ID,
    toolNames: OVERLAY_INTERPRETER_TOOL_NAMES,
  },
  {
    serverId: AGENT_WINDOW_TOOL_SERVER_ID,
    toolNames: AGENT_WINDOW_TOOL_NAMES,
  },
] as const;

export function isOverlayRealtimeCompatibleTool(serverId: string, toolName: string): boolean {
  return OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS.some((spec) => (
    spec.serverId === serverId
    && (spec.toolNames as readonly string[]).includes(toolName)
  ));
}

export function listOverlayRealtimeCompatibleToolNames(): string[] {
  return OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS.flatMap((spec) =>
    spec.toolNames.map((toolName) => `${spec.serverId}/${toolName}`),
  );
}
