import { describe, expect, test } from 'bun:test';

import { interpreterOverlayServerDefinition } from '../../../server/tools/builtin-tools/interpreter-overlay/index';
import { overlayReadContextTool } from '../../../server/tools/builtin-tools/interpreter-overlay/overlayTools';
import {
  AGENT_WINDOW_TOOL_NAMES,
  ADVANCED_VOICE_OVERLAY_TOOL_NAMES,
  INTERPRETER_OVERLAY_TOOL_NAMES,
  OVERLAY_CUA_TOOL_NAMES,
  OVERLAY_INTERPRETER_TOOL_NAMES,
  OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS,
  REALTIME_COMPUTER_BATCH_TOOL_NAME,
} from '../../../shared/types/overlayToolCatalog';
import {
  buildAdvancedVoiceToolCatalogText,
  buildOverlayTextControllerLoopFunctionTools,
  buildOverlayTextControllerToolCatalogText,
} from './text-controller-tool-catalog';

function extractBuiltinToolBlock(catalog: string, serverId: string, toolName: string): string {
  const start = `<tool server_id=${JSON.stringify(serverId)} name=${JSON.stringify(toolName)}>`;
  const startIndex = catalog.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const end = '</tool>';
  const endIndex = catalog.indexOf(end, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);
  return catalog.slice(startIndex, endIndex + end.length);
}

