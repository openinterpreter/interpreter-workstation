import Ajv from 'ajv';

import type { BuiltinToolDefinition } from '../../builtinTools';
import type { ToolCallResponse } from '../../toolTypes';
import type {
  AtomicToolCall,
  ComputerBatchParams,
} from '../../../../apps/interpreter-overlay/shared/ports';
import {
  isOverlayRealtimeCompatibleTool,
  listOverlayRealtimeCompatibleToolNames,
} from '../../../../shared/types/overlayToolCatalog';
import { parseAtomicToolCall } from '../../../../apps/interpreter-overlay/shared/computer-batch-params.js';
import { OverlayInvalidBatchActionError } from '../../../../apps/interpreter-overlay/shared/tool-results.js';

export interface AdvancedVoiceInterpreterToolAction {
  kind: 'interpreter_tool';
  seq: number | null;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AdvancedVoiceSelectedTargetAction {
  kind: 'selected_target_action';
  seq: number | null;
  tool: AtomicToolCall;
}

export type AdvancedVoiceComputerBatchAction =
  | AdvancedVoiceInterpreterToolAction
  | AdvancedVoiceSelectedTargetAction;

export interface AdvancedVoiceComputerBatchArguments {
  actions: AdvancedVoiceComputerBatchAction[];
  corrections: string[];
}

export interface AdvancedVoiceComputerBatchCallInput {
  argumentsJson: string;
  getBuiltinTool: (serverId: string, toolName: string) => BuiltinToolDefinition | undefined;
  callTool: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<ToolCallResponse>;
  callSelectedTargetBatch?: (
    params: ComputerBatchParams,
  ) => Promise<ToolCallResponse>;
  repairArguments?: (
    argumentsJson: string,
    parseError: string,
  ) => Promise<string | null>;
}

const COMPUTER_BATCH_SHAPE_INSTRUCTION = 'Send arguments as { "actions": [...] } where each action is { seq, server_id, tool_name, arguments } for an Interpreter tool call or { seq, tool: { name: "click"|"type"|"hotkey"|"scroll", params } } for a selected-target action.';
const toolArgumentsValidator = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${path} has unknown key ${JSON.stringify(key)}.`);
    }
  }
}

function parseToolCallObject(
  value: unknown,
  path: string,
): AdvancedVoiceComputerBatchAction {
  const record = requireRecord(value, path);
  if ('tool' in record) {
    rejectUnknownKeys(record, ['seq', 'tool'], path);
    return {
      kind: 'selected_target_action',
      seq: typeof record.seq === 'number' ? record.seq : null,
      tool: parseAtomicToolCall(record.tool, path),
    };
  }

  rejectUnknownKeys(record, ['seq', 'server_id', 'tool_name', 'arguments'], path);
  const serverId = typeof record.server_id === 'string' ? record.server_id.trim() : '';
  const toolName = typeof record.tool_name === 'string' ? record.tool_name.trim() : '';
  if (!serverId || !toolName) {
    throw new Error(`${path} requires string server_id and tool_name.`);
  }

  const argsValue = record.arguments;
  if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) {
    throw new Error(`${path} arguments must be a JSON object.`);
  }

  return {
    kind: 'interpreter_tool',
    seq: typeof record.seq === 'number' ? record.seq : null,
    serverId,
    toolName,
    args: argsValue as Record<string, unknown>,
  };
}

export function parseUnifiedComputerBatchArguments(
  argumentsJson: string,
): AdvancedVoiceComputerBatchArguments {
  const parsed = requireRecord(
    JSON.parse(argumentsJson || '{}'),
    'computer_batch arguments',
  );

  const corrections: string[] = [];
  let actionsValue = parsed.actions;
  if (actionsValue === undefined) {
    actionsValue = parsed;
    corrections.push('Wrapped a single tool call object into actions[]. In the future, send { "actions": [...] }.');
  } else {
    rejectUnknownKeys(parsed, ['actions'], 'computer_batch arguments');
  }
  if (!Array.isArray(actionsValue)) {
    actionsValue = [actionsValue];
    corrections.push('Wrapped non-array actions into a one-item actions array.');
  }
  const actionItems = actionsValue as unknown[];

  const actions = actionItems.map((action: unknown, index: number) =>
    parseToolCallObject(action, `computer_batch actions[${index}]`),
  );
  if (actions.length === 0) {
    throw new Error('computer_batch requires at least one action.');
  }
  const seenSeqs = new Set<number>();
  for (let index = 0; index < actions.length; index += 1) {
    const seq = actions[index].seq;
    if (seq === null || !Number.isFinite(seq)) {
      throw new Error(`computer_batch actions[${index}].seq must be a finite number.`);
    }
    if (seenSeqs.has(seq)) {
      throw new Error(`computer_batch actions[${index}].seq must be unique.`);
    }
    seenSeqs.add(seq);
  }

  return { actions, corrections };
}

export function formatToolCallResponseForComputerBatch(result: ToolCallResponse): string {
  const textParts = result.content
    .map((item) => typeof item.text === 'string' ? item.text : null)
    .filter((text): text is string => Boolean(text?.trim()));
  const imageCount = result.content.filter((item) => item.type === 'image' || item.image).length;
  return JSON.stringify({
    status: result.isError ? 'error' : 'completed',
    text: textParts.join('\n\n'),
    image_count: imageCount,
    saved_to_path: result.savedToPath ?? null,
    image_paths: result.imagePaths ?? [],
  });
}

function invalidArgumentsResponse(parseError: string, repair: string): string {
  return JSON.stringify({
    status: 'invalid_arguments',
    error: parseError,
    repair,
    allowed_tools: listOverlayRealtimeCompatibleToolNames(),
    instruction: COMPUTER_BATCH_SHAPE_INSTRUCTION,
  });
}

async function parseOrRepairComputerBatchArguments(
  input: AdvancedVoiceComputerBatchCallInput,
): Promise<AdvancedVoiceComputerBatchArguments | { invalidResponse: string }> {
  let parseErrorMessage: string;
  try {
    return parseUnifiedComputerBatchArguments(input.argumentsJson);
  } catch (parseError) {
    if (!input.repairArguments) {
      throw parseError;
    }
    parseErrorMessage = getErrorMessage(parseError);
  }

  let repairedJson: string | null;
  try {
    repairedJson = await input.repairArguments(input.argumentsJson, parseErrorMessage);
  } catch (repairError) {
    return { invalidResponse: invalidArgumentsResponse(parseErrorMessage, `repair model failed: ${getErrorMessage(repairError)}`) };
  }
  if (repairedJson === null) {
    return { invalidResponse: invalidArgumentsResponse(parseErrorMessage, 'rejected') };
  }

  try {
    const repaired = parseUnifiedComputerBatchArguments(repairedJson);
    repaired.corrections.push(
      `Arguments did not parse (${parseErrorMessage}) and were repaired by the configured fast repair model. ${COMPUTER_BATCH_SHAPE_INSTRUCTION}`,
    );
    return repaired;
  } catch (reparseError) {
    return { invalidResponse: invalidArgumentsResponse(parseErrorMessage, `repaired arguments were still invalid: ${getErrorMessage(reparseError)}`) };
  }
}

export async function executeUnifiedComputerBatchToolCall(
  input: AdvancedVoiceComputerBatchCallInput,
): Promise<string> {
  const parsedArguments = await parseOrRepairComputerBatchArguments(input);
  if ('invalidResponse' in parsedArguments) {
    return parsedArguments.invalidResponse;
  }
  const { actions, corrections } = parsedArguments;
  const resolvedInterpreterTools = new Map<number, BuiltinToolDefinition>();

  // Preflight the complete proposal before executing its first action. A
  // disallowed or unknown later entry must never leave an earlier entry
  // partially executed.
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.kind === 'selected_target_action') {
      if (!input.callSelectedTargetBatch) {
        return JSON.stringify({
          status: 'not_allowed',
          failed_action_seq: action.seq,
          tool: `selected-target/${action.tool.name}`,
          allowed_tools: listOverlayRealtimeCompatibleToolNames(),
          corrections,
        });
      }
      continue;
    }
    const toolLabel = `${action.serverId}/${action.toolName}`;
    if (!isOverlayRealtimeCompatibleTool(action.serverId, action.toolName)) {
      return JSON.stringify({
        status: 'not_allowed',
        failed_action_seq: action.seq,
        tool: toolLabel,
        allowed_tools: listOverlayRealtimeCompatibleToolNames(),
        corrections,
      });
    }
    const builtinTool = input.getBuiltinTool(action.serverId, action.toolName);
    if (!builtinTool) {
      return JSON.stringify({
        status: 'unknown_tool',
        failed_action_seq: action.seq,
        tool: toolLabel,
        allowed_tools: listOverlayRealtimeCompatibleToolNames(),
        corrections,
      });
    }
    let validateArguments;
    try {
      validateArguments = toolArgumentsValidator.compile(builtinTool.inputSchema);
    } catch (error) {
      return JSON.stringify({
        status: 'schema_or_execution_error',
        failed_action_seq: action.seq,
        tool: toolLabel,
        error: `Tool input schema could not be compiled: ${getErrorMessage(error)}`,
        input_schema: builtinTool.inputSchema,
        corrections,
      });
    }
    if (!validateArguments(action.args)) {
      return JSON.stringify({
        status: 'schema_or_execution_error',
        failed_action_seq: action.seq,
        tool: toolLabel,
        error: toolArgumentsValidator.errorsText(validateArguments.errors, {
          separator: '; ',
        }),
        input_schema: builtinTool.inputSchema,
        corrections,
        instruction: 'Retry with arguments that exactly match input_schema. No batch actions ran.',
      });
    }
    resolvedInterpreterTools.set(index, builtinTool);
  }

  const results: Array<{
    seq: number | null;
    tool: string;
    result: Record<string, unknown>;
    action_seqs?: Array<number | null>;
  }> = [];

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.kind === 'selected_target_action') {
      // Group consecutive selected-target actions into one reviewed batch so
      // a full form proposal stages a single review, matching the product
      // "one complete batch, one review" behavior.
      const group: AdvancedVoiceSelectedTargetAction[] = [action];
      while (
        index + 1 < actions.length
        && actions[index + 1].kind === 'selected_target_action'
      ) {
        index += 1;
        group.push(actions[index] as AdvancedVoiceSelectedTargetAction);
      }
      const groupLabel = group.length === 1
        ? `selected-target/${group[0].tool.name}`
        : `selected-target/batch[${group.map((entry) => entry.tool.name).join(',')}]`;

      try {
        const usedSeqs = new Set(
          group
            .map((entry) => entry.seq)
            .filter((seq): seq is number => typeof seq === 'number'),
        );
        let nextFallbackSeq = 1;
        const result = await input.callSelectedTargetBatch!({
          actions: group.map((entry) => {
            let seq = entry.seq;
            if (seq === null) {
              while (usedSeqs.has(nextFallbackSeq)) {
                nextFallbackSeq += 1;
              }
              seq = nextFallbackSeq;
              usedSeqs.add(seq);
            }
            return { seq, tool: entry.tool };
          }),
        });
        results.push({
          seq: group[0].seq,
          tool: groupLabel,
          ...(group.length > 1 ? { action_seqs: group.map((entry) => entry.seq) } : {}),
          result: JSON.parse(formatToolCallResponseForComputerBatch(result)) as Record<string, unknown>,
        });
        continue;
      } catch (error) {
        if (error instanceof OverlayInvalidBatchActionError) {
          // Staged actions were rejected by validation before anything
          // executed. Report an explicit invalid-action status so the model
          // corrects the batch immediately instead of reading a completed
          // batch with no observed change.
          return JSON.stringify({
            status: 'invalid_action_target',
            failed_action_seq: group[0].seq,
            tool: groupLabel,
            error: getErrorMessage(error),
            corrections,
            instruction: 'The staged batch was rejected before execution; no actions ran. Fix the rejected action so its params match the action schema and use element ids from the current selected context, then resubmit the full corrected batch.',
          });
        }
        return JSON.stringify({
          status: 'schema_or_execution_error',
          failed_action_seq: group[0].seq,
          tool: groupLabel,
          error: getErrorMessage(error),
          corrections,
          instruction: 'Retry with a selected-target action shaped as { seq, tool: { name, params } }. Do not reuse the failed shape.',
        });
      }
    }

    const toolLabel = `${action.serverId}/${action.toolName}`;
    const builtinTool = resolvedInterpreterTools.get(index)!;

    try {
      const result = await input.callTool(action.serverId, action.toolName, action.args);
      results.push({
        seq: action.seq,
        tool: toolLabel,
        result: JSON.parse(formatToolCallResponseForComputerBatch(result)) as Record<string, unknown>,
      });
    } catch (error) {
      return JSON.stringify({
        status: 'schema_or_execution_error',
        failed_action_seq: action.seq,
        tool: toolLabel,
        error: getErrorMessage(error),
        input_schema: builtinTool.inputSchema,
        corrections,
        instruction: 'Retry with arguments that exactly match input_schema. Do not reuse the failed shape.',
      });
    }
  }

  return JSON.stringify({
    status: 'completed',
    corrections,
    action_count: actions.length,
    results,
  });
}
