import type { BuiltinServerDefinition } from '../../../server/tools/builtinTools';
import { agentWindowsServerDefinition } from '../../../server/tools/builtin-tools/agent-windows/index';
import { cuaDriverServerDefinition } from '../../../server/tools/builtin-tools/cua-driver/index';
import { interpreterOverlayServerDefinition } from '../../../server/tools/builtin-tools/interpreter-overlay/index';
import { selectionServerDefinition } from '../../../server/tools/builtin-tools/selection/index';
import { interpreterServerDefinition } from '../../../server/tools/builtin-tools/workstation/index';
import {
  AGENT_WINDOW_TOOL_NAMES,
  OVERLAY_CUA_TOOL_NAMES,
  OVERLAY_INTERPRETER_TOOL_NAMES,
  INTERPRETER_OVERLAY_TOOL_NAMES,
  OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS,
  OVERLAY_SELECTION_TOOL_NAMES,
  REALTIME_COMPUTER_BATCH_TOOL_NAME,
} from '../../../shared/types/overlayToolCatalog';

export interface OverlayTextControllerToolCatalogSpec {
  server: BuiltinServerDefinition;
  toolNames: readonly string[];
  /**
   * Compact specs print the tool name plus its first description line and a
   * CLI --help pointer instead of the full JSON schema. This keeps the fast
   * text-controller prompt small; agents still reach the authoritative
   * schema through `interpreter-app tools <server> <tool> --help`.
   */
  compact?: boolean;
}

interface LocalToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const DEFAULT_TEXT_CONTROLLER_TOOL_CATALOG: readonly OverlayTextControllerToolCatalogSpec[] = [
  {
    server: interpreterOverlayServerDefinition,
    toolNames: INTERPRETER_OVERLAY_TOOL_NAMES,
  },
  {
    server: cuaDriverServerDefinition,
    toolNames: OVERLAY_CUA_TOOL_NAMES,
    compact: true,
  },
  {
    server: selectionServerDefinition,
    toolNames: OVERLAY_SELECTION_TOOL_NAMES,
  },
  {
    server: interpreterServerDefinition,
    toolNames: OVERLAY_INTERPRETER_TOOL_NAMES,
    compact: true,
  },
  {
    server: agentWindowsServerDefinition,
    toolNames: AGENT_WINDOW_TOOL_NAMES,
    compact: true,
  },
];

const ADVANCED_VOICE_HANDOFF_TOOL_NAME = 'call_hidden_agent';

const BUILTIN_SERVER_BY_ID: Record<string, BuiltinServerDefinition> = {
  [agentWindowsServerDefinition.id]: agentWindowsServerDefinition,
  [cuaDriverServerDefinition.id]: cuaDriverServerDefinition,
  [interpreterOverlayServerDefinition.id]: interpreterOverlayServerDefinition,
  [interpreterServerDefinition.id]: interpreterServerDefinition,
  [selectionServerDefinition.id]: selectionServerDefinition,
};

const ADVANCED_VOICE_LOCAL_TOOLS: readonly LocalToolDefinition[] = [
  {
    name: REALTIME_COMPUTER_BATCH_TOOL_NAME,
    description: 'Submit one batch of approved Interpreter tool calls. Each action is either a normal tool-layer call with server_id, tool_name, and JSON arguments, or a selected-target atomic action shaped as { seq, tool: { name, params } } for click/type/hotkey/scroll against the currently attached selected target. Use this single batch tool for selected overlay context actions, overlay visual highlights/drawings, window control, browser control, selection, and agent-window tools that are marked realtime-compatible. The result is per-action outcomes plus touched_window_diff, the before/after diff of the windows the batch touched - changes only, never full state; call overlay_read_context through this batch tool when you need full current state. If arguments are loose or malformed, Interpreter normalizes or repairs them when safe, then returns the exact schema and any correction notes.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            oneOf: [
              {
                type: 'object',
                properties: {
                  seq: { type: 'number' },
                  server_id: { type: 'string' },
                  tool_name: { type: 'string' },
                  arguments: { type: 'object' },
                },
                required: ['server_id', 'tool_name', 'arguments'],
              },
              {
                type: 'object',
                properties: {
                  seq: { type: 'number' },
                  tool: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', enum: ['click', 'type', 'hotkey', 'scroll'] },
                      params: { type: 'object' },
                    },
                    required: ['name', 'params'],
                  },
                },
                required: ['seq', 'tool'],
              },
            ],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'query_attachments',
    description: 'Answer a focused question from the locally attached selected-file or selected-text context. This does not operate the desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
      },
      required: ['question'],
    },
  },
  {
    name: 'send_message_to_agent',
    description: 'Send broader workspace or filesystem work to the normal visible Interpreter agent path while keeping advanced voice transport separate.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
  {
    name: 'read_agent_assistant_messages',
    description: 'Read the latest user-visible result from delegated visible-agent work when the user asks for progress or the app reports completion.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export interface OverlayTextControllerLoopFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function getAdvancedVoiceLocalTool(name: string): LocalToolDefinition {
  const tool = ADVANCED_VOICE_LOCAL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing advanced voice local bridge tool definition: ${name}`);
  }
  return tool;
}

/**
 * The typed fast controller loop advertises the same bridge tools as the
 * GPT-realtime voice bridge, from the same definitions, byte-identical:
 * the local-bridge computer_batch, query_attachments, and
 * read_agent_assistant_messages plus the builtin call_hidden_agent handoff.
 * send_message_to_agent stays voice-only; the typed loop hands broader work
 * off to the normal agent path instead.
 */
export function buildOverlayTextControllerLoopFunctionTools(): OverlayTextControllerLoopFunctionTool[] {
  const computerBatchTool = getAdvancedVoiceLocalTool(REALTIME_COMPUTER_BATCH_TOOL_NAME);
  const queryAttachmentsTool = getAdvancedVoiceLocalTool('query_attachments');
  const readAgentMessagesTool = getAdvancedVoiceLocalTool('read_agent_assistant_messages');
  const hiddenAgentTool = interpreterOverlayServerDefinition.tools.find(
    (candidate) => candidate.name === ADVANCED_VOICE_HANDOFF_TOOL_NAME,
  );
  if (!hiddenAgentTool) {
    throw new Error(`Missing text-controller loop tool definition: ${interpreterOverlayServerDefinition.id}/${ADVANCED_VOICE_HANDOFF_TOOL_NAME}`);
  }
  return [
    {
      name: computerBatchTool.name,
      description: computerBatchTool.description,
      parameters: computerBatchTool.inputSchema,
    },
    {
      name: hiddenAgentTool.name,
      description: hiddenAgentTool.description,
      parameters: hiddenAgentTool.inputSchema as Record<string, unknown>,
    },
    {
      name: queryAttachmentsTool.name,
      description: queryAttachmentsTool.description,
      parameters: queryAttachmentsTool.inputSchema,
    },
    {
      name: readAgentMessagesTool.name,
      description: readAgentMessagesTool.description,
      parameters: readAgentMessagesTool.inputSchema,
    },
  ];
}

function formatToolDefinition(
  server: BuiltinServerDefinition,
  toolName: string,
  compact = false,
): string {
  const tool = server.tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Missing text-controller tool definition: ${server.id}/${toolName}`);
  }

  if (compact) {
    const firstDescriptionLine = tool.description.trim().split('\n')[0].trim();
    return [
      `<tool server_id=${JSON.stringify(server.id)} name=${JSON.stringify(tool.name)}>`,
      `description: ${firstDescriptionLine}`,
      `input_schema: run \`interpreter-app tools ${server.id} ${tool.name} --help\` for the authoritative schema`,
      '</tool>',
    ].join('\n');
  }

  return [
    `<tool server_id=${JSON.stringify(server.id)} name=${JSON.stringify(tool.name)}>`,
    `description: ${tool.description.trim()}`,
    `input_schema: ${JSON.stringify(tool.inputSchema)}`,
    '</tool>',
  ].join('\n');
}