describe('overlay text controller tool catalog', () => {
  test('formats overlay and desktop tool definitions from the built-in source definitions', () => {
    const catalog = buildOverlayTextControllerToolCatalogText();

    expect(catalog).toContain('<overlay_available_tools>');
    for (const toolName of INTERPRETER_OVERLAY_TOOL_NAMES) {
      expect(catalog).toContain(`server_id="builtin-interpreter-overlay" name="${toolName}"`);
    }
    expect(catalog).toContain(`server_id="builtin-interpreter-overlay" name="${overlayReadContextTool.name}"`);
    expect(catalog).toContain(`description: ${overlayReadContextTool.description.trim()}`);
    expect(catalog).toContain(`input_schema: ${JSON.stringify(overlayReadContextTool.inputSchema)}`);
    for (const toolName of AGENT_WINDOW_TOOL_NAMES) {
      expect(catalog).toContain(`server_id="builtin-agent-windows" name="${toolName}"`);
    }
    expect(catalog).toContain('server_id="builtin-interpreter-overlay" name="computer_batch"');
    expect(catalog).toContain('Run one ordered batch through the unified Interpreter tool layer');
    expect(catalog).toContain('server_id="builtin-interpreter-overlay" name="overlay_show_drawings"');
    expect(catalog).toContain('Show visual-only rectangle annotations inside the granted Interpreter Overlay square');
    expect(catalog).toContain('server_id="builtin-interpreter-overlay" name="overlay_clear_drawings"');
    expect(catalog).toContain('Clear visual-only drawings from the granted Interpreter Overlay square');
    expect(catalog).toContain('server_id="builtin-interpreter-overlay" name="call_hidden_agent"');
    expect(catalog).toContain('Delegate a bounded task to a hidden Interpreter agent');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="list_windows"');
    expect(catalog).toContain('List top-level app windows with normalized target_identity objects, titles, and bounds.');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="get_ui_elements"');
    expect(catalog).toContain('Get snapshot-scoped UI element refs and observed screen-point bounding boxes');
    for (const toolName of OVERLAY_CUA_TOOL_NAMES) {
      expect(catalog).toContain(`server_id="builtin-cua-driver" name="${toolName}"`);
    }
    expect(catalog).toContain('server_id="builtin-cua-driver" name="click"');
    expect(catalog).toContain('Click an element by index or pixel coordinates from screenshot.');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="set_value"');
    expect(catalog).toContain('Set the value of a settable accessibility element.');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="close_window"');
    expect(catalog).toContain('Request-close a top-level app window selected by target_identity from list_windows.');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="type_text"');
    expect(catalog).toContain('input_schema: run `interpreter-app tools builtin-cua-driver type_text --help` for the authoritative schema');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="press_key"');
    expect(catalog).toContain('Press a key or key-combination on the keyboard');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="focus_window"');
    expect(catalog).toContain('Reveal and focus a top-level app window selected by target_identity from list_windows.');
    expect(catalog).toContain('server_id="builtin-cua-driver" name="set_window_bounds"');
    expect(catalog).toContain('input_schema: run `interpreter-app tools builtin-cua-driver set_window_bounds --help` for the authoritative schema');
    expect(catalog).toContain('server_id="builtin-selection" name="read_current_selection"');
    expect(catalog).toContain('Read the current desktop selection as selected text and permission-filtered selected file refs.');
    expect(catalog).toContain('server_id="builtin-interpreter" name="interpreter_whole_computer_state_get"');
    expect(catalog).toContain('Read bounded local Interpreter whole-computer state');
    expect(catalog).toContain('input_schema: run `interpreter-app tools builtin-interpreter interpreter_whole_computer_state_get --help` for the authoritative schema');
    for (const toolName of OVERLAY_INTERPRETER_TOOL_NAMES) {
      expect(catalog).toContain(`server_id="builtin-interpreter" name="${toolName}"`);
    }
    expect(catalog).toContain('Activate and focus an observed Chrome browser tab');
    expect(catalog).toContain('Inspect one observed Chrome tab and return bounded browser page frame and element refs');
    expect(catalog).toContain('Draw a short-lived visual trace inside an observed Chrome tab');
    expect(catalog).toContain('Click one current browser page element ref inside an observed Chrome tab');
    expect(catalog).toContain('Replace text in one current editable browser page element ref inside an observed Chrome tab');
    expect(catalog).toContain('Select one exact option value in a current browser page select element ref inside an observed Chrome tab');
    expect(catalog).toContain('Scroll one current browser page frame inside an observed Chrome tab');
    expect(catalog).not.toContain('page-elements');
    expect(catalog).not.toContain('page-trace');
    expect(catalog).not.toContain('page-click');
    expect(catalog).not.toContain('page-type');
    expect(catalog).not.toContain('page-select');
    expect(catalog).not.toContain('page-scroll');
    expect(catalog).not.toContain('getPageElementInventory');
    expect(catalog).not.toContain('server_id="browser-extension"');
    expect(catalog).not.toContain('server_id="browser-control-relay"');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="list_agent_windows"');
    expect(catalog).toContain('List Interpreter-owned agent windows and safe thread/status metadata.');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="launch_agent_window"');
    expect(catalog).toContain('Launch a normal visible Interpreter agent window and send it an initial message.');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="send_agent_window_message"');
    expect(catalog).toContain('Send a follow-up message to an existing visible Interpreter agent window.');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="reveal_agent_window"');
    expect(catalog).toContain('Reveal and focus an existing visible Interpreter agent window/tab');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="stop_agent_window"');
    expect(catalog).toContain('Request cancellation of a running visible Interpreter agent window');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="close_agent_window"');
    expect(catalog).toContain('Close an existing visible Interpreter agent window/tab');
    expect(catalog).toContain('server_id="builtin-agent-windows" name="await_agent_window"');
    expect(catalog).toContain('Wait for an Interpreter-owned agent window to finish its current task');
  });

  test('fails loudly when a requested catalog tool is missing', () => {
    expect(() => buildOverlayTextControllerToolCatalogText([{
      server: interpreterOverlayServerDefinition,
      toolNames: ['missing_tool'],
    }])).toThrow('Missing text-controller tool definition: builtin-interpreter-overlay/missing_tool');
  });

  test('formats advanced voice bridge tools from shared overlay definitions where available', () => {
    const catalog = buildAdvancedVoiceToolCatalogText();

    expect(catalog).toContain('<advanced_voice_available_tools>');
    expect(catalog).not.toContain('compatible_interpreter_tool server_id="builtin-interpreter-overlay" name="computer_batch"');
    expect(catalog).not.toContain('compatible_interpreter_tool server_id="builtin-interpreter-overlay" name="call_hidden_agent"');
    expect(catalog).not.toContain('compatible_interpreter_tool server_id="builtin-interpreter-overlay" name="overlay_detach"');
    expect(catalog).not.toContain('compatible_interpreter_tool server_id="builtin-interpreter-overlay" name="overlay_complete"');
    expect(catalog).toContain('compatible_interpreter_tool server_id="builtin-interpreter-overlay" name="overlay_show_drawings"');
    expect(catalog).toContain('compatible_interpreter_tool server_id="builtin-interpreter-overlay" name="overlay_clear_drawings"');
    expect(catalog).toContain(`name="${REALTIME_COMPUTER_BATCH_TOOL_NAME}" transport="advanced_voice_local_bridge"`);
    expect(catalog).toContain('Submit one batch of approved Interpreter tool calls.');
    expect(catalog).toContain('<realtime_compatible_interpreter_tools>');
    for (const spec of OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS) {
      for (const toolName of spec.toolNames) {
        expect(catalog).toContain(`compatible_interpreter_tool server_id="${spec.serverId}" name="${toolName}"`);
      }
    }
    expect(catalog).toContain('compatible_interpreter_tool server_id="builtin-cua-driver" name="set_window_bounds"');
    expect(catalog).toContain('compatible_interpreter_tool server_id="builtin-interpreter" name="interpreter_browser_page_click"');
    expect(catalog).toContain('compatible_interpreter_tool server_id="builtin-agent-windows" name="launch_agent_window"');
    expect(catalog).toContain('name="query_attachments" transport="advanced_voice_local_bridge"');
    expect(catalog).toContain('Answer a focused question from the locally attached selected-file or selected-text context.');
    expect(catalog).toContain('name="send_message_to_agent" transport="advanced_voice_local_bridge"');
    expect(catalog).toContain('name="read_agent_assistant_messages" transport="advanced_voice_local_bridge"');
    expect(catalog).not.toContain('server_id="browser-extension"');
    expect(catalog).not.toContain('server_id="browser-control-relay"');
  });

  test('typed loop function tools are byte-identical to the shared advanced voice bridge definitions', () => {
    const advancedVoiceCatalog = buildAdvancedVoiceToolCatalogText();
    const loopTools = buildOverlayTextControllerLoopFunctionTools();

    expect(loopTools.map((tool) => tool.name)).toEqual([
      'computer_batch',
      'call_hidden_agent',
      'query_attachments',
      'read_agent_assistant_messages',
    ]);
    // Same descriptions and schemas as the voice bridge catalog prints, from
    // the same definitions - no third schema source.
    for (const tool of loopTools) {
      expect(advancedVoiceCatalog).toContain(`description: ${tool.description.trim()}`);
      expect(advancedVoiceCatalog).toContain(`input_schema: ${JSON.stringify(tool.parameters)}`);
    }
    // send_message_to_agent stays voice-only.
    expect(loopTools.some((tool) => tool.name === 'send_message_to_agent')).toBe(false);
  });

  test('keeps shared text and advanced voice overlay tool blocks identical', () => {
    const textCatalog = buildOverlayTextControllerToolCatalogText();
    const advancedVoiceCatalog = buildAdvancedVoiceToolCatalogText();
    for (const toolName of ADVANCED_VOICE_OVERLAY_TOOL_NAMES) {
      expect(extractBuiltinToolBlock(
        advancedVoiceCatalog,
        'builtin-interpreter-overlay',
        toolName,
      )).toBe(extractBuiltinToolBlock(
        textCatalog,
        'builtin-interpreter-overlay',
        toolName,
      ));
    }
  });
});