function formatLocalToolDefinition(tool: LocalToolDefinition): string {
  return [
    `<tool name=${JSON.stringify(tool.name)} transport="advanced_voice_local_bridge">`,
    `description: ${tool.description.trim()}`,
    `input_schema: ${JSON.stringify(tool.inputSchema)}`,
    '</tool>',
  ].join('\n');
}

function formatRealtimeCompatibleToolDefinition(serverId: string, toolName: string): string {
  const server = BUILTIN_SERVER_BY_ID[serverId];
  if (!server) {
    throw new Error(`Missing realtime-compatible tool server definition: ${serverId}`);
  }
  const tool = server.tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Missing realtime-compatible tool definition: ${serverId}/${toolName}`);
  }

  return [
    `<compatible_interpreter_tool server_id=${JSON.stringify(server.id)} name=${JSON.stringify(tool.name)}>`,
    `description: ${tool.description.trim()}`,
    `input_schema: ${JSON.stringify(tool.inputSchema)}`,
    '</compatible_interpreter_tool>',
  ].join('\n');
}

export function buildOverlayTextControllerToolCatalogText(
  specs: readonly OverlayTextControllerToolCatalogSpec[] = DEFAULT_TEXT_CONTROLLER_TOOL_CATALOG,
): string {
  const tools = specs.flatMap((spec) =>
    spec.toolNames.map((toolName) => formatToolDefinition(spec.server, toolName, spec.compact === true)),
  );

  return [
    '<overlay_available_tools>',
    'These tool descriptions come from the built-in Interpreter tool definitions. Use the same server/tool names when planning tool calls.',
    ...tools,
    '</overlay_available_tools>',
  ].join('\n');
}

export function buildAdvancedVoiceToolCatalogText(): string {
  const [computerBatchTool, ...bridgeTools] = ADVANCED_VOICE_LOCAL_TOOLS;
  return [
    '<advanced_voice_available_tools>',
    'These are the GPT realtime 2 audio bridge tools currently available in this Electron process. computer_batch is the single batch bridge for realtime-compatible Interpreter tool calls; it calls the approved subset through the same ToolManager/Interpreter CLI builtin definitions used by typed overlay and normal agents. call_hidden_agent is the delegation handoff, not a computer-control primitive.',
    formatLocalToolDefinition(computerBatchTool),
    formatToolDefinition(interpreterOverlayServerDefinition, ADVANCED_VOICE_HANDOFF_TOOL_NAME),
    ...bridgeTools.map(formatLocalToolDefinition),
    '<realtime_compatible_interpreter_tools>',
    'Use computer_batch actions with these exact server_id/name pairs for normal Interpreter computer, window, browser, selection, overlay visual, and agent-window tools. For selected-region form work, use selected-target atomic actions shaped as { seq, tool: { name: "type"|"click"|"hotkey"|"scroll", params } } with selected refs from the current context packet. The batch result reports touched_window_diff, the observed before/after changes of the windows the batch touched; it never includes full refreshed state.',
    ...OVERLAY_REALTIME_COMPATIBLE_TOOL_SPECS.flatMap((spec) =>
      spec.toolNames.map((toolName) =>
        formatRealtimeCompatibleToolDefinition(spec.serverId, toolName),
      ),
    ),
    '</realtime_compatible_interpreter_tools>',
    '</advanced_voice_available_tools>',
  ].join('\n');
}
